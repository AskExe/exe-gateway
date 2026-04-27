/**
 * GatewayAdapter interface — unified abstraction for messaging platforms
 *
 * All messaging adapters (WhatsApp, Telegram, Discord, Slack, iMessage)
 * implement this interface to enable pluggable platform support.
 *
 * @module gateway-adapter
 */

export interface MessageContent {
  text?: string;
  mediaUrl?: string;
  mediaType?: "image" | "video" | "audio" | "document";
  replyToId?: string;
  threadId?: string;
}

export interface InboundMessage {
  id: string;
  platform: "whatsapp" | "telegram" | "discord" | "slack" | "imessage";
  from: string;
  to: string;
  content: MessageContent;
  timestamp: number;
  chatType: "direct" | "group";
  senderName?: string;
}

export interface OutboundMessage {
  to: string;
  content: MessageContent;
  accountId?: string;
}

export interface OutboundResult {
  messageId: string;
  platform: string;
  timestamp: number;
  success: boolean;
  error?: string;
}

export interface PlatformAccount {
  id: string;
  platform: string;
  name: string;
  isConfigured: boolean;
  lastActivity?: number;
}

export interface GatewayAdapter {
  /** Platform identifier */
  readonly platform: "whatsapp" | "telegram" | "discord" | "slack" | "imessage";

  /** List configured accounts for this platform */
  listAccounts(): Promise<PlatformAccount[]>;

  /** Get a specific account by ID */
  getAccount(accountId: string): Promise<PlatformAccount>;

  /** Send an outbound message */
  sendMessage(message: OutboundMessage): Promise<OutboundResult>;

  /** Start listening for inbound messages */
  startMonitor(
    onMessage: (msg: InboundMessage) => Promise<void>,
    options?: {
      accountId?: string;
      debounceMs?: number;
    },
  ): Promise<() => Promise<void>>; // Returns stop function

  /** Check if adapter is ready (authenticated, connected) */
  isReady(): Promise<boolean>;

  /** Health check for the platform connection */
  healthCheck(): Promise<{
    status: "ok" | "degraded" | "down";
    message?: string;
  }>;
}

/**
 * Factory to create or get an adapter instance
 */
export interface GatewayAdapterFactory {
  createAdapter(config: Record<string, unknown>): Promise<GatewayAdapter>;
}
