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
  database?: { host: string; port: number; user: string; password: string; database: string };
  storageFilter?: { enabled: boolean; allowGroups?: string[]; allowContacts?: string[] };
  adapters?: Record<string, {
    enabled?: boolean;
    credentials?: Record<string, string>;
    accounts?: Array<{ name: string; authDir?: string; defaultAgent?: string }>;
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
  if (config.database) {
    try {
      initPool(config.database);
      await initConversationStore();
      console.log(`[exe-gateway] PostgreSQL connected (${config.database.host}:${config.database.port}/${config.database.database})`);
    } catch (err) {
      console.error(`[exe-gateway] PostgreSQL init failed:`, err instanceof Error ? err.message : err);
      console.error(`[exe-gateway] Continuing without conversation storage.`);
    }
  } else {
    console.log(`[exe-gateway] No database config — running without conversation storage.`);
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

      const wa = new WhatsAppAdapter(account.name);
      server.onPlatform("whatsapp", (body) => wa.injectMessage(body));
      server.registerAdapter("whatsapp", wa);
      gateway.registerAdapter(wa);
      platformConfigs.set(`whatsapp:${account.name}` as any, {
        platform: "whatsapp",
        permissions: { canRead: true, canWrite: true, canExecute: false },
        credentials: { authDir, ...(adapters.whatsapp.credentials ?? {}) },
      });
      console.log(`[exe-gateway] WhatsApp account "${account.name}" registered`);
    }
  }

  if (adapters.telegram?.enabled || adapters.telegram?.accounts?.length) {
    const { TelegramAdapter } = await import("../adapters/telegram.js");
    const accounts = adapters.telegram.accounts ?? [{ name: "default" }];
    for (const account of accounts) {
      const telegram = new TelegramAdapter(account.name);
      server.onPlatform("telegram", (body) => telegram.injectMessage(body));
      gateway.registerAdapter(telegram);
      platformConfigs.set(`telegram:${account.name}`, {
        platform: "telegram",
        permissions: { canRead: true, canWrite: true, canExecute: false },
        credentials: { ...account, ...(adapters.telegram.credentials ?? {}) },
      });
      console.log(`[exe-gateway] Telegram account "${account.name}" registered`);
    }
  }

  if (adapters.discord?.enabled || adapters.discord?.accounts?.length) {
    const { DiscordAdapter } = await import("../adapters/discord.js");
    const accounts = adapters.discord.accounts ?? [{ name: "default" }];
    for (const account of accounts) {
      const discord = new DiscordAdapter(account.name);
      server.onPlatform("discord", (body) => discord.injectMessage(body));
      gateway.registerAdapter(discord);
      platformConfigs.set(`discord:${account.name}`, {
        platform: "discord",
        permissions: { canRead: true, canWrite: true, canExecute: false },
        credentials: { ...account, ...(adapters.discord.credentials ?? {}) },
      });
      console.log(`[exe-gateway] Discord account "${account.name}" registered`);
    }
  }

  if (adapters.slack?.enabled || adapters.slack?.accounts?.length) {
    const { SlackAdapter } = await import("../adapters/slack.js");
    const accounts = adapters.slack.accounts ?? [{ name: "default" }];
    for (const account of accounts) {
      const slack = new SlackAdapter(account.name);
      server.onPlatform("slack", (body) => slack.injectMessage(body));
      gateway.registerAdapter(slack);
      platformConfigs.set(`slack:${account.name}`, {
        platform: "slack",
        permissions: { canRead: true, canWrite: true, canExecute: false },
        credentials: { ...account, ...(adapters.slack.credentials ?? {}) },
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
      const email = new EmailAdapter(account.name);
      server.onPlatform("email", (body) => email.injectMessage(body));
      gateway.registerAdapter(email);
      platformConfigs.set(`email:${account.name}`, {
        platform: "email",
        permissions: { canRead: true, canWrite: true, canExecute: false },
        credentials: { ...account, ...(adapters.email.credentials ?? {}) },
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
