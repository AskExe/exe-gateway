#!/usr/bin/env node
/**
 * exe-gateway — CLI entry point for the webhook server + gateway.
 *
 * Entry: `exe-os gateway` or `node dist/bin/exe-gateway.js`
 * Reads config from EXE_GATEWAY_CONFIG or ~/.exe-os/gateway.json
 * Instantiates WebhookServer + Gateway + adapters
 * Handles SIGTERM/SIGINT gracefully
 */

import crypto from "node:crypto";
import { WebhookServer } from "../webhook-server.js";
import { Gateway } from "../gateway.js";
import { BotRegistry } from "../bot-registry.js";
import { getHooks, setHooks } from "../hooks.js";
import { initDatabase, disconnect } from "../db.js";
import { initConversationStore } from "../conversation-store.js";
import { initAnalyticsStore } from "../analytics.js";
import { setStorageFilter } from "../pipeline-store.js";
import type { PlatformConfig } from "../types.js";
import {
  DEFAULT_BIND_HOST,
  DEFAULT_PORT,
  getDefaultWhatsAppAuthDir,
  loadGatewayConfig,
  validateStartupConfig,
} from "../config.js";
import { WsRelay } from "../ws-relay.js";

async function main(): Promise<void> {
  // License gate — if a hook is injected, validate. Otherwise MIT mode (boot freely).
  const assertLicense = getHooks().assertLicense;
  if (assertLicense) {
    try {
      const license = await assertLicense();
      if (process.env.NODE_ENV === "production") {
        console.log(`[exe-gateway] License: plan=${license.plan}`);
      }
    } catch (err) {
      console.error(`[exe-gateway] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  const { config, configPath, stateDir } = loadGatewayConfig();
  const validation = validateStartupConfig(config);
  if (validation.errors.length > 0) {
    for (const error of validation.errors) {
      console.error(`[exe-gateway] Config error: ${error}`);
    }
    process.exit(1);
  }
  for (const warning of validation.warnings) {
    console.warn(`[exe-gateway] Config warning: ${warning}`);
  }

  const port = config.port ?? DEFAULT_PORT;
  const host = config.host ?? DEFAULT_BIND_HOST;
  console.log(`[exe-gateway] Config: ${configPath}`);
  console.log(`[exe-gateway] State dir: ${stateDir}`);

  // Initialize PostgreSQL if database config is present
  let dbReady = false;
  if (config.database) {
    try {
      initDatabase(config.database);
      await initConversationStore();
      await initAnalyticsStore();
      dbReady = true;
      console.log(`[exe-gateway] PostgreSQL connected (${config.database.host}:${config.database.port}/${config.database.database})`);
    } catch (err) {
      console.error(`[exe-gateway] PostgreSQL init failed:`, err instanceof Error ? err.message : err);
      console.warn(`[exe-gateway] \u26a0 PostgreSQL init failed — conversation read endpoints will return 503`);
    }
  } else {
    console.log(`[exe-gateway] No database config — running without conversation storage.`);
  }

  // Initialize LLM proxy tables + config if enabled
  if (config.llmProxy?.enabled && dbReady) {
    try {
      const { initApiKeysTable } = await import("../api-keys.js");
      const { initUsageTable } = await import("../metering.js");
      await initApiKeysTable();
      await initUsageTable();
      console.log("[exe-gateway] LLM proxy tables initialized");
    } catch (err) {
      console.error(
        "[exe-gateway] LLM proxy table init failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Apply storage filter if configured
  if (config.storageFilter) {
    setStorageFilter(config.storageFilter);
  }

  const server = new WebhookServer({
    port,
    host,
    authToken: config.authToken,
    whatsappVerifyToken: config.whatsappVerifyToken,
  });

  const wsRelay = buildWsRelay(config);
  if (wsRelay) {
    const existingHooks = getHooks();
    setHooks({
      ...existingHooks,
      onEvent: (event) => {
        existingHooks.onEvent?.(event);
        wsRelay.broadcast(
          event as unknown as Record<string, unknown> & { type: string },
        );
      },
    });
  }

  // Mark DB as available for conversation read endpoints
  if (dbReady) {
    server.setDbAvailable(true);
  }

  // Enable LLM proxy if configured
  if (config.llmProxy?.enabled) {
    const anthropicApiKey =
      config.llmProxy.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!anthropicApiKey) {
      console.error(
        "[exe-gateway] LLM proxy enabled but no Anthropic API key. " +
          "Set llmProxy.anthropicApiKey in gateway.json or ANTHROPIC_API_KEY env var.",
      );
    } else if (!dbReady) {
      console.error(
        "[exe-gateway] LLM proxy requires database for metering. " +
          "Configure database section in gateway.json.",
      );
    } else {
      server.setProxyConfig({
        anthropicApiKey,
        marginPercent: config.llmProxy.marginPercent ?? 20,
      });
    }
  }

  // Read-only mode gate — suppress all outbound at server + gateway level
  if (config.readOnly) {
    server.setReadOnly(true);
  }

  // Build Gateway orchestrator (message routing, bot processing, responses)
  const platformConfigs = new Map<string, PlatformConfig>();
  const botRegistry = new BotRegistry();

  const gateway = new Gateway({
    config: {
      routes: [],
      defaultRoute: "exe",
      defaultModelTier: "sonnet",
      defaultPermissions: { canRead: true, canWrite: false, canExecute: false },
    },
    platformConfigs,
    botRegistry,
    autoReply: config.autoReply,
    readOnly: config.readOnly,
  });

  // Register adapter handlers based on config
  const adapters = config.adapters ?? {};

  if (adapters.whatsapp?.enabled || adapters.whatsapp?.accounts?.length) {
    const { WhatsAppAdapter } = await import("../adapters/whatsapp.js");

    // Support both legacy single-account and new multi-account config
    const accounts = adapters.whatsapp.accounts ?? [{ name: "default" }];

    for (const account of accounts) {
      const authDir = account.authDir ??
        getDefaultWhatsAppAuthDir(account.name);

      // Per-account read-only: global readOnly overrides, otherwise check account-level flag
      const isReadOnly = config.readOnly || account.readOnly === true;

      // Proxy resolution: per-account → adapter-level → env var → none
      const proxy = account.proxy || adapters.whatsapp.proxy || "";

      const wa = new WhatsAppAdapter(account.name);
      server.onPlatform("whatsapp", (body) => wa.injectMessage(body));
      server.registerAdapter("whatsapp", wa);
      gateway.registerAdapter(wa);
      platformConfigs.set(`whatsapp:${account.name}` as any, {
        platform: "whatsapp",
        permissions: { canRead: true, canWrite: !isReadOnly, canExecute: false },
        credentials: { authDir, ...(proxy ? { proxy } : {}), ...(adapters.whatsapp.credentials ?? {}) },
      });
      const proxyLabel = proxy ? ` proxy=${new URL(proxy).hostname}` : "";
      console.log(`[exe-gateway] WhatsApp account "${account.name}" registered (${isReadOnly ? "read-only" : "read-write"}${proxyLabel})`);
    }
  }

  if (adapters.telegram?.enabled || adapters.telegram?.accounts?.length) {
    const { TelegramAdapter } = await import("../adapters/telegram.js");
    const accounts = adapters.telegram.accounts ?? [{ name: "default" }];
    for (const account of accounts) {
      const { readOnly: _ro, ...accountCreds } = account;
      const telegram = new TelegramAdapter(account.name);
      server.onPlatform("telegram", (body) => telegram.injectMessage(body));
      gateway.registerAdapter(telegram);
      platformConfigs.set(`telegram:${account.name}`, {
        platform: "telegram",
        permissions: { canRead: true, canWrite: true, canExecute: false },
        credentials: {
          ...toCredentialRecord(accountCreds),
          ...(adapters.telegram.credentials ?? {}),
        },
      });
      console.log(`[exe-gateway] Telegram account "${account.name}" registered`);
    }
  }

  if (adapters.discord?.enabled || adapters.discord?.accounts?.length) {
    const { DiscordAdapter } = await import("../adapters/discord.js");
    const accounts = adapters.discord.accounts ?? [{ name: "default" }];
    for (const account of accounts) {
      const { readOnly: _ro, ...accountCreds } = account;
      const discord = new DiscordAdapter(account.name);
      server.onPlatform("discord", (body) => discord.injectMessage(body));
      gateway.registerAdapter(discord);
      platformConfigs.set(`discord:${account.name}`, {
        platform: "discord",
        permissions: { canRead: true, canWrite: true, canExecute: false },
        credentials: {
          ...toCredentialRecord(accountCreds),
          ...(adapters.discord.credentials ?? {}),
        },
      });
      console.log(`[exe-gateway] Discord account "${account.name}" registered`);
    }
  }

  if (adapters.slack?.enabled || adapters.slack?.accounts?.length) {
    const { SlackAdapter } = await import("../adapters/slack.js");
    const accounts = adapters.slack.accounts ?? [{ name: "default" }];
    for (const account of accounts) {
      const { readOnly: _ro, ...accountCreds } = account;
      const slack = new SlackAdapter(account.name);
      server.onPlatform("slack", (body) => slack.injectMessage(body));
      gateway.registerAdapter(slack);
      platformConfigs.set(`slack:${account.name}`, {
        platform: "slack",
        permissions: { canRead: true, canWrite: true, canExecute: false },
        credentials: {
          ...toCredentialRecord(accountCreds),
          ...(adapters.slack.credentials ?? {}),
        },
      });
      console.log(`[exe-gateway] Slack account "${account.name}" registered`);
    }
  }

  if (adapters.imessage?.enabled) {
    const { IMessageAdapter } = await import("../adapters/imessage.js");
    const imessage = new IMessageAdapter();
    server.onPlatform("imessage", (body) => imessage.injectMessage(body));
    gateway.registerAdapter(imessage);
    platformConfigs.set("imessage:default", {
      platform: "imessage",
      permissions: { canRead: true, canWrite: true, canExecute: true },
      credentials: adapters.imessage.credentials ?? {},
    });
    console.log("[exe-gateway] iMessage adapter registered");
  }

  if (adapters.email?.enabled || adapters.email?.accounts?.length) {
    const { EmailAdapter } = await import("../adapters/email.js");
    const accounts = adapters.email.accounts ?? [{ name: "default" }];
    for (const account of accounts) {
      const { readOnly: _ro, ...accountCreds } = account;
      const email = new EmailAdapter(account.name);
      server.onPlatform("email", (body) => email.injectMessage(body));
      gateway.registerAdapter(email);
      platformConfigs.set(`email:${account.name}`, {
        platform: "email",
        permissions: { canRead: true, canWrite: true, canExecute: false },
        credentials: {
          ...toCredentialRecord(accountCreds),
          ...(adapters.email.credentials ?? {}),
        },
      });
      console.log(`[exe-gateway] Email account "${account.name}" registered`);
    }
  }

  if (adapters.webhook?.enabled) {
    const { WebhookAdapter } = await import("../adapters/webhook.js");
    const webhook = new WebhookAdapter();
    server.onPlatform("generic", (body) => webhook.injectMessage(body));
    gateway.registerAdapter(webhook);
    platformConfigs.set("webhook:default", {
      platform: "webhook",
      permissions: { canRead: true, canWrite: false, canExecute: false },
      credentials: adapters.webhook.credentials ?? {},
    });
    console.log("[exe-gateway] Generic webhook adapter registered");
  }

  // CRM webhook adapter — always enabled (trigger engine evaluates events)
  {
    const { createCRMWebhookHandler } = await import("../adapters/crm-webhook.js");
    const handler = createCRMWebhookHandler();
    server.onPlatform("crm", handler);
    console.log("[exe-gateway] CRM webhook adapter registered");
  }

  // Start Gateway orchestrator (connects adapters to their platforms)
  await gateway.start();

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[exe-gateway] Shutting down...");
    await gateway.stop();
    if (wsRelay) {
      await wsRelay.stop();
    }
    await server.stop();
    await disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await server.start();
  if (wsRelay) {
    await wsRelay.start();
  }
  console.log(`[exe-gateway] Ready on ${host}:${port}`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[exe-gateway] Fatal: ${msg}`);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});

function buildWsRelay(
  config: {
    authToken?: string;
    wsRelay?: {
      enabled?: boolean;
      host?: string;
      port?: number;
      authToken?: string;
    };
  },
): WsRelay | null {
  if (!config.wsRelay?.enabled) return null;

  const authToken = config.wsRelay.authToken;
  if (!authToken) {
    throw new Error("wsRelay.enabled=true requires wsRelay.authToken.");
  }

  const tokenBuffer = Buffer.from(authToken, "hex");
  const authTokenHash = crypto.createHash("sha256").update(tokenBuffer).digest("hex");

  return new WsRelay({
    port: config.wsRelay.port ?? 3101,
    host: config.wsRelay.host ?? DEFAULT_BIND_HOST,
    authTokenHash,
  });
}

function toCredentialRecord(
  record: Record<string, string | boolean | undefined>,
): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      credentials[key] = value;
    }
  }
  return credentials;
}
