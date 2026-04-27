/**
 * Slack adapter — @slack/web-api + Socket Mode for real-time events.
 *
 * Uses bot token (xoxb-) + app-level token (xapp-) for Socket Mode.
 * Direct message and channel support.
 *
 * Reference: ~/openclaw/extensions/slack/
 */

import { randomUUID } from "node:crypto";
import type {
  NormalizedMessage,
  PlatformAdapter,
  PlatformConfig,
  SendOptions,
} from "../types.js";

export class SlackAdapter implements PlatformAdapter {
  readonly platform = "slack" as const;
  readonly accountName: string;

  private webClient: any = null; // WebClient — dynamic import
  private socketClient: any = null; // SocketModeClient — dynamic import
  private messageHandler: ((msg: NormalizedMessage) => Promise<void>) | null = null;
  private connected = false;
  private botUserId = "";

  constructor(accountName = "default") {
    this.accountName = accountName;
  }

  async connect(config: PlatformConfig): Promise<void> {
    const { WebClient } = await import("@slack/web-api");
    const { SocketModeClient } = await import("@slack/socket-mode");

    const token = config.credentials.bot_token ?? config.credentials.token;
    const appToken = config.credentials.app_token;

    if (!token) {
      throw new Error("Slack requires bot_token (xoxb-) in credentials");
    }
    if (!appToken) {
      throw new Error("Slack requires app_token (xapp-) for Socket Mode in credentials");
    }

    this.webClient = new WebClient(token);
    this.socketClient = new SocketModeClient({ appToken });

    // Get bot user ID to filter own messages
    try {
      const auth = await this.webClient.auth.test();
      this.botUserId = auth.user_id ?? "";
    } catch (err) {
      throw new Error(
        `Slack auth failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Handle incoming messages
    this.socketClient.on("message", async ({ event, ack }: any) => {
      await ack();
      if (!this.messageHandler || !event) return;

      // Skip bot's own messages and subtypes (edits, deletes)
      if (event.user === this.botUserId) return;
      if (event.subtype) return;

      const isGroup = event.channel_type !== "im";

      const normalized: NormalizedMessage = {
        messageId: event.client_msg_id ?? event.ts ?? randomUUID(),
        platform: "slack",
        senderId: event.user ?? "",
        channelId: event.channel ?? "",
        chatType: isGroup ? "group" : "direct",
        text: event.text ?? "",
        timestamp: event.ts
          ? new Date(parseFloat(event.ts) * 1000).toISOString()
          : new Date().toISOString(),
        threadId: event.thread_ts ?? undefined,
        replyTo: event.thread_ts && event.thread_ts !== event.ts
          ? {
              messageId: event.thread_ts,
              text: "",
              senderId: "",
            }
          : undefined,
        media: this.extractMedia(event),
        raw: event,
      };

      try {
        await this.messageHandler(normalized);
      } catch (err) {
        console.error(`[slack:${this.accountName}] Message handler error:`, err);
      }
    });

    await this.socketClient.start();
    this.connected = true;
    console.log(`[slack:${this.accountName}] Connected via Socket Mode`);
  }

  async disconnect(): Promise<void> {
    await this.socketClient?.disconnect();
    this.socketClient = null;
    this.webClient = null;
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
    if (!this.webClient || !this.connected) throw new Error("Slack not connected");

    await this.webClient.chat.postMessage({
      channel: channelId,
      text,
      thread_ts: options?.replyToMessageId,
    });
  }

  async sendTyping(_channelId: string): Promise<void> {
    // Slack doesn't have a typing indicator API for bots
  }

  async healthCheck(): Promise<{ connected: boolean; latencyMs?: number }> {
    if (!this.webClient) return { connected: false };

    const start = Date.now();
    try {
      await this.webClient.auth.test();
      return { connected: true, latencyMs: Date.now() - start };
    } catch {
      return { connected: false };
    }
  }

  /** Inject a raw Slack event payload from webhook server */
  async injectMessage(rawPayload: unknown): Promise<void> {
    if (!this.messageHandler) return;

    const event = rawPayload as {
      type?: string; text?: string; user?: string; channel?: string;
      ts?: string; thread_ts?: string; channel_type?: string;
      files?: Array<{ mimetype?: string; name?: string; url_private?: string }>;
      user_profile?: { real_name?: string; display_name?: string };
    };

    if (!event.text) return;

    const isGroup = event.channel_type !== "im";

    const normalized: NormalizedMessage = {
      messageId: event.ts ?? randomUUID(),
      platform: "slack",
      senderId: event.user ?? "",
      senderName: event.user_profile?.display_name ?? event.user_profile?.real_name ?? undefined,
      channelId: event.channel ?? "",
      chatType: isGroup ? "group" : "direct",
      text: event.text,
      timestamp: event.ts
        ? new Date(parseFloat(event.ts) * 1000).toISOString()
        : new Date().toISOString(),
      threadId: event.thread_ts ?? undefined,
      media: this.extractMedia(event),
      raw: rawPayload,
    };

    try {
      await this.messageHandler(normalized);
    } catch (err) {
      console.error(`[slack:${this.accountName}] injectMessage handler error:`, err);
    }
  }

  private extractMedia(event: any): NormalizedMessage["media"] {
    const files = event.files;
    if (!files || !Array.isArray(files) || files.length === 0) return undefined;

    return files.map((f: any) => {
      const mimetype = f.mimetype ?? "";
      let type: "image" | "video" | "audio" | "document" = "document";
      if (mimetype.startsWith("image/")) type = "image";
      else if (mimetype.startsWith("video/")) type = "video";
      else if (mimetype.startsWith("audio/")) type = "audio";
      return {
        type,
        url: f.url_private ?? undefined,
        fileName: f.name ?? undefined,
      };
    });
  }
}
