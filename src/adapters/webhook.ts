/**
 * Generic webhook adapter — accepts any JSON payload and normalizes
 * via configurable field mappings.
 *
 * Incoming messages arrive via the WebhookServer calling injectMessage().
 * Outgoing responses POST to a configured response_url.
 */

import { randomUUID } from "node:crypto";
import type {
  NormalizedMessage,
  PlatformAdapter,
  PlatformConfig,
  SendOptions,
} from "../types.js";

const SEND_TIMEOUT_MS = 10_000;

/** Field mapping config — dot-path strings to extract values from payload */
export interface WebhookFieldMap {
  text: string;
  senderId: string;
  channelId?: string;
  senderName?: string;
  messageId?: string;
  timestamp?: string;
}

/**
 * Resolve a dot-path (e.g., "data.message.text") against an object.
 * Returns undefined if any segment is missing.
 */
function resolvePath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export class WebhookAdapter implements PlatformAdapter {
  readonly platform = "webhook" as const;

  private responseUrl = "";
  private fieldMap: WebhookFieldMap = { text: "text", senderId: "from", channelId: "channel" };
  private messageHandler: ((msg: NormalizedMessage) => Promise<void>) | null = null;
  private connected = false;

  async connect(config: PlatformConfig): Promise<void> {
    const { response_url, field_map } = config.credentials;

    if (!field_map) {
      throw new Error(
        "Webhook adapter requires field_map in credentials (JSON string with text, senderId paths)",
      );
    }

    this.responseUrl = response_url ?? "";

    try {
      this.fieldMap = typeof field_map === "string"
        ? (JSON.parse(field_map) as WebhookFieldMap)
        : (field_map as unknown as WebhookFieldMap);
    } catch {
      throw new Error("field_map must be a valid JSON string with text and senderId paths");
    }

    if (!this.fieldMap.text || !this.fieldMap.senderId) {
      throw new Error("field_map must include at least 'text' and 'senderId' paths");
    }

    this.connected = true;
    console.log("[webhook] Generic webhook adapter connected");
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Inject a raw webhook payload. Normalizes using configured field mappings
   * and calls the registered message handler.
   */
  async injectMessage(rawPayload: unknown): Promise<void> {
    if (!this.messageHandler) return;

    const text = String(resolvePath(rawPayload, this.fieldMap.text) ?? "");
    const senderId = String(resolvePath(rawPayload, this.fieldMap.senderId) ?? "");

    if (!text || !senderId) return;

    const channelId = this.fieldMap.channelId
      ? String(resolvePath(rawPayload, this.fieldMap.channelId) ?? senderId)
      : senderId;

    const senderName = this.fieldMap.senderName
      ? (String(resolvePath(rawPayload, this.fieldMap.senderName) ?? "") || undefined)
      : undefined;

    const messageId = this.fieldMap.messageId
      ? String(resolvePath(rawPayload, this.fieldMap.messageId) ?? randomUUID())
      : randomUUID();

    const timestamp = this.fieldMap.timestamp
      ? String(resolvePath(rawPayload, this.fieldMap.timestamp) ?? new Date().toISOString())
      : new Date().toISOString();

    const normalized: NormalizedMessage = {
      messageId,
      platform: "webhook",
      senderId,
      senderName,
      channelId,
      chatType: "direct",
      text,
      timestamp,
      raw: rawPayload,
    };

    try {
      await this.messageHandler(normalized);
    } catch (err) {
      console.error("[webhook] Message handler error:", err);
    }
  }

  async sendText(
    channelId: string,
    text: string,
    _options?: SendOptions,
  ): Promise<void> {
    if (!this.responseUrl) return;

    const res = await fetch(this.responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId, text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Webhook send failed (${res.status}): ${errBody}`);
    }
  }

  async sendTyping(_channelId: string): Promise<void> {
    // Generic webhooks do not support typing indicators
  }

  async healthCheck(): Promise<{ connected: boolean; latencyMs?: number }> {
    return { connected: this.connected };
  }
}
