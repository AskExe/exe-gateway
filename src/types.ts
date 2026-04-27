/**
 * Gateway types — normalized messaging, permissions, and adapter interfaces.
 *
 * The gateway routes messages from external platforms (WhatsApp, Signal)
 * to internal employees with per-adapter permission enforcement.
 */

/** Supported gateway platforms */
export type GatewayPlatform = "whatsapp" | "signal" | "webchat" | "email" | "webhook" | "telegram" | "discord" | "imessage" | "slack";

/** Data categories for agent/wiki retrieval filtering */
export type DataCategory =
  | "message"
  | "location"
  | "read_receipt"
  | "contact_sync"
  | "group"
  | "reaction"
  | "call_log"
  | "history_sync"
  | "edit"
  | "contact_card"
  | "forwarded";

/** Normalized message from any platform */
export interface NormalizedMessage {
  messageId: string;
  platform: GatewayPlatform;
  senderId: string;
  senderName?: string;
  senderPhone?: string;
  senderEmail?: string;
  channelId: string;
  chatType: "direct" | "group";
  text: string;
  timestamp: string;
  media?: MediaAttachment[];
  replyTo?: {
    messageId: string;
    text: string;
    senderId: string;
  };
  threadId?: string;
  accountId?: string;
  raw: unknown;

  /** Data category for agent/wiki retrieval — defaults to "message" */
  dataCategory?: DataCategory;

  /** True for messages imported via history sync — don't trigger automations */
  isHistorical?: boolean;

  /** Location share (static or live) */
  location?: {
    latitude: number;
    longitude: number;
    address?: string;
    venueName?: string;
    isLive?: boolean;
  };

  /** Read receipt status update */
  readReceipt?: {
    messageId: string;
    status: "sent" | "delivered" | "read";
    timestamp: string;
    readBy?: string;
  };

  /** Contact sync entry (bulk import on first link) */
  contactSync?: {
    name: string;
    phone: string;
    pushName?: string;
  };

  /** Group metadata */
  groupInfo?: {
    groupId: string;
    groupName: string;
    participants: string[];
    admins: string[];
    description?: string;
  };

  /** Message reaction */
  reaction?: {
    emoji: string;
    targetMessageId: string;
    reactedBy: string;
    timestamp: string;
  };

  /** Call log entry */
  callLog?: {
    callType: "voice" | "video";
    status: "offered" | "accepted" | "rejected" | "missed" | "timeout";
    duration?: number;
    caller: string;
    callee: string;
    timestamp: string;
    isGroup?: boolean;
  };
}

export interface MediaAttachment {
  type: "image" | "video" | "audio" | "document";
  url?: string;
  localPath?: string;
  fileName?: string;
}

/** Per-adapter permission levels */
export interface AdapterPermissions {
  canRead: boolean;
  canWrite: boolean;
  canExecute: boolean;
}

/** Full-access permissions (Signal — founder's command channel) */
export const FULL_ACCESS: AdapterPermissions = {
  canRead: true,
  canWrite: true,
  canExecute: true,
};

/** Read-only permissions (WhatsApp — monitoring/status channel) */
export const READ_ONLY: AdapterPermissions = {
  canRead: true,
  canWrite: false,
  canExecute: false,
};

/** Platform adapter config */
export interface PlatformConfig {
  platform: GatewayPlatform;
  permissions: AdapterPermissions;
  credentials: Record<string, string>;
  rateLimit?: number;
}

/** Send options for responses */
export interface SendOptions {
  replyToMessageId?: string;
  media?: { type: string; url: string; caption?: string };
}

/** Platform adapter — thin wrapper around OpenClaw extension */
export interface PlatformAdapter {
  readonly platform: GatewayPlatform;
  readonly accountName?: string;
  connect(config: PlatformConfig): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void;
  sendText(
    channelId: string,
    text: string,
    options?: SendOptions,
  ): Promise<void>;
  sendTyping(channelId: string): Promise<void>;
  healthCheck(): Promise<{ connected: boolean; latencyMs?: number }>;
}

/** Route matching conditions */
export interface RouteMatch {
  platform?: GatewayPlatform | GatewayPlatform[];
  channelId?: string | string[];
  senderId?: string;
  textPattern?: string;
}

/** Failover tier — controls how aggressively we cascade */
export type FailoverTier = "full" | "standard" | "basic";

/** Route config — maps incoming messages to employees */
export interface RouteConfig {
  name: string;
  match: RouteMatch;
  target: string;
  modelTier: "haiku" | "sonnet" | "opus";
  permissions: AdapterPermissions;
  maxResponseMs?: number;
  failoverTier?: FailoverTier;
  runtime?: "api-direct" | "claude-code";
}

/** Gateway configuration */
export interface GatewayConfig {
  routes: RouteConfig[];
  defaultRoute: string;
  defaultModelTier: "haiku" | "sonnet" | "opus";
  defaultPermissions: AdapterPermissions;
}

// Tool classifications by permission level
export const READ_TOOLS = [
  "ask_team_memory",
  "recall_my_memory",
  "list_tasks",
  "get_session_context",
  "list_reminders",
  "query_conversations",
] as const;

export const WRITE_TOOLS = [
  "create_task",
  "update_task",
  "send_message",
  "store_memory",
  "store_behavior",
  "create_reminder",
  "complete_reminder",
] as const;

export const EXECUTE_TOOLS = ["close_task"] as const;
