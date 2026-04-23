/**
 * Signal adapter — wraps signal-cli's JSON-RPC API + SSE event stream.
 *
 * signal-cli must be running in daemon mode:
 *   signal-cli -a +1234567890 daemon --http
 *
 * This adapter connects to its HTTP API for sending and SSE for receiving.
 * Same approach OpenClaw uses — we just skip their plugin-sdk dependencies.
 */

import { randomUUID } from "node:crypto";
import type {
  NormalizedMessage,
  PlatformAdapter,
  PlatformConfig,
  SendOptions,
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

interface SignalSseEvent {
  event?: string;
  data?: string;
}

interface SignalDataMessage {
  timestamp?: number;
  message?: string | null;
  attachments?: Array<{
    contentType?: string | null;
    filename?: string | null;
  }>;
  groupInfo?: {
    groupId?: string | null;
    groupName?: string | null;
  } | null;
  quote?: {
    text?: string | null;
    authorNumber?: string | null;
    id?: number | null;
  } | null;
}

interface SignalEnvelope {
  sourceNumber?: string | null;
  sourceUuid?: string | null;
  sourceName?: string | null;
  sourceDevice?: number | null;
  timestamp?: number | null;
  dataMessage?: SignalDataMessage | null;
  reactionMessage?: {
    emoji: string;
    targetAuthor: string;
    targetTimestamp: number;
    isRemove?: boolean;
  } | null;
  receiptMessage?: {
    type: "delivery" | "read";
    timestamps: number[];
  } | null;
  editMessage?: {
    targetTimestamp: number;
    dataMessage: SignalDataMessage;
  } | null;
  typingMessage?: {
    action: "STARTED" | "STOPPED";
  } | null;
}

export class SignalAdapter implements PlatformAdapter {
  readonly platform = "signal" as const;

  private baseUrl = "";
  private account = "";
  private abortController: AbortController | null = null;
  private messageHandler: ((msg: NormalizedMessage) => Promise<void>) | null = null;
  private _connected = false;

  private normalizeBaseUrl(url: string): string {
    const trimmed = url.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed.replace(/\/+$/, "");
    }
    return `https://${trimmed}`.replace(/\/+$/, "");
  }

  async connect(config: PlatformConfig): Promise<void> {
    this.baseUrl = this.normalizeBaseUrl(
      config.credentials.baseUrl ?? "localhost:8080",
    );
    this.account = config.credentials.account ?? "";

    // Verify signal-cli daemon is running
    const check = await this.healthCheck();
    if (!check.connected) {
      throw new Error(
        `signal-cli daemon not reachable at ${this.baseUrl}. ` +
          `Start it with: signal-cli -a ${this.account} daemon --http`,
      );
    }

    this._connected = true;
    this.abortController = new AbortController();

    // Start SSE event stream in background
    void this.startEventStream();

    // Import contacts and groups on connect (fire-and-forget)
    void this.syncContacts().catch((err) => {
      console.error("[signal] Contact sync failed:", err);
    });
    void this.syncGroups().catch((err) => {
      console.error("[signal] Group sync failed:", err);
    });
  }

  async disconnect(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    this._connected = false;
  }

  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async sendText(
    channelId: string,
    text: string,
    _options?: SendOptions,
  ): Promise<void> {
    const isGroup = channelId.startsWith("group:");
    const params: Record<string, unknown> = {
      message: text,
      ...(isGroup
        ? { groupId: channelId.slice("group:".length) }
        : { recipient: [channelId] }),
    };
    if (this.account) {
      params.account = this.account;
    }
    await this.rpcRequest("send", params);
  }

  async sendTyping(channelId: string): Promise<void> {
    try {
      const isGroup = channelId.startsWith("group:");
      await this.rpcRequest("sendTyping", {
        ...(isGroup
          ? { groupId: channelId.slice("group:".length) }
          : { recipient: [channelId] }),
        ...(this.account ? { account: this.account } : {}),
      });
    } catch {
      // best-effort
    }
  }

  async healthCheck(): Promise<{ connected: boolean; latencyMs?: number }> {
    if (!this.baseUrl) return { connected: this._connected };
    const start = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/check`, {
        method: "GET",
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      this._connected = res.ok;
      return {
        connected: this._connected,
        latencyMs: Date.now() - start,
      };
    } catch {
      this._connected = false;
      return { connected: false };
    }
  }

  private async rpcRequest<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const id = randomUUID();
    const res = await fetch(`${this.baseUrl}/api/v1/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (res.status === 201) return undefined as T;

    const text = await res.text();
    if (!text) throw new Error(`Signal RPC empty response (${res.status})`);

    const parsed = JSON.parse(text) as {
      result?: T;
      error?: { code?: number; message?: string };
    };
    if (parsed.error) {
      throw new Error(
        `Signal RPC ${parsed.error.code ?? "unknown"}: ${parsed.error.message ?? "error"}`,
      );
    }
    return parsed.result as T;
  }

  private async startEventStream(): Promise<void> {
    const url = new URL(`${this.baseUrl}/api/v1/events`);
    if (this.account) {
      url.searchParams.set("account", this.account);
    }

    while (this.abortController && !this.abortController.signal.aborted) {
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: { Accept: "text/event-stream" },
          signal: this.abortController.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`Signal SSE failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEvent: SignalSseEvent = {};

        const flushEvent = () => {
          if (currentEvent.data) {
            void this.handleSseEvent(currentEvent);
          }
          currentEvent = {};
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          let lineEnd = buffer.indexOf("\n");
          while (lineEnd !== -1) {
            let line = buffer.slice(0, lineEnd);
            buffer = buffer.slice(lineEnd + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);

            if (line === "") {
              flushEvent();
            } else if (!line.startsWith(":")) {
              const colonIdx = line.indexOf(":");
              if (colonIdx !== -1) {
                const field = line.slice(0, colonIdx).trim();
                const val = line.slice(colonIdx + 1).replace(/^ /, "");
                if (field === "event") currentEvent.event = val;
                else if (field === "data") {
                  currentEvent.data = currentEvent.data
                    ? `${currentEvent.data}\n${val}`
                    : val;
                }
              }
            }
            lineEnd = buffer.indexOf("\n");
          }
        }
      } catch (err) {
        if (this.abortController?.signal.aborted) return;
        console.error("[signal] SSE stream error, reconnecting in 5s:", err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async handleSseEvent(event: SignalSseEvent): Promise<void> {
    if (!event.data || !this.messageHandler) return;

    let payload: { envelope?: SignalEnvelope };
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    const envelope = payload.envelope;
    if (!envelope) return;

    const senderId: string = envelope.sourceNumber ?? envelope.sourceUuid ?? "";

    // Reaction message
    if (envelope.reactionMessage) {
      const rm = envelope.reactionMessage;
      const normalized: NormalizedMessage = {
        messageId: randomUUID(),
        platform: "signal",
        senderId,
        senderName: envelope.sourceName ?? undefined,
        channelId: senderId,
        chatType: "direct",
        text: "",
        timestamp: new Date(
          (envelope.timestamp ?? Date.now()) as number,
        ).toISOString(),
        raw: payload,
        dataCategory: "reaction",
        reaction: {
          emoji: rm.emoji,
          targetMessageId: String(rm.targetTimestamp),
          reactedBy: senderId,
          timestamp: new Date(
            (envelope.timestamp ?? Date.now()) as number,
          ).toISOString(),
        },
      };
      await this.emitMessage(normalized);
      return;
    }

    // Receipt message (read/delivery)
    if (envelope.receiptMessage) {
      const rcpt = envelope.receiptMessage;
      for (const ts of rcpt.timestamps) {
        const normalized: NormalizedMessage = {
          messageId: randomUUID(),
          platform: "signal",
          senderId,
          senderName: envelope.sourceName ?? undefined,
          channelId: senderId,
          chatType: "direct",
          text: "",
          timestamp: new Date(
            (envelope.timestamp ?? Date.now()) as number,
          ).toISOString(),
          raw: payload,
          dataCategory: "read_receipt",
          readReceipt: {
            messageId: String(ts),
            status: rcpt.type === "read" ? "read" : "delivered",
            timestamp: new Date(
              (envelope.timestamp ?? Date.now()) as number,
            ).toISOString(),
            readBy: senderId,
          },
        };
        await this.emitMessage(normalized);
      }
      return;
    }

    // Edit message
    if (envelope.editMessage) {
      const em = envelope.editMessage;
      const dm = em.dataMessage;
      const isGroup = !!dm.groupInfo?.groupId;
      const normalized: NormalizedMessage = {
        messageId: String(dm.timestamp ?? randomUUID()),
        platform: "signal",
        senderId,
        senderName: envelope.sourceName ?? undefined,
        channelId: isGroup
          ? `group:${dm.groupInfo!.groupId ?? ""}`
          : senderId,
        chatType: isGroup ? "group" : "direct",
        text: dm.message ?? "",
        timestamp: new Date(
          (envelope.timestamp ?? Date.now()) as number,
        ).toISOString(),
        media: this.extractMedia(dm),
        raw: payload,
        dataCategory: "edit",
        replyTo: {
          messageId: String(em.targetTimestamp),
          text: "",
          senderId,
        },
      };
      await this.emitMessage(normalized);
      return;
    }

    // Regular data message
    if (!envelope.dataMessage?.message) return;

    const dm = envelope.dataMessage;
    const isGroup = !!dm.groupInfo?.groupId;

    const normalized: NormalizedMessage = {
      messageId: String(dm.timestamp ?? randomUUID()),
      platform: "signal",
      senderId,
      senderName: envelope.sourceName ?? undefined,
      channelId: isGroup
        ? `group:${dm.groupInfo!.groupId ?? ""}`
        : senderId,
      chatType: isGroup ? "group" : "direct",
      text: dm.message!,
      timestamp: new Date(
        (envelope.timestamp ?? Date.now()) as number,
      ).toISOString(),
      media: this.extractMedia(dm),
      replyTo: dm.quote
        ? {
            messageId: String(dm.quote.id ?? ""),
            text: dm.quote.text ?? "",
            senderId: dm.quote.authorNumber ?? "",
          }
        : undefined,
      raw: payload,
      dataCategory: "message",
    };

    await this.emitMessage(normalized);
  }

  private async emitMessage(msg: NormalizedMessage): Promise<void> {
    if (!this.messageHandler) return;
    try {
      await this.messageHandler(msg);
    } catch (err) {
      console.error("[signal] Message handler error:", err);
    }
  }

  /** Import all Signal contacts via listContacts RPC */
  private async syncContacts(): Promise<void> {
    if (!this.messageHandler) return;

    interface SignalContact {
      number?: string;
      name?: string;
      profileName?: string;
      uuid?: string;
    }

    const contacts = await this.rpcRequest<SignalContact[]>("listContacts", {
      ...(this.account ? { account: this.account } : {}),
    });

    if (!Array.isArray(contacts)) return;

    for (const contact of contacts) {
      const phone = contact.number ?? "";
      if (!phone) continue;

      const name = contact.name ?? contact.profileName ?? phone;
      const normalized: NormalizedMessage = {
        messageId: randomUUID(),
        platform: "signal",
        senderId: phone,
        senderName: name,
        channelId: phone,
        chatType: "direct",
        text: "",
        timestamp: new Date().toISOString(),
        raw: contact,
        dataCategory: "contact_sync",
        contactSync: {
          name,
          phone,
          pushName: contact.profileName ?? undefined,
        },
      };
      await this.emitMessage(normalized);
    }

    console.log(`[signal] Synced ${contacts.length} contacts`);
  }

  /** Import all Signal groups via listGroups RPC */
  private async syncGroups(): Promise<void> {
    if (!this.messageHandler) return;

    interface SignalGroup {
      id: string;
      name?: string;
      description?: string;
      members?: string[];
      admins?: string[];
    }

    const groups = await this.rpcRequest<SignalGroup[]>("listGroups", {
      ...(this.account ? { account: this.account } : {}),
    });

    if (!Array.isArray(groups)) return;

    for (const group of groups) {
      const normalized: NormalizedMessage = {
        messageId: randomUUID(),
        platform: "signal",
        senderId: `group:${group.id}`,
        channelId: `group:${group.id}`,
        chatType: "group",
        text: "",
        timestamp: new Date().toISOString(),
        raw: group,
        dataCategory: "group",
        groupInfo: {
          groupId: group.id,
          groupName: group.name ?? "",
          participants: group.members ?? [],
          admins: group.admins ?? [],
          description: group.description ?? undefined,
        },
      };
      await this.emitMessage(normalized);
    }

    console.log(`[signal] Synced ${groups.length} groups`);
  }

  private extractMedia(
    dm: SignalDataMessage,
  ): NormalizedMessage["media"] {
    if (!dm.attachments?.length) return undefined;
    return dm.attachments.map((att) => {
      const ct = att.contentType ?? "";
      let type: "image" | "video" | "audio" | "document" = "document";
      if (ct.startsWith("image/")) type = "image";
      else if (ct.startsWith("video/")) type = "video";
      else if (ct.startsWith("audio/")) type = "audio";
      return { type, fileName: att.filename ?? undefined };
    });
  }
}
