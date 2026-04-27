/**
 * Telegram adapter — grammy Bot API (long polling).
 *
 * Uses grammy for Telegram Bot API. Events arrive via long polling.
 * Requires a bot token from @BotFather.
 *
 * Config credentials:
 *   bot_token: Telegram bot token from BotFather
 */

import type {
  NormalizedMessage,
  PlatformAdapter,
  PlatformConfig,
  SendOptions,
} from "../types.js";

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = "telegram" as const;
  readonly accountName: string;

  private bot: any = null; // Grammy Bot instance — dynamic import
  private messageHandler: ((msg: NormalizedMessage) => Promise<void>) | null = null;
  private connected = false;

  constructor(accountName = "default") {
    this.accountName = accountName;
  }

  async connect(config: PlatformConfig): Promise<void> {
    const botToken = config.credentials.bot_token;
    if (!botToken) {
      throw new Error("Telegram requires bot_token in credentials");
    }

    const { Bot } = await import("grammy");
    this.bot = new Bot(botToken);

    // Register message handler
    this.bot.on("message", async (ctx: any) => {
      if (!this.messageHandler) return;

      const msg = ctx.message;
      if (!msg?.chat) return;

      const text = msg.text ?? msg.caption ?? "";
      const chat = msg.chat;
      const isGroup = chat.type === "group" || chat.type === "supergroup";
      const senderId = String(msg.from?.id ?? "");

      const media = this.extractMedia(msg);

      const normalized: NormalizedMessage = {
        messageId: String(msg.message_id),
        platform: "telegram",
        senderId,
        senderName: [msg.from?.first_name, msg.from?.last_name]
          .filter(Boolean)
          .join(" ") || undefined,
        channelId: String(chat.id),
        chatType: isGroup ? "group" : "direct",
        text,
        timestamp: new Date((msg.date ?? 0) * 1000).toISOString(),
        media,
        replyTo: msg.reply_to_message
          ? {
              messageId: String(msg.reply_to_message.message_id),
              text: msg.reply_to_message.text ?? "",
              senderId: String(msg.reply_to_message.from?.id ?? ""),
            }
          : undefined,
        threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
        raw: msg,
      };

      try {
        await this.messageHandler(normalized);
      } catch (err) {
        console.error(`[telegram:${this.accountName}] Message handler error:`, err);
      }
    });

    // Start long polling
    this.bot.start({
      onStart: () => {
        this.connected = true;
        console.log(`[telegram:${this.accountName}] Connected via grammy (long polling)`);
      },
    });
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
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
    if (!this.bot || !this.connected) throw new Error("Telegram not connected");

    await this.bot.api.sendMessage(channelId, text, {
      ...(options?.replyToMessageId
        ? { reply_to_message_id: Number(options.replyToMessageId) }
        : {}),
    });
  }

  async sendTyping(channelId: string): Promise<void> {
    if (!this.bot || !this.connected) return;
    try {
      await this.bot.api.sendChatAction(channelId, "typing");
    } catch {
      // best-effort
    }
  }

  async healthCheck(): Promise<{ connected: boolean; latencyMs?: number }> {
    if (!this.bot) return { connected: false };

    const start = Date.now();
    try {
      await this.bot.api.getMe();
      return { connected: true, latencyMs: Date.now() - start };
    } catch {
      return { connected: false };
    }
  }

  /** Inject a raw webhook payload (Telegram Update object) */
  async injectMessage(rawPayload: unknown): Promise<void> {
    if (!this.messageHandler) return;

    const update = rawPayload as any;
    const msg = update.message ?? update.edited_message;
    if (!msg?.chat) return;

    const text = msg.text ?? msg.caption ?? "";
    const chat = msg.chat;
    const isGroup = chat.type === "group" || chat.type === "supergroup";
    const senderId = String(msg.from?.id ?? "");

    const media = this.extractMedia(msg);

    const normalized: NormalizedMessage = {
      messageId: String(msg.message_id),
      platform: "telegram",
      senderId,
      senderName: [msg.from?.first_name, msg.from?.last_name]
        .filter(Boolean)
        .join(" ") || undefined,
      channelId: String(chat.id),
      chatType: isGroup ? "group" : "direct",
      text,
      timestamp: new Date((msg.date ?? 0) * 1000).toISOString(),
      media,
      replyTo: msg.reply_to_message
        ? {
            messageId: String(msg.reply_to_message.message_id),
            text: msg.reply_to_message.text ?? "",
            senderId: String(msg.reply_to_message.from?.id ?? ""),
          }
        : undefined,
      threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
      raw: rawPayload,
    };

    try {
      await this.messageHandler(normalized);
    } catch (err) {
      console.error(`[telegram:${this.accountName}] injectMessage handler error:`, err);
    }
  }

  private extractMedia(msg: any): NormalizedMessage["media"] {
    const media: NonNullable<NormalizedMessage["media"]> = [];

    if (msg.photo?.length) {
      media.push({ type: "image", fileName: "photo.jpg" });
    }
    if (msg.video) {
      media.push({ type: "video", fileName: msg.video.file_name ?? "video.mp4" });
    }
    if (msg.audio) {
      media.push({ type: "audio", fileName: msg.audio.file_name ?? "audio.mp3" });
    }
    if (msg.voice) {
      media.push({ type: "audio", fileName: "voice.ogg" });
    }
    if (msg.document) {
      media.push({
        type: "document",
        fileName: msg.document.file_name ?? "document",
      });
    }

    return media.length > 0 ? media : undefined;
  }
}
