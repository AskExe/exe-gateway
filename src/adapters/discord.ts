/**
 * Discord adapter — discord.js bot integration.
 *
 * Uses discord.js with bot token. Handles messages across servers/channels.
 * Requires bot_token in credentials and appropriate gateway intents enabled.
 *
 * Reference: ~/openclaw/extensions/discord/
 */

import type {
  NormalizedMessage,
  PlatformAdapter,
  PlatformConfig,
  SendOptions,
} from "../types.js";

/** Minimal discord.js Client shape (dynamic import — no compile-time dep) */
interface DiscordClient {
  on(event: string, handler: (...args: unknown[]) => void): void;
  login(token: string): Promise<string>;
  destroy(): Promise<void>;
  channels: { fetch(id: string): Promise<DiscordChannel | null> };
  user?: { tag: string };
  ws?: { ping: number };
}

interface DiscordChannel {
  send(options: Record<string, unknown>): Promise<unknown>;
  sendTyping(): Promise<void>;
}

/** discord.js Message shape — fields we actually read */
interface DiscordMessage {
  id: string;
  author: { id: string; username: string; bot: boolean };
  guild: unknown | null;
  content: string | null;
  createdAt: Date;
  channelId: string;
  thread?: { id: string };
  channel: { isThread?(): boolean };
  reference?: { messageId?: string };
  attachments: Map<string, { contentType?: string; url: string; name?: string }>;
}

/** Raw Discord webhook payload shape */
interface DiscordWebhookPayload {
  id?: string;
  author?: { id: string; username?: string; bot?: boolean };
  guild_id?: string;
  channel_id?: string;
  content?: string;
  timestamp?: string;
}

export class DiscordAdapter implements PlatformAdapter {
  readonly platform = "discord" as const;
  readonly accountName: string;

  private client: DiscordClient | null = null;
  private messageHandler: ((msg: NormalizedMessage) => Promise<void>) | null = null;
  private connected = false;

  constructor(accountName = "default") {
    this.accountName = accountName;
  }

  async connect(config: PlatformConfig): Promise<void> {
    const { Client, GatewayIntentBits } = await import("discord.js");

    const token = config.credentials.bot_token ?? config.credentials.token;
    if (!token) {
      throw new Error("Discord requires bot_token in credentials");
    }

    const discordClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });
    this.client = discordClient as unknown as DiscordClient;

    discordClient.on("ready", () => {
      this.connected = true;
      console.log(`[discord:${this.accountName}] Connected as ${this.client?.user?.tag}`);
    });

    discordClient.on("messageCreate", async (msg: unknown) => {
      const m = msg as DiscordMessage;
      if (!this.messageHandler) return;
      if (m.author.bot) return;

      const isGroup = m.guild !== null;
      const media = this.extractMedia(m);

      const normalized: NormalizedMessage = {
        messageId: m.id,
        platform: "discord",
        senderId: m.author.id,
        senderName: m.author.username,
        channelId: m.channelId,
        chatType: isGroup ? "group" : "direct",
        text: m.content ?? "",
        timestamp: m.createdAt.toISOString(),
        threadId: m.thread?.id ?? (m.channel.isThread?.() ? m.channelId : undefined),
        replyTo: m.reference
          ? {
              messageId: m.reference.messageId ?? "",
              text: "",
              senderId: "",
            }
          : undefined,
        media,
        raw: m,
      };

      try {
        await this.messageHandler(normalized);
      } catch (err) {
        console.error(`[discord:${this.accountName}] Message handler error:`, err);
      }
    });

    await discordClient.login(token);
  }

  async disconnect(): Promise<void> {
    await this.client?.destroy();
    this.client = null;
    this.connected = false;
  }

  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async sendText(
    channelId: string,
    text: string,
    options?: SendOptions,
  ): Promise<void> {
    if (!this.client || !this.connected) throw new Error("Discord not connected");

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.send) {
      throw new Error(`Discord channel ${channelId} not found or not text-based`);
    }

    await channel.send({
      content: text,
      ...(options?.replyToMessageId
        ? { reply: { messageReference: options.replyToMessageId } }
        : {}),
    });
  }

  async sendTyping(channelId: string): Promise<void> {
    if (!this.client || !this.connected) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.sendTyping) {
        await channel.sendTyping();
      }
    } catch {
      // best-effort
    }
  }

  async healthCheck(): Promise<{ connected: boolean; latencyMs?: number }> {
    if (!this.client) return { connected: false };
    return {
      connected: this.connected,
      latencyMs: (this.client.ws?.ping ?? -1) >= 0 ? this.client.ws!.ping : undefined,
    };
  }

  /** Inject a raw Discord message payload from webhook server */
  async injectMessage(rawPayload: unknown): Promise<void> {
    if (!this.messageHandler) return;

    const msg = rawPayload as DiscordWebhookPayload;
    if (!msg.id || msg.author?.bot) return;

    const isGroup = !!msg.guild_id;

    const normalized: NormalizedMessage = {
      messageId: msg.id,
      platform: "discord",
      senderId: msg.author?.id ?? "",
      senderName: msg.author?.username,
      channelId: msg.channel_id ?? "",
      chatType: isGroup ? "group" : "direct",
      text: msg.content ?? "",
      timestamp: msg.timestamp
        ? new Date(msg.timestamp).toISOString()
        : new Date().toISOString(),
      raw: rawPayload,
    };

    try {
      await this.messageHandler(normalized);
    } catch (err) {
      console.error(`[discord:${this.accountName}] injectMessage handler error:`, err);
    }
  }

  private extractMedia(msg: DiscordMessage): NormalizedMessage["media"] {
    if (!msg.attachments?.size) return undefined;

    const media: NonNullable<NormalizedMessage["media"]> = [];
    for (const [, att] of msg.attachments) {
      const ct = att.contentType ?? "";
      let type: "image" | "video" | "audio" | "document" = "document";
      if (ct.startsWith("image/")) type = "image";
      else if (ct.startsWith("video/")) type = "video";
      else if (ct.startsWith("audio/")) type = "audio";
      media.push({ type, url: att.url, fileName: att.name ?? undefined });
    }

    return media.length > 0 ? media : undefined;
  }
}
