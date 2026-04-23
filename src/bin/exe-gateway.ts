#!/usr/bin/env node
/**
 * exe-os gateway — CLI entry point for the webhook server + gateway.
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
import type { GatewayPlatform, PlatformConfig } from "../types.js";

const CONFIG_DIR = path.join(os.homedir(), ".exe-os");
const CONFIG_PATH = path.join(CONFIG_DIR, "gateway.json");
const DEFAULT_PORT = 3100;

interface GatewayJsonConfig {
  port?: number;
  host?: string;
  authToken?: string;
  whatsappVerifyToken?: string;
  adapters?: Record<string, { enabled?: boolean; credentials?: Record<string, string> }>;
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
  // VPS image hard license gate — refuse to boot in production without a
  // valid license key. No-op in dev / CI / laptop use. Audit 2026-04-16 §2b.
  try {
    const { assertVpsLicense } = await import("../lib/license.js");
    const license = await assertVpsLicense();
    if (process.env.NODE_ENV === "production") {
      console.log(`[exe-gateway] License: plan=${license.plan}`);
    }
  } catch (err) {
    console.error(`[exe-gateway] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const config = loadConfig();
  const port = config.port ?? DEFAULT_PORT;

  const server = new WebhookServer({
    port,
    host: config.host,
    authToken: config.authToken,
    whatsappVerifyToken: config.whatsappVerifyToken,
  });

  // Build Gateway orchestrator (message routing, bot processing, responses)
  const platformConfigs = new Map<GatewayPlatform, PlatformConfig>();
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

  if (adapters.whatsapp?.enabled) {
    const { WhatsAppAdapter } = await import("../gateway/adapters/whatsapp.js");
    const wa = new WhatsAppAdapter();
    server.onPlatform("whatsapp", (body) => wa.injectMessage(body));
    gateway.registerAdapter(wa);
    platformConfigs.set("whatsapp", {
      platform: "whatsapp",
      permissions: { canRead: true, canWrite: true, canExecute: false },
      credentials: adapters.whatsapp.credentials ?? {},
    });
    console.log("[exe-gateway] WhatsApp adapter registered");
  }

  if (adapters.telegram?.enabled) {
    const { TelegramAdapter } = await import("../gateway/adapters/telegram.js");
    const telegram = new TelegramAdapter();
    server.onPlatform("telegram", (body) => telegram.injectMessage(body));
    gateway.registerAdapter(telegram);
    platformConfigs.set("telegram", {
      platform: "telegram",
      permissions: { canRead: true, canWrite: true, canExecute: false },
      credentials: adapters.telegram.credentials ?? {},
    });
    console.log("[exe-gateway] Telegram adapter registered");
  }

  if (adapters.discord?.enabled) {
    const { DiscordAdapter } = await import("../gateway/adapters/discord.js");
    const discord = new DiscordAdapter();
    server.onPlatform("discord", (body) => discord.injectMessage(body));
    gateway.registerAdapter(discord);
    platformConfigs.set("discord", {
      platform: "discord",
      permissions: { canRead: true, canWrite: true, canExecute: false },
      credentials: adapters.discord.credentials ?? {},
    });
    console.log("[exe-gateway] Discord adapter registered");
  }

  if (adapters.slack?.enabled) {
    const { SlackAdapter } = await import("../gateway/adapters/slack.js");
    const slack = new SlackAdapter();
    server.onPlatform("slack", (body) => slack.injectMessage(body));
    gateway.registerAdapter(slack);
    platformConfigs.set("slack", {
      platform: "slack",
      permissions: { canRead: true, canWrite: true, canExecute: false },
      credentials: adapters.slack.credentials ?? {},
    });
    console.log("[exe-gateway] Slack adapter registered");
  }

  if (adapters.imessage?.enabled) {
    const { IMessageAdapter } = await import("../gateway/adapters/imessage.js");
    const imessage = new IMessageAdapter();
    server.onPlatform("imessage", (body) => imessage.injectMessage(body));
    gateway.registerAdapter(imessage);
    platformConfigs.set("imessage", {
      platform: "imessage",
      permissions: { canRead: true, canWrite: true, canExecute: true },
      credentials: adapters.imessage.credentials ?? {},
    });
    console.log("[exe-gateway] iMessage adapter registered");
  }

  if (adapters.email?.enabled) {
    const { EmailAdapter } = await import("../gateway/adapters/email.js");
    const email = new EmailAdapter();
    server.onPlatform("email", (body) => email.injectMessage(body));
    gateway.registerAdapter(email);
    platformConfigs.set("email", {
      platform: "email",
      permissions: { canRead: true, canWrite: true, canExecute: false },
      credentials: adapters.email.credentials ?? {},
    });
    console.log("[exe-gateway] Email adapter registered");
  }

  if (adapters.webhook?.enabled) {
    const { WebhookAdapter } = await import("../gateway/adapters/webhook.js");
    const webhook = new WebhookAdapter();
    server.onPlatform("generic", (body) => webhook.injectMessage(body));
    gateway.registerAdapter(webhook);
    platformConfigs.set("webhook", {
      platform: "webhook",
      permissions: { canRead: true, canWrite: false, canExecute: false },
      credentials: adapters.webhook.credentials ?? {},
    });
    console.log("[exe-gateway] Generic webhook adapter registered");
  }

  // CRM webhook adapter — always enabled (trigger engine evaluates events)
  {
    const { createCRMWebhookHandler } = await import("../gateway/adapters/crm-webhook.js");
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
