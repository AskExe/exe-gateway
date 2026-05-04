/**
 * WhatsApp adapter — Baileys (QR-scan linked device, no Business API).
 *
 * Uses @whiskeysockets/baileys for direct WhatsApp Web protocol.
 * Session state stored in ~/.exe-os/whatsapp-auth/ via useMultiFileAuthState.
 * QR code printed to terminal on first connection — scan with WhatsApp.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { SocksProxyAgent } from "socks-proxy-agent";
import type {
  NormalizedMessage,
  PlatformAdapter,
  PlatformConfig,
  SendOptions,
  DataCategory,
} from "../types.js";
import { getDefaultWhatsAppAuthDir } from "../config.js";

const INITIAL_RECONNECT_DELAY_MS = 5_000;  // Start at 5s
const MAX_RECONNECT_DELAY_MS = 300_000;    // Cap at 5 minutes
const PROXY_DOWN_INTERVAL_MS = 600_000;    // 10 minutes when proxy unreachable
const PROXY_HEALTH_TIMEOUT_MS = 5_000;     // 5s TCP connect timeout
const AUTH_DIR = getDefaultWhatsAppAuthDir("default");

// SOCKS proxy for routing WhatsApp traffic through residential IP.
// Per-account proxy (credentials.proxy) overrides this global fallback.
const GLOBAL_SOCKS_PROXY_URL = process.env.WHATSAPP_PROXY_URL || "";

// Baileys types — imported dynamically to avoid top-level ESM issues
type BaileysSocket = Awaited<ReturnType<typeof import("@whiskeysockets/baileys").default>>;

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform = "whatsapp" as const;
  readonly accountName: string;

  private sock: BaileysSocket | null = null;
  private messageHandler: ((msg: NormalizedMessage) => Promise<void>) | null = null;
  private connected = false;
  private abortController: AbortController | null = null;
  private authDir = AUTH_DIR;
  private reconnectAttempts = 0;
  private lastConnectedAt: Date | null = null;
  private proxyReachable = true;
  /** Resolved proxy URL for this account (per-account or global fallback) */
  private proxyUrl = "";

  constructor(accountName = "default") {
    this.accountName = accountName;
  }

  async connect(config: PlatformConfig): Promise<void> {
    this.authDir = config.credentials.authDir ?? AUTH_DIR;
    mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
    chmodSync(this.authDir, 0o700);

    // Resolve proxy: per-account → global env → none
    this.proxyUrl = config.credentials.proxy || GLOBAL_SOCKS_PROXY_URL;

    const baileys = await import("@whiskeysockets/baileys");
    const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, makeCacheableSignalKeyStore } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.abortController = new AbortController();

    const socketOptions: Record<string, unknown> = {
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, undefined as any),
      },
      version,
      printQRInTerminal: true,
      browser: ["Chrome", "Chrome", "130.0.0"],  // Blend in — real Chrome linked-device fingerprint
      syncFullHistory: true,  // Always sync — business accounts need full conversation history
      markOnlineOnConnect: false,
    };

    if (this.proxyUrl) {
      const agent = new SocksProxyAgent(this.proxyUrl);
      socketOptions.agent = agent;
      socketOptions.fetchAgent = agent;
      console.log(
        `[whatsapp:${this.accountName}] Routing through SOCKS proxy: ${sanitizeProxyUrl(this.proxyUrl)}`,
      );
    }

    const sock = makeWASocket(socketOptions as any);

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
          this.reconnectAttempts++;

          // Periodic status log every 10 attempts
          if (this.reconnectAttempts % 10 === 0) {
            const offlineMs = this.lastConnectedAt
              ? Date.now() - this.lastConnectedAt.getTime()
              : 0;
            const offlineHours = (offlineMs / 3_600_000).toFixed(1);
            console.log(
              `[whatsapp:${this.accountName}] Offline for ${offlineHours}h, ${this.reconnectAttempts} attempts, proxy: ${this.proxyReachable ? "up" : "down"}`,
            );
          }

          void this.reconnectWithProxyCheck(config);
        } else {
          console.log(`[whatsapp:${this.accountName}] Logged out — clear auth and re-pair`);
        }
      }

      if (connection === "open") {
        this.connected = true;
        this.lastConnectedAt = new Date();
        this.reconnectAttempts = 0;
        this.proxyReachable = true;
        console.log(`[whatsapp:${this.accountName}] Connected via Baileys (linked device)`);
      }
    });

    // History sync — captures all historical messages on first link
    sock.ev.on("messaging-history.set" as any, (data: any) => {
      const { messages = [], chats = [], contacts = [], isLatest } = data;
      console.log(
        `[whatsapp:${this.accountName}] History sync: ${messages.length} messages, ${chats.length} chats, ${contacts.length} contacts` +
        (isLatest ? " (final batch)" : " (more coming...)"),
      );

      if (!this.messageHandler) return;

      // Process historical messages — mark them as historical so onIngest can handle appropriately
      for (const msg of messages) {
        const normalized = this.normalizeMessage(msg.message ?? msg);
        if (normalized) {
          normalized.isHistorical = true;
          void this.messageHandler(normalized).catch((err) => {
            console.error(`[whatsapp:${this.accountName}] History message handler error:`, err);
          });
        }
      }

      // Process historical contacts
      for (const contact of contacts) {
        const synced = this.normalizeContactSync(contact);
        if (synced) {
          void this.messageHandler(synced).catch((err) => {
            console.error(`[whatsapp:${this.accountName}] History contact handler error:`, err);
          });
        }
      }
    });

    // Live incoming messages (real-time)
    sock.ev.on("messages.upsert", (upsert: any) => {
      if (!this.messageHandler) return;
      const { messages, type } = upsert;
      if (type !== "notify") return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const normalized = this.normalizeMessage(msg);
        if (normalized) {
          void this.messageHandler(normalized).catch((err) => {
            console.error(`[whatsapp:${this.accountName}] Message handler error:`, err);
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
            console.error(`[whatsapp:${this.accountName}] Read receipt handler error:`, err);
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
            console.error(`[whatsapp:${this.accountName}] Contact sync handler error:`, err);
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
            console.error(`[whatsapp:${this.accountName}] Group handler error:`, err);
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
            console.error(`[whatsapp:${this.accountName}] Reaction handler error:`, err);
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
            console.error(`[whatsapp:${this.accountName}] Call handler error:`, err);
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
            console.error(`[whatsapp:${this.accountName}] History sync handler error:`, err);
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

  getHealthStatus(): {
    connected: boolean;
    lastConnectedAt: Date | null;
    reconnectAttempts: number;
    proxyReachable: boolean;
  } {
    return {
      connected: this.connected,
      lastConnectedAt: this.lastConnectedAt,
      reconnectAttempts: this.reconnectAttempts,
      proxyReachable: this.proxyReachable,
    };
  }

  private async reconnectWithProxyCheck(config: PlatformConfig): Promise<void> {
    // If SOCKS proxy is configured, check if it's reachable before reconnecting
    if (this.proxyUrl) {
      const reachable = await this.checkProxyHealth();
      this.proxyReachable = reachable;

      if (!reachable) {
        console.log(
          `[whatsapp:${this.accountName}] SOCKS proxy unreachable, waiting for recovery...`,
        );
        // Back off to 10-minute intervals while proxy is down
        const timer = setInterval(async () => {
          if (this.abortController?.signal.aborted) {
            clearInterval(timer);
            return;
          }
          const recovered = await this.checkProxyHealth();
          if (recovered) {
            clearInterval(timer);
            this.proxyReachable = true;
            console.log(
              `[whatsapp:${this.accountName}] SOCKS proxy recovered, reconnecting immediately...`,
            );
            this.reconnectAttempts = 0;
            void this.connect(config);
          }
        }, PROXY_DOWN_INTERVAL_MS);
        return;
      }
    }

    // Exponential backoff: 5s, 10s, 20s, 40s, 80s, 160s, 300s (capped)
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS *
        Math.pow(2, Math.min(this.reconnectAttempts, 6)),
      MAX_RECONNECT_DELAY_MS,
    );
    console.log(
      `[whatsapp:${this.accountName}] Connection closed, reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`,
    );
    setTimeout(() => void this.connect(config), delay);
  }

  private checkProxyHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const url = new URL(this.proxyUrl);
        const host = url.hostname;
        const port = parseInt(url.port, 10) || 1080;

        const socket = createConnection({ host, port, timeout: PROXY_HEALTH_TIMEOUT_MS });
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("timeout", () => {
          socket.destroy();
          resolve(false);
        });
        socket.once("error", () => {
          socket.destroy();
          resolve(false);
        });
      } catch {
        resolve(false);
      }
    });
  }

  /** Expose raw Baileys socket for admin API (groups, contacts, etc.) */
  getRawSocket(): unknown {
    return this.sock;
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

function sanitizeProxyUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "[invalid proxy URL]";
  }
}
