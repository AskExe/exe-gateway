/**
 * Email adapter — SMTP sending via nodemailer, incoming via webhook injection.
 *
 * Incoming emails arrive via an external email service (e.g., SendGrid Inbound Parse,
 * Mailgun Routes) that POSTs parsed email to the WebhookServer, which calls injectMessage().
 * Outgoing emails go via SMTP through nodemailer.
 */

import { randomUUID } from "node:crypto";
import { createTransport, type Transporter } from "nodemailer";
import type {
  NormalizedMessage,
  PlatformAdapter,
  PlatformConfig,
  SendOptions,
} from "../types.js";

const SMTP_VERIFY_TIMEOUT_MS = 10_000;

/** Raw email payload structure from inbound parse services */
interface InboundEmailPayload {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  sender_ip?: string;
  envelope?: { from?: string; to?: string[] };
  headers?: Record<string, string>;
  message_id?: string;
  attachments?: Array<{
    filename?: string;
    content_type?: string;
  }>;
}

/** Extract sender email from a "Name <email>" or plain email string */
function extractEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match?.[1] ?? from.trim();
}

/** Extract sender name from a "Name <email>" string */
function extractSenderName(from: string): string | undefined {
  const match = from.match(/^([^<]+)</);
  const name = match?.[1]?.trim();
  return name || undefined;
}

/** Map email content type to media type */
function mapContentType(contentType: string): "image" | "video" | "audio" | "document" {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return "document";
}

export class EmailAdapter implements PlatformAdapter {
  readonly platform = "email" as const;

  private transporter: Transporter | null = null;
  private fromAddress = "";
  private messageHandler: ((msg: NormalizedMessage) => Promise<void>) | null = null;
  private connected = false;

  async connect(config: PlatformConfig): Promise<void> {
    const {
      smtp_host,
      smtp_port,
      smtp_user,
      smtp_pass,
      smtp_tls,
      from_address,
    } = config.credentials;

    if (!smtp_host || !smtp_user || !smtp_pass || !from_address) {
      throw new Error(
        "Email adapter requires smtp_host, smtp_user, smtp_pass, and from_address in credentials",
      );
    }

    this.fromAddress = from_address;

    this.transporter = createTransport({
      host: smtp_host,
      port: smtp_port ? parseInt(smtp_port, 10) : 587,
      secure: smtp_tls === "true",
      auth: {
        user: smtp_user,
        pass: smtp_pass,
      },
    });

    // Verify SMTP connection
    const check = await this.healthCheck();
    if (!check.connected) {
      throw new Error(`SMTP connection failed to ${smtp_host}`);
    }

    this.connected = true;
    console.log(`[email] Connected to SMTP ${smtp_host}`);
  }

  async disconnect(): Promise<void> {
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
    this.connected = false;
  }

  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Inject a raw inbound email payload from the WebhookServer.
   * Parses the email fields and calls the registered message handler.
   */
  async injectMessage(rawPayload: unknown): Promise<void> {
    if (!this.messageHandler) return;

    const payload = rawPayload as InboundEmailPayload;
    const from = payload.from ?? payload.envelope?.from ?? "";
    const text = payload.text ?? "";

    if (!from || !text) return;

    const senderEmail = extractEmailAddress(from);
    const media = this.extractMedia(payload);

    const normalized: NormalizedMessage = {
      messageId: payload.message_id ?? randomUUID(),
      platform: "email",
      senderId: senderEmail,
      senderName: extractSenderName(from),
      channelId: senderEmail,
      chatType: "direct",
      text: payload.subject ? `[${payload.subject}] ${text}` : text,
      timestamp: new Date().toISOString(),
      media,
      raw: rawPayload,
    };

    try {
      await this.messageHandler(normalized);
    } catch (err) {
      console.error("[email] Message handler error:", err);
    }
  }

  async sendText(
    channelId: string,
    text: string,
    _options?: SendOptions,
  ): Promise<void> {
    if (!this.transporter) throw new Error("Email not connected");

    await this.transporter.sendMail({
      from: this.fromAddress,
      to: channelId,
      subject: "Reply from Exe OS",
      text,
    });
  }

  async sendTyping(_channelId: string): Promise<void> {
    // Email does not support typing indicators
  }

  async healthCheck(): Promise<{ connected: boolean; latencyMs?: number }> {
    if (!this.transporter) return { connected: this.connected };

    const start = Date.now();
    try {
      await Promise.race([
        this.transporter.verify(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("SMTP verify timeout")), SMTP_VERIFY_TIMEOUT_MS),
        ),
      ]);
      this.connected = true;
      return { connected: true, latencyMs: Date.now() - start };
    } catch {
      this.connected = false;
      return { connected: false };
    }
  }

  private extractMedia(payload: InboundEmailPayload): NormalizedMessage["media"] {
    if (!payload.attachments?.length) return undefined;

    return payload.attachments.map((att) => ({
      type: mapContentType(att.content_type ?? "application/octet-stream"),
      fileName: att.filename ?? undefined,
    }));
  }
}
