/**
 * Hook interfaces — injectable callbacks that replace exe-os imports.
 * exe-os will inject real implementations when consuming exe-gateway as a dependency.
 * Standalone users get no-op defaults.
 *
 * Hooks are the MCP contract boundary — exe-gateway emits events,
 * exe-os/exe-crm/exe-wiki consume them. No direct DB access.
 */

import type { NormalizedMessage, GatewayPlatform } from "./types.js";

export interface GatewayEvent {
  type: string;
  platform: string;
  senderId: string;
  botId: string;
  timestamp: string;
}

/** Extracted insight from a conversation — routed to exe-wiki and/or exe-crm */
export interface ConversationInsight {
  /** Unique ID for deduplication */
  id: string;
  /** What kind of insight */
  type: "customer_preference" | "product_feedback" | "support_issue" | "sales_opportunity" | "contact_info" | "topic_summary" | "action_item";
  /** Platform the conversation happened on */
  platform: GatewayPlatform;
  /** Who the insight is about */
  senderId: string;
  senderName?: string;
  /** Customer ID if resolved */
  customerId?: string;
  /** The insight content */
  content: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Source message context */
  sourceMessageId: string;
  sourceText: string;
  /** Agent that processed the conversation */
  agentId?: string;
  agentResponse?: string;
  /** Timestamp */
  timestamp: string;
  /** Optional metadata for routing */
  metadata?: Record<string, unknown>;
}

export interface GatewayHooks {
  /** Called when gateway processes a message. Replaces orgBus.emit from state-bus. */
  onEvent?: (event: GatewayEvent) => void;

  /** Called to fan out inbound messages to sinks (CRM, memory, wiki). Replaces pipelineIngest. */
  onIngest?: (msg: unknown, response?: string, botId?: string) => Promise<void>;

  /** Called to process CRM events through trigger engine. Replaces processCRMEvent. */
  onCRMEvent?: (event: unknown, executor?: unknown, triggers?: unknown[]) => Promise<unknown[]>;

  /** Called on gateway CLI boot for license validation. Replaces assertVpsLicense. Default: no-op (MIT, no license needed). */
  assertLicense?: () => Promise<{ plan: string }>;

  /**
   * Called when an insight is extracted from a conversation.
   * exe-os routes this to exe-wiki (knowledge) and exe-crm (customer data).
   *
   * exe-wiki: topic summaries, product feedback, action items → wiki pages
   * exe-crm: customer preferences, contact info, sales opportunities → CRM records
   */
  onInsight?: (insight: ConversationInsight) => Promise<void>;

  /**
   * Called after a full conversation turn (inbound + response).
   * Provides the raw data for external insight extractors to analyze.
   * This is the "firehose" — onInsight is the filtered output.
   */
  onConversationTurn?: (turn: {
    platform: GatewayPlatform;
    senderId: string;
    senderName?: string;
    customerId?: string;
    inboundText: string;
    agentResponse: string;
    agentId: string;
    messageId: string;
    timestamp: string;
    accountId?: string;
    chatType: "direct" | "group";
    threadId?: number;
  }) => Promise<void>;
}

// Singleton hooks instance — set once at startup
let _hooks: GatewayHooks = {};

export function setHooks(hooks: GatewayHooks): void {
  _hooks = hooks;
}

export function getHooks(): GatewayHooks {
  return _hooks;
}
