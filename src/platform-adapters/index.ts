/**
 * Gateway adapters — unified interface for all messaging platforms
 *
 * Exports all adapters and factory for creating instances
 *
 * @module adapters
 */

export { WhatsAppBaileysAdapter, type BaileysConfig } from "./whatsapp-baileys.js";
export { TelegramGrammyAdapter, type GrammyConfig } from "./telegram-grammy.js";
export { DiscordCarbonAdapter, type CarbonConfig } from "./discord-carbon.js";
export { SlackBoltAdapter, type BoltConfig } from "./slack-bolt.js";
export { IMessageNativeAdapter, type IMessageConfig } from "./imessage-native.js";

import type { GatewayAdapter } from "../gateway-adapter-types.js";
import { WhatsAppBaileysAdapter } from "./whatsapp-baileys.js";
import { TelegramGrammyAdapter } from "./telegram-grammy.js";
import { DiscordCarbonAdapter } from "./discord-carbon.js";
import { SlackBoltAdapter } from "./slack-bolt.js";
import { IMessageNativeAdapter } from "./imessage-native.js";

export interface AdapterFactoryConfig {
  platform: "whatsapp" | "telegram" | "discord" | "slack" | "imessage";
  config: Record<string, unknown>;
}

/**
 * Create a gateway adapter for the specified platform
 */
export async function createAdapter(opts: AdapterFactoryConfig): Promise<GatewayAdapter> {
  switch (opts.platform) {
    case "whatsapp":
      return new WhatsAppBaileysAdapter(opts.config as any);
    case "telegram":
      return new TelegramGrammyAdapter(opts.config as any);
    case "discord":
      return new DiscordCarbonAdapter(opts.config as any);
    case "slack":
      return new SlackBoltAdapter(opts.config as any);
    case "imessage":
      return new IMessageNativeAdapter(opts.config as any);
    default:
      throw new Error(`Unknown platform: ${opts.platform}`);
  }
}

/**
 * Registry of all available adapters
 */
export const AVAILABLE_ADAPTERS = {
  whatsapp: { name: "WhatsApp (Baileys)", adapter: WhatsAppBaileysAdapter },
  telegram: { name: "Telegram (Grammy)", adapter: TelegramGrammyAdapter },
  discord: { name: "Discord (@buape/carbon)", adapter: DiscordCarbonAdapter },
  slack: { name: "Slack (@slack/bolt)", adapter: SlackBoltAdapter },
  imessage: { name: "iMessage (Native)", adapter: IMessageNativeAdapter },
} as const;
