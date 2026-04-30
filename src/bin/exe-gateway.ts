#!/usr/bin/env node
/**
 * exe-gateway — CLI entry point for the webhook server + gateway.
 *
 * Entry: `exe-os gateway` or `node dist/bin/exe-gateway.js`
 * Reads config from ~/.exe-os/gateway.json
 * Instantiates WebhookServer + Gateway + adapters
 * Handles SIGTERM/SIGINT gracefully
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebhookServer } from "../webhook-server.js";
import { Gateway } from "../gateway.js";
import { BotRegistry } from "../bot-registry.js";
import { getHooks } from "../hooks.js";
import { initPool, closePool } from "../db.js";
import { initConversationStore, storeMessage, upsertAccount, upsertContact } from "../conversation-store.js";
import { initAnalyticsStore } from "../analytics.js";
import { storeInboundMessage, setStorageFilter } from "../pipeline-store.js";
import type { PlatformConfig, NormalizedMessage } from "../types.js";

const CONFIG_DIR = path.join(os.homedir(), ".exe-os");
const CONFIG_PATH = path.join(CONFIG_DIR, "gateway.json");
const DEFAULT_PORT = 3100;

interface GatewayJsonConfig {
  port?: number;
  host?: string;
  authToken?: string;
  whatsappVerifyToken?: string;
  /**
   * Read-only ingestion mode. Receives and stores all messages but sends nothing.
   * No auto-reply, no typing indicators, no bot responses, no /api/send.
   * Use for background conversation monitoring — zero bot footprint.
   */
  readOnly?: boolean;
  database?: { host: string; port: number; user: string; password: string; database: string };
  storageFilter?: { enabled: boolean; allowGroups?: string[]; allowContacts?: string[] };
  /** LLM proxy configuration — enables POST /v1/messages */
  llmProxy?: {
    enabled: boolean;
    /** Master Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
    anthropicApiKey?: string;
    /** Margin percentage on top of cost (default 20) */
    marginPercent?: number;
  };
  autoReply?: {
    enabled: boolean;
    message?: string;
    allowGroups?: string[];
    allowContacts?: string[];
    cooldownHours?: number;
    dailyCap?: number;
    dmOnly?: boolean;
  };
  adapters?: Record<string, {
    enabled?: boolean;
    credentials?: Record<string, string>;
    /** Default SOCKS proxy for all accounts. Per-account `proxy` overrides this. */
    proxy?: string;
    accounts?: Array<{ name: string; authDir?: string; defaultAgent?: string; readOnly?: boolean; proxy?: string }>;
  }>;
}

function loadConfig(): GatewayJsonConfig {
  if (!existsSync(CONFIG_PATH)) {
    console.log(
      `[exe-gateway] No config at ${CONFIG_PATH} — using defaults (port ${DEFAULT_PORT})`,
    );
    return {};
  }

  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as GatewayJsonConfig;
  } catch (err) {
    console.error(
      `[exe-gateway] Failed to parse ${CONFIG_PATH}:`,
      err instanceof Error ? err.message : err,
    );
    return {};
  }
}

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

  const config = loadConfig();
  const port = config.port ?? DEFAULT_PORT;

  // Initialize PostgreSQL if database config is present
  let dbReady = false;
  if (config.database) {
    try {
      initPool(config.database);
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
    host: config.host,
    authToken: config.authToken,
    whatsappVerifyToken: config.whatsappVerifyToken,
  });

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
        path.join(os.homedir(), ".exe-os", ".auth", `whatsapp-${account.name}`);

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
        credentials: { ...accountCreds, ...(adapters.telegram.credentials ?? {}) },
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
        credentials: { ...accountCreds, ...(adapters.discord.credentials ?? {}) },
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
        credentials: { ...accountCreds, ...(adapters.slack.credentials ?? {}) },
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
        credentials: { ...accountCreds, ...(adapters.email.credentials ?? {}) },
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
    await server.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await server.start();
  console.log(`[exe-gateway] Ready on port ${port}`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[exe-gateway] Fatal: ${msg}`);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
