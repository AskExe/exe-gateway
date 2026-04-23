/**
 * WhatsApp adapter — Baileys (QR-scan linked device, no Business API).
 *
 * Uses @whiskeysockets/baileys for direct WhatsApp Web protocol.
 * Session state stored in ~/.exe-os/whatsapp-auth/ via useMultiFileAuthState.
 * QR code printed to terminal on first connection — scan with WhatsApp.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  NormalizedMessage,
  PlatformAdapter,
  PlatformConfig,
  SendOptions,
  DataCategory,
} from "../types.js";

const RECONNECT_DELAY_MS = 5_000;
const AUTH_DIR = join(homedir(), ".exe-os", "whatsapp-auth");

// Baileys types — imported dynamically to avoid top-level ESM issues
type BaileysSocket = Awaited<ReturnType<typeof import("@whiskeysockets/baileys").default>>;

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform = "whatsapp" as const;

  private sock: BaileysSocket | null = null;
  private messageHandler: ((msg: NormalizedMessage) => Promise<void>) | null = null;
  private connected = false;
  private abortController: AbortController | null = null;
  private authDir = AUTH_DIR;

  async connect(config: PlatformConfig): Promise<void> {
    this.authDir = config.credentials.authDir ?? AUTH_DIR;
    mkdirSync(this.authDir, { recursive: true });

    const baileys = await import("@whiskeysockets/baileys");
    const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, makeCacheableSignalKeyStore } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.abortController = new AbortController();

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, undefined as any),
      },
      version,
      printQRInTerminal: true,
      browser: ["exe-os", "cli", "1.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock = sock;

    // Persist credentials on update
    sock.ev.on("creds.update", saveCreds);

    // Connection state management
    sock.ev.on("connection.update", (update: any) => {
      const { connection, lastDisconnect } = update;

      if (connection === "close") {
        this.connected = false;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect && !this.abortController?.signal.aborted) {
          console.log(`[whatsapp] Connection closed (${statusCode}), reconnecting...`);
          setTimeout(() => void this.connect(config), RECONNECT_DELAY_MS);
        } else {
          console.log("[whatsapp] Logged out — clear auth and re-scan QR");
        }
      }

      if (connection === "open") {
        this.connected = true;
        console.log("[whatsapp] Connected via Baileys (linked device)");
      }
    });

    // Incoming messages
    sock.ev.on("messages.upsert", (upsert: any) => {
      if (!this.messageHandler) return;
      const { messages, type } = upsert;
      if (type !== "notify") return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const normalized = this.normalizeMessage(msg);
        if (normalized) {
          void this.messageHandler(normalized).catch((err) => {
            console.error("[whatsapp] Message handler error:", err);
          });
        }
      }
    });

    // Read receipts
    sock.ev.on("message-receipt.update", (updates: any) => {
      if (!this.messageHandler) return;
      for (const update of updates) {
        const receipt = this.normalizeReadReceipt(update);
        if (receipt) {
          void this.messageHandler(receipt).catch((err) => {
            console.error("[whatsapp] Read receipt handler error:", err);
          });
        }
      }
    });

    // Contacts sync (bulk import on first link)
    sock.ev.on("contacts.upsert", (contacts: any) => {
      if (!this.messageHandler) return;
      for (const contact of contacts) {
        const synced = this.normalizeContactSync(contact);
        if (synced) {
          void this.messageHandler(synced).catch((err) => {
            console.error("[whatsapp] Contact sync handler error:", err);
          });
        }
      }
    });

    // Groups
    sock.ev.on("groups.upsert", (groups: any) => {
      if (!this.messageHandler) return;
      for (const group of groups) {
        const normalized = this.normalizeGroupInfo(group);
        if (normalized) {
          void this.messageHandler(normalized).catch((err) => {
            console.error("[whatsapp] Group handler error:", err);
          });
        }
      }
    });

    // Reactions
    sock.ev.on("messages.reaction", (reactions: any) => {
      if (!this.messageHandler) return;
      for (const reaction of reactions) {
        const normalized = this.normalizeReaction(reaction);
        if (normalized) {
          void this.messageHandler(normalized).catch((err) => {
            console.error("[whatsapp] Reaction handler error:", err);
          });
        }
      }
    });

    // Calls
    sock.ev.on("call", (calls: any) => {
      if (!this.messageHandler) return;
      for (const call of calls) {
        const normalized = this.normalizeCall(call);
        if (normalized) {
          void this.messageHandler(normalized).catch((err) => {
            console.error("[whatsapp] Call handler error:", err);
          });
        }
      }
    });

    // History sync (on first link — imports past messages)
    sock.ev.on("messaging-history.set", (history: any) => {
      if (!this.messageHandler) return;
      const { messages: historyMessages } = history;
      if (!Array.isArray(historyMessages)) return;

      for (const msg of historyMessages) {
        if (msg.key?.fromMe) continue;
        const normalized = this.normalizeMessage(msg);
        if (normalized) {
          normalized.dataCategory = "history_sync";
          normalized.isHistorical = true;
          void this.messageHandler(normalized).catch((err) => {
            console.error("[whatsapp] History sync handler error:", err);
          });
        }
      }
    });
  }

  async disconnect(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    this.sock?.ws?.close();
    this.sock = null;
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
    if (!this.sock || !this.connected) throw new Error("WhatsApp not connected");

    const jid = channelId.includes("@") ? channelId : `${channelId}@s.whatsapp.net`;

    await this.sock.sendMessage(jid, {
      text,
      ...(options?.replyToMessageId
        ? { quoted: { key: { remoteJid: jid, id: options.replyToMessageId } } as any }
        : {}),
    });
  }

  async sendTyping(channelId: string): Promise<void> {
    if (!this.sock || !this.connected) return;
    const jid = channelId.includes("@") ? channelId : `${channelId}@s.whatsapp.net`;
    await this.sock.sendPresenceUpdate("composing", jid);
  }

  async healthCheck(): Promise<{ connected: boolean; latencyMs?: number }> {
    return { connected: this.connected };
  }

  /** Verify webhook for backward compat — no-op for Baileys */
  verifyWebhook(_mode: string, _token: string, _challenge: string): string | null {
    return null;
  }

  /** Inject message — no-op for Baileys (messages arrive via socket) */
  async injectMessage(_rawPayload: unknown): Promise<void> {
    // Baileys receives messages via WebSocket, not webhooks
  }

  private normalizeMessage(msg: any): NormalizedMessage | null {
    const text =
      msg.message?.conversation ??
      msg.message?.extendedTextMessage?.text ??
      msg.message?.imageMessage?.caption ??
      msg.message?.videoMessage?.caption ??
      msg.message?.documentMessage?.caption ??
      "";

    if (!text && !msg.message) return null;

    const remoteJid = msg.key.remoteJid ?? "";
    const isGroup = remoteJid.endsWith("@g.us");
    const senderId = isGroup
      ? msg.key.participant ?? ""
      : remoteJid.replace("@s.whatsapp.net", "");

    const media = this.extractMedia(msg.message);
    const replyContext = msg.message?.extendedTextMessage?.contextInfo;
    const location = this.extractLocation(msg.message);

    const dataCategory: DataCategory = location ? "location" : "message";

    return {
      messageId: msg.key.id ?? randomUUID(),
      platform: "whatsapp",
      senderId,
      senderName: msg.pushName ?? undefined,
      senderPhone: senderId.replace("@s.whatsapp.net", ""),
      channelId: remoteJid,
      chatType: isGroup ? "group" : "direct",
      text,
      timestamp: msg.messageTimestamp
        ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
        : new Date().toISOString(),
      media,
      replyTo: replyContext?.quotedMessage
        ? {
            messageId: replyContext.stanzaId ?? "",
            text: replyContext.quotedMessage.conversation ?? "",
            senderId: replyContext.participant ?? "",
          }
        : undefined,
      raw: msg,
      dataCategory,
      location,
    };
  }

  private extractLocation(message: any): NormalizedMessage["location"] {
    const loc = message?.locationMessage;
    const live = message?.liveLocationMessage;
    const src = loc ?? live;
    if (!src) return undefined;

    return {
      latitude: src.degreesLatitude,
      longitude: src.degreesLongitude,
      address: src.address ?? undefined,
      venueName: src.name ?? undefined,
      isLive: !!live,
    };
  }

  private normalizeReadReceipt(update: any): NormalizedMessage | null {
    const key = update.key;
    if (!key) return null;

    const remoteJid = key.remoteJid ?? "";
    const receipt = update.receipt;
    if (!receipt) return null;

    // Map Baileys receipt type to status
    let status: "sent" | "delivered" | "read" = "delivered";
    if (receipt.readTimestamp || receipt.receiptTimestamp) {
      status = "read";
    }

    const timestamp = receipt.readTimestamp ?? receipt.receiptTimestamp ?? Date.now() / 1000;

    return {
      messageId: randomUUID(),
      platform: "whatsapp",
      senderId: remoteJid.replace("@s.whatsapp.net", "").replace("@g.us", ""),
      channelId: remoteJid,
      chatType: remoteJid.endsWith("@g.us") ? "group" : "direct",
      text: "",
      timestamp: new Date(Number(timestamp) * 1000).toISOString(),
      raw: update,
      dataCategory: "read_receipt",
      readReceipt: {
        messageId: key.id ?? "",
        status,
        timestamp: new Date(Number(timestamp) * 1000).toISOString(),
        readBy: key.participant ?? undefined,
      },
    };
  }

  private normalizeContactSync(contact: any): NormalizedMessage | null {
    const id = contact.id;
    if (!id) return null;

    const phone = id.replace("@s.whatsapp.net", "").replace("@g.us", "");
    const name = contact.name ?? contact.notify ?? phone;

    return {
      messageId: randomUUID(),
      platform: "whatsapp",
      senderId: phone,
      senderName: name,
      senderPhone: phone,
      channelId: id,
      chatType: "direct",
      text: "",
      timestamp: new Date().toISOString(),
      raw: contact,
      dataCategory: "contact_sync",
      contactSync: {
        name,
        phone,
        pushName: contact.notify ?? undefined,
      },
    };
  }

  private normalizeGroupInfo(group: any): NormalizedMessage | null {
    const groupId = group.id;
    if (!groupId) return null;

    const participants = (group.participants ?? []).map((p: any) => p.id ?? p);
    const admins = (group.participants ?? [])
      .filter((p: any) => p.admin === "admin" || p.admin === "superadmin")
      .map((p: any) => p.id ?? p);

    return {
      messageId: randomUUID(),
      platform: "whatsapp",
      senderId: groupId,
      channelId: groupId,
      chatType: "group",
      text: "",
      timestamp: new Date().toISOString(),
      raw: group,
      dataCategory: "group",
      groupInfo: {
        groupId,
        groupName: group.subject ?? "",
        participants,
        admins,
        description: group.desc ?? undefined,
      },
    };
  }

  private normalizeReaction(reaction: any): NormalizedMessage | null {
    const key = reaction.key;
    if (!key) return null;

    const reactionData = reaction.reaction;
    if (!reactionData) return null;

    const remoteJid = key.remoteJid ?? "";

    return {
      messageId: randomUUID(),
      platform: "whatsapp",
      senderId: reactionData.key?.participant ?? reactionData.key?.remoteJid?.replace("@s.whatsapp.net", "") ?? "",
      channelId: remoteJid,
      chatType: remoteJid.endsWith("@g.us") ? "group" : "direct",
      text: "",
      timestamp: reactionData.senderTimestampMs
        ? new Date(Number(reactionData.senderTimestampMs)).toISOString()
        : new Date().toISOString(),
      raw: reaction,
      dataCategory: "reaction",
      reaction: {
        emoji: reactionData.text ?? "",
        targetMessageId: key.id ?? "",
        reactedBy: reactionData.key?.participant ?? reactionData.key?.remoteJid?.replace("@s.whatsapp.net", "") ?? "",
        timestamp: reactionData.senderTimestampMs
          ? new Date(Number(reactionData.senderTimestampMs)).toISOString()
          : new Date().toISOString(),
      },
    };
  }

  private normalizeCall(call: any): NormalizedMessage | null {
    const chatId = call.chatId ?? call.from;
    if (!chatId) return null;

    const caller = call.from?.replace("@s.whatsapp.net", "") ?? "";

    return {
      messageId: randomUUID(),
      platform: "whatsapp",
      senderId: caller,
      channelId: chatId,
      chatType: call.isGroup ? "group" : "direct",
      text: "",
      timestamp: call.date
        ? new Date(call.date * 1000).toISOString()
        : new Date().toISOString(),
      raw: call,
      dataCategory: "call_log",
      callLog: {
        callType: call.isVideo ? "video" : "voice",
        status: call.status ?? "offered",
        duration: call.duration ?? undefined,
        caller,
        callee: call.from === chatId ? "" : chatId.replace("@s.whatsapp.net", ""),
        timestamp: call.date
          ? new Date(call.date * 1000).toISOString()
          : new Date().toISOString(),
        isGroup: call.isGroup ?? false,
      },
    };
  }

  private extractMedia(message: any): NormalizedMessage["media"] {
    if (!message) return undefined;
    const media: NonNullable<NormalizedMessage["media"]> = [];

    if (message.imageMessage) {
      media.push({ type: "image", fileName: "image.jpg" });
    }
    if (message.videoMessage) {
      media.push({ type: "video", fileName: "video.mp4" });
    }
    if (message.audioMessage) {
      media.push({ type: "audio", fileName: "audio.ogg" });
    }
    if (message.documentMessage) {
      media.push({
        type: "document",
        fileName: message.documentMessage.fileName ?? "document",
      });
    }

    return media.length > 0 ? media : undefined;
  }
}
