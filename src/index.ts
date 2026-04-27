/**
 * exe-os gateway — clean API surface for multi-platform bot deployment.
 *
 * Usage:
 *   import { Gateway, BotRegistry, AnthropicProvider } from "exe-os/gateway";
 */

// Core
export { Gateway, type GatewayOptions } from "./gateway.js";
export { routeMessage, validateGatewayConfig, type RouteResult } from "./router.js";
export { BotRegistry } from "./bot-registry.js";
export { BotRuntime, buildExecAssistantTools, buildExecAssistantSystemPrompt } from "./bot-runtime.js";

// Types
export type {
  GatewayConfig,
  GatewayPlatform,
  DataCategory,
  NormalizedMessage,
  AdapterPermissions,
  PlatformAdapter,
  PlatformConfig,
  RouteConfig,
  SendOptions,
  FailoverTier,
} from "./types.js";
export { FULL_ACCESS, READ_ONLY, READ_TOOLS, WRITE_TOOLS, EXECUTE_TOOLS } from "./types.js";

// Bot templates
export type { BotTemplate } from "./bot-templates/types.js";
export { createSignupBot } from "./bot-templates/signup-bot.js";
export { createReceptionist } from "./bots/receptionist.js";

// Providers
export { AnthropicProvider } from "./providers/anthropic.js";
export { OpenAICompatProvider } from "./providers/openai-compat.js";
export { OllamaProvider } from "./providers/ollama.js";
export type {
  LLMProvider,
  NormalizedResponse,
  NormalizedContentBlock,
  NormalizedLLMMessage,
  NormalizedTool,
  NormalizedMessageParams,
} from "./providers/types.js";

// Adapters
export { WhatsAppAdapter } from "./adapters/whatsapp.js";
export { SignalAdapter } from "./adapters/signal.js";
export { WebChatAdapter } from "./adapters/webchat.js";
export { TelegramAdapter } from "./adapters/telegram.js";
export { DiscordAdapter } from "./adapters/discord.js";
export { SlackAdapter } from "./adapters/slack.js";
export { IMessageAdapter } from "./adapters/imessage.js";

// Reliability
export { RateLimiter } from "./rate-limiter.js";
export { CircuitBreaker, retryWithBackoff } from "./reliability.js";
export { FailoverCascade, FailoverExhaustedError } from "./failover.js";
export { SessionStore } from "./session-store.js";
export { AnalyticsCollector } from "./analytics.js";
export { AlertMonitor, formatAlert } from "./alerts.js";
export { CustomerStore } from "./customer-store.js";

// Permission guard
export { guardToolUseBlocks, checkToolPermission, buildPermissionContext } from "./permission-guard.js";

// CRM bridge
export { initCRMBridge, pushConversationToCRM, pushInboundMessageToCRM, pushGatewayEventToCRM, isCRMBridgeEnabled, findPersonByContact, createPerson } from "./crm-bridge.js";
export type { GatewayEventParams } from "./crm-bridge.js";

// Contact sync
export { ensureCRMContact } from "./contact-sync.js";

// CRM webhook adapter
export { createCRMWebhookHandler, parseTwentyWebhook } from "./adapters/crm-webhook.js";

// WhatsApp multi-account
export {
  loadAccounts as loadWhatsAppAccounts,
  getAccountByName,
  getDefaultAccount,
  type WhatsAppAccountConfig,
} from "./whatsapp-accounts.js";

// Outbound rate limiting
export { OutboundLimiter, PLATFORM_LIMITS, type PlatformLimits } from "./outbound-limiter.js";

// Database
export { initPool, getPool, closePool, type DBConfig } from "./db.js";

// Conversation store (PostgreSQL)
export {
  initConversationStore,
  upsertAccount,
  upsertContact,
  upsertThread,
  storeMessage,
  getThreadMessages,
  getThreads,
  getContacts,
  getContactDetail,
  linkContactToCRM,
  type GatewayMessage,
  type GatewayContact,
  type ThreadWithContact,
  type StoreMessageParams,
} from "./conversation-store.js";

// Pipeline store (NormalizedMessage → PostgreSQL bridge)
export { storeInboundMessage, storeConversation } from "./pipeline-store.js";
