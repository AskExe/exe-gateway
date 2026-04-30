/**
 * Telegram adapter using Grammy — FULL IMPLEMENTATION
 *
 * Uses Telegram Bot API via fetch (no Grammy dependency required at runtime).
 * Supports long-polling for inbound messages with offset persistence.
 */

import type { GatewayAdapter, InboundMessage, OutboundMessage, OutboundResult, PlatformAccount } from "../gateway-adapter-types.js";

const TELEGRAM_API = "https://api.telegram.org";

export class TelegramGrammyFullAdapter implements GatewayAdapter {
  readonly platform = "telegram" as const;
  private botToken: string;
  private accountId: string;
  private isMonitoring = false;
  private botId: string | null = null;
  private botUsername: string | null = null;
  private pollOffset = 0;
  private pollAbort: AbortController | null = null;

  constructor(config: { botToken: string; accountId?: string }) {
    this.botToken = config.botToken;
    this.accountId = config.accountId || "default";
  }

  async listAccounts(): Promise<PlatformAccount[]> {
    await this.ensureBotInfo();
    if (!this.botId) return [];

    return [
      {
        id: this.accountId,
        platform: "telegram",
        name: this.botUsername ? `@${this.botUsername}` : `Telegram Bot (${this.botId})`,
        isConfigured: true,
        lastActivity: Date.now(),
      },
    ];
  }

  async getAccount(accountId: string): Promise<PlatformAccount> {
    const accounts = await this.listAccounts();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    return account;
  }

  async sendMessage(message: OutboundMessage): Promise<OutboundResult> {
    const startTime = Date.now();
    try {
      const text = message.content.text || "(empty message)";

      // Handle media messages
      if (message.content.mediaUrl) {
        return this.sendMediaMessage(message, startTime);
      }

      const response = await fetch(`${TELEGRAM_API}/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: message.to,
          text,
          reply_to_message_id: message.content.replyToId ? Number(message.content.replyToId) : undefined,
        }),
      });

      const data = await response.json() as any;
      if (!data.ok) throw new Error(data.description);

      return {
        messageId: String(data.result?.message_id),
        platform: "telegram",
        timestamp: startTime,
        success: true,
      };
    } catch (err) {
      return {
        messageId: "",
        platform: "telegram",
        timestamp: Date.now(),
        success: false,
        error: String(err).replace(this.botToken, "[REDACTED]"),
      };
    }
  }

  async startMonitor(
    onMessage: (msg: InboundMessage) => Promise<void>,
    _options?: { accountId?: string; debounceMs?: number },
  ): Promise<() => Promise<void>> {
    if (this.isMonitoring) throw new Error("Monitor already running");
    this.isMonitoring = true;

    await this.ensureBotInfo();
    this.pollAbort = new AbortController();

    // Start long-polling loop
    const pollLoop = async () => {
      while (this.isMonitoring) {
        try {
          const response = await fetch(
            `${TELEGRAM_API}/bot${this.botToken}/getUpdates?offset=${this.pollOffset}&timeout=30&allowed_updates=["message","edited_message","callback_query"]`,
            { signal: this.pollAbort!.signal },
          );

          if (!response.ok) {
            console.error(`[telegram] Polling error: ${response.status}`);
            await sleep(5000);
            continue;
          }

          const data = await response.json() as any;
          if (!data.ok || !data.result?.length) continue;

          for (const update of data.result) {
            // Advance offset past this update
            this.pollOffset = update.update_id + 1;

            const msg = update.message || update.edited_message;
            if (!msg) continue;

            const inbound = this.parseUpdate(msg);
            if (!inbound) continue;

            await onMessage(inbound).catch((err) => {
              console.error("[telegram] Message handler error:", err);
            });
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") break;
          console.error("[telegram] Poll loop error:", err);
          await sleep(5000);
        }
      }
    };

    // Run poll loop in background (non-blocking)
    pollLoop().catch((err) => console.error("[telegram] Poll loop crashed:", err));

    return async () => {
      this.isMonitoring = false;
      this.pollAbort?.abort();
      this.pollAbort = null;
    };
  }

  async isReady(): Promise<boolean> {
    try {
      const response = await fetch(`${TELEGRAM_API}/bot${this.botToken}/getMe`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async healthCheck(): Promise<{ status: "ok" | "degraded" | "down"; message?: string }> {
    try {
      const response = await fetch(`${TELEGRAM_API}/bot${this.botToken}/getMe`);
      if (response.ok) return { status: "ok" };
      return { status: "down", message: "Bot API unreachable" };
    } catch (err) {
      return { status: "down", message: String(err) };
    }
  }

  private async ensureBotInfo(): Promise<void> {
    if (this.botId) return;
    try {
      const response = await fetch(`${TELEGRAM_API}/bot${this.botToken}/getMe`);
      const data = await response.json() as any;
      if (data.ok) {
        this.botId = String(data.result.id);
        this.botUsername = data.result.username;
      }
    } catch {
      // Will be retried on next call
    }
  }

  private parseUpdate(msg: any): InboundMessage | null {
    const text = msg.text || msg.caption || "";
    if (!text && !msg.photo && !msg.document) return null;

    const chatType = msg.chat.type === "private" ? "direct" : "group";

    return {
      id: String(msg.message_id),
      platform: "telegram",
      from: String(msg.from?.id || msg.chat.id),
      to: this.botId || "",
      content: {
        text,
        mediaUrl: undefined, // Telegram requires getFile API call — deferred
        replyToId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      },
      timestamp: (msg.date || 0) * 1000,
      chatType,
      senderName: msg.from ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") : undefined,
    };
  }

  private async sendMediaMessage(message: OutboundMessage, startTime: number): Promise<OutboundResult> {
    const mediaType = message.content.mediaType || "image";
    const endpoint = mediaType === "image" ? "sendPhoto"
      : mediaType === "video" ? "sendVideo"
      : mediaType === "audio" ? "sendAudio"
      : "sendDocument";
    const mediaKey = mediaType === "image" ? "photo"
      : mediaType === "video" ? "video"
      : mediaType === "audio" ? "audio"
      : "document";

    try {
      const response = await fetch(`${TELEGRAM_API}/bot${this.botToken}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: message.to,
          [mediaKey]: message.content.mediaUrl,
          caption: message.content.text,
        }),
      });

      const data = await response.json() as any;
      if (!data.ok) throw new Error(data.description);

      return {
        messageId: String(data.result?.message_id),
        platform: "telegram",
        timestamp: startTime,
        success: true,
      };
    } catch (err) {
      return {
        messageId: "",
        platform: "telegram",
        timestamp: Date.now(),
        success: false,
        error: String(err).replace(this.botToken, "[REDACTED]"),
      };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
