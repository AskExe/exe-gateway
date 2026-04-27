/**
 * Gateway — top-level orchestrator composing all Phase 1-4 modules.
 *
 * Message flow:
 * 1. Adapter receives message → NormalizedMessage
 * 2. Rate limit check (reject if over limit)
 * 3. Customer identity resolution
 * 4. Route message (router.ts)
 * 5. Bot registry lookup → correct BotRuntime
 * 6. Session persistence (load/resume conversation)
 * 7. BotRuntime.processMessage (with permission guard)
 * 8. Record analytics + tokens
 * 9. Send response back through adapter
 *
 * All Phase 2/3 modules are optional — gateway works with just
 * Phase 1 if nothing else is configured.
 */

import type {
  GatewayConfig,
  NormalizedMessage,
  PlatformAdapter,
  PlatformConfig,
} from "./types.js";
import { getHooks } from "./hooks.js";
import { routeMessage } from "./router.js";
import type { BotRegistry } from "./bot-registry.js";
import type { RateLimiter } from "./rate-limiter.js";
import type { SessionStore } from "./session-store.js";
import type { AnalyticsCollector } from "./analytics.js";
import type { AlertMonitor } from "./alerts.js";
import type { FailoverCascade } from "./failover.js";
import type { CustomerStore } from "./customer-store.js";
import { buildDegradationMessage } from "./reliability.js";
import { initCRMBridge } from "./crm-bridge.js";

export interface GatewayOptions {
  config: GatewayConfig;
  platformConfigs: Map<string, PlatformConfig>;
  botRegistry: BotRegistry;
  failover?: FailoverCascade;
  sessionStore?: SessionStore;
  analytics?: AnalyticsCollector;
  alertMonitor?: AlertMonitor;
  rateLimiter?: RateLimiter;
  customerStore?: CustomerStore;
  autoReply?: AutoReplyConfig;
}

/** Auto-reply configuration — OFF by default, allowlist-gated */
export interface AutoReplyConfig {
  /** Master switch. Default: false. Must be true for any auto-reply. */
  enabled: boolean;
  /** Message text to send. Default: "Received." */
  message?: string;
  /** Only auto-reply in these specific groups. Empty = no group replies. */
  allowGroups?: string[];
  /** Only auto-reply to these specific contacts (phone or JID). Empty = no DM replies. */
  allowContacts?: string[];
  /** Hours between replies to same contact. Default: 24 */
  cooldownHours?: number;
  /** Max total auto-replies per day. Default: 20 */
  dailyCap?: number;
  /** Only reply to DMs, never groups (overrides allowGroups). Default: false */
  dmOnly?: boolean;
}

export class Gateway {
  private config: GatewayConfig;
  private adapters = new Map<string, PlatformAdapter>();
  private platformConfigs: Map<string, PlatformConfig>;
  private botRegistry: BotRegistry;
  private rateLimiter?: RateLimiter;
  private sessionStore?: SessionStore;
  private analytics?: AnalyticsCollector;
  private alertMonitor?: AlertMonitor;
  private failover?: FailoverCascade;
  private customerStore?: CustomerStore;
  private startedAt = 0;

  // Auto-reply: configurable via GatewayOptions, OFF by default
  private autoReplyLog = new Map<string, number>();
  private autoReplyCount = 0;
  private autoReplyConfig: AutoReplyConfig = { enabled: false };

  constructor(options: GatewayOptions) {
    if (options.autoReply) {
      this.autoReplyConfig = { ...this.autoReplyConfig, ...options.autoReply };
      if (this.autoReplyConfig.enabled) {
        const groups = this.autoReplyConfig.allowGroups?.length ?? 0;
        const contacts = this.autoReplyConfig.allowContacts?.length ?? 0;
        console.log(
          `[gateway] Auto-reply ON: "${this.autoReplyConfig.message ?? "Received."}" ` +
          `(${groups} groups, ${contacts} contacts, cap=${this.autoReplyConfig.dailyCap ?? 20}/day, ` +
          `cooldown=${this.autoReplyConfig.cooldownHours ?? 24}h)`
        );
      }
    }
    this.config = options.config;
    this.platformConfigs = options.platformConfigs;
    this.botRegistry = options.botRegistry;
    this.rateLimiter = options.rateLimiter;
    this.sessionStore = options.sessionStore;
    this.analytics = options.analytics;
    this.alertMonitor = options.alertMonitor;
    this.failover = options.failover;
    this.customerStore = options.customerStore;
  }

  registerAdapter(adapter: PlatformAdapter): void {
    const key = `${adapter.platform}:${adapter.accountName ?? "default"}`;
    this.adapters.set(key, adapter);
    adapter.onMessage((msg) => {
      // Stamp accountId from the adapter that produced this message
      msg.accountId = msg.accountId ?? adapter.accountName ?? "default";
      return this.handleMessage(msg);
    });
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    initCRMBridge();
    const startPromises: Promise<void>[] = [];

    for (const [platform, adapter] of this.adapters) {
      const config = this.platformConfigs.get(platform);
      if (!config) {
        console.error(`[gateway] No config for platform: ${platform}`);
        continue;
      }
      console.log(`[gateway] Connecting ${platform}...`);
      startPromises.push(
        adapter.connect(config).then(() => {
          console.log(`[gateway] ${platform} connected`);
        }).catch((err) => {
          console.error(`[gateway] ${platform} connection failed:`, err);
          this.alertMonitor?.alertAdapterDisconnected(
            platform,
            err instanceof Error ? err.message : String(err),
          );
        }),
      );
    }

    await Promise.allSettled(startPromises);
    console.log(
      `[gateway] Started with ${this.botRegistry.list().length} bots: ${this.botRegistry.list().join(", ")}`,
    );
  }

  async stop(): Promise<void> {
    const stopPromises = [...this.adapters.values()].map((a) =>
      a.disconnect(),
    );
    await Promise.allSettled(stopPromises);
    console.log("[gateway] Stopped");
  }

  private async handleMessage(msg: NormalizedMessage): Promise<void> {
    const start = Date.now();

    // 1. Rate limit check
    if (this.rateLimiter) {
      const limitResult = this.rateLimiter.check(msg.senderId);
      if (!limitResult.allowed) {
        const adapter = this.resolveAdapter(msg);
        if (adapter) {
          await adapter.sendText(msg.channelId, limitResult.reason ?? "Please slow down.");
        }
        return;
      }
    }

    // 2. Customer identity resolution
    this.customerStore?.resolve(msg.platform, msg.senderId);

    // 2b. Pipeline ingest — fan out inbound message to all sinks (CRM, memory, wiki, conversation store)
    getHooks().onIngest?.(msg)?.catch((err: unknown) => {
      console.error("[gateway] Pipeline inbound ingest error:", err);
    });

    // 2c. Store in PostgreSQL (standalone — no hooks needed)
    try {
      const { storeInboundMessage } = await import("./pipeline-store.js");
      storeInboundMessage(msg).catch((err: unknown) => {
        console.error("[gateway] PostgreSQL store error:", err);
      });
    } catch {
      // pipeline-store not available or DB not configured — silent
    }

    // 3. Route message
    const route = routeMessage(msg, this.config);
    console.log(
      `[gateway] ${msg.platform}/${msg.senderId} → ${route.employee} (${route.routeName})`,
    );

    getHooks().onEvent?.({
      type: "gateway_message",
      platform: msg.platform,
      senderId: msg.senderId,
      botId: route.employee,
      timestamp: new Date().toISOString(),
    });

    // 4. Bot registry lookup
    const bot = this.botRegistry.get(route.employee);
    if (!bot) {
      // No bot — auto-reply ONLY if ALL safety checks pass
      // SAFETY: every check must pass or we silently drop (no reply)
      const shouldAutoReply = this.checkAutoReplySafety(msg);
      if (shouldAutoReply) {
        const adapter = this.resolveAdapter(msg);
        if (adapter) {
          const delaySec = 3 + Math.random() * 12;
          const replyMsg = this.autoReplyConfig.message ?? "Received.";
          console.log(`[gateway] Auto-reply "${replyMsg}" to ${msg.senderId} in ${delaySec.toFixed(1)}s`);
          setTimeout(async () => {
            try {
              await adapter.sendTyping(msg.channelId);
              await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
              await adapter.sendText(msg.channelId, replyMsg);
              this.autoReplyLog.set(msg.senderId, Date.now());
              this.autoReplyCount++;
            } catch (err) {
              console.error(`[gateway] Auto-reply failed:`, err instanceof Error ? err.message : err);
            }
          }, delaySec * 1000);
        }
      }
      return;
    }

    const adapter = this.resolveAdapter(msg);
    if (!adapter) return;

    // 5. Send typing indicator
    await adapter.sendTyping(msg.channelId);

    // 6. Session persistence — load/resume
    const session = this.sessionStore?.getOrCreate(
      msg.senderId,
      route.employee,
      msg.platform,
    );
    if (session) {
      this.sessionStore!.addMessage(session.sessionId, {
        role: "user",
        content: msg.text,
      });
    }

    // 7. Analytics — conversation start
    if (session?.messageCount === 1) {
      this.analytics?.conversationStarted(msg.platform, route.employee);
    }

    try {
      // 8. Process message through bot runtime
      const response = await bot.processMessage(msg, route.permissions);
      const latencyMs = Date.now() - start;

      // 9. Session — record assistant response
      if (session) {
        this.sessionStore!.addMessage(session.sessionId, {
          role: "assistant",
          content: response,
        });
      }

      // 10. Analytics — record response
      this.analytics?.responseRecorded(
        msg.platform,
        route.employee,
        latencyMs,
        0, // Token counts not available from BotRuntime yet
        0,
        "anthropic",
        true,
      );

      // 11. Alert monitor — record success
      this.alertMonitor?.recordEvent(latencyMs, true);

      // 12. Send response
      await adapter.sendText(msg.channelId, response, {
        replyToMessageId: msg.messageId,
      });

      // 13. Pipeline ingest with response — fan out conversation to all sinks
      getHooks().onIngest?.(msg, response, route.employee)?.catch((err: unknown) => {
        console.error("[gateway] Pipeline conversation ingest error:", err);
      });
    } catch (err) {
      const latencyMs = Date.now() - start;
      this.alertMonitor?.recordEvent(latencyMs, false);
      this.analytics?.responseRecorded(
        msg.platform,
        route.employee,
        latencyMs,
        0,
        0,
        "anthropic",
        false,
      );

      console.error(`[gateway] Error processing message:`, err);
      await adapter.sendText(
        msg.channelId,
        buildDegradationMessage(),
      );
    }
  }

  /** Resolve adapter for a message — compound key with fallback */
  private resolveAdapter(msg: NormalizedMessage): PlatformAdapter | undefined {
    const key = `${msg.platform}:${msg.accountId ?? "default"}`;
    return this.adapters.get(key) ?? this.adapters.get(`${msg.platform}:default`);
  }

  /**
   * Auto-reply safety gate — EVERY check must pass or we silently drop.
   * This prevents the 1,582-message spam incident from 2026-04-27.
   */
  private checkAutoReplySafety(msg: NormalizedMessage): boolean {
    const cfg = this.autoReplyConfig;

    // GATE 1: Auto-reply must be explicitly enabled (default: OFF)
    if (!cfg.enabled) {
      return false;
    }

    // GATE 2: NEVER reply to historical/sync messages
    if (msg.isHistorical) {
      return false;
    }

    // GATE 3: NEVER reply to our own messages
    if ((msg as any).key?.fromMe || msg.senderId === "status@broadcast") {
      return false;
    }

    // GATE 4: NEVER reply to system messages (no text)
    if (!msg.text || msg.text.trim().length === 0) {
      return false;
    }

    // GATE 5: Skip read receipts, reactions, calls, contact cards, etc.
    if (msg.dataCategory && msg.dataCategory !== "message") {
      return false;
    }

    // GATE 6: Group vs DM allowlist check
    const isGroup = msg.chatType === "group";
    if (isGroup) {
      // dmOnly blocks ALL groups regardless of allowlist
      if (cfg.dmOnly) return false;
      // Only reply in explicitly allowlisted groups
      if (!cfg.allowGroups?.length || !cfg.allowGroups.includes(msg.channelId)) {
        return false;
      }
    } else {
      // DM — only reply to explicitly allowlisted contacts (if list exists)
      if (cfg.allowContacts?.length) {
        const phoneMatch = cfg.allowContacts.some(c =>
          msg.senderId.includes(c.replace(/[^0-9]/g, "")) || c === msg.senderId
        );
        if (!phoneMatch) return false;
      }
      // If no allowContacts list AND no allowGroups list, block everything
      // (must have at least one allowlist to send ANY replies)
      if (!cfg.allowContacts?.length && !cfg.allowGroups?.length) {
        return false;
      }
    }

    // GATE 7: Rate limit — cooldown per contact
    const cooldownMs = (cfg.cooldownHours ?? 24) * 3_600_000;
    const lastReply = this.autoReplyLog.get(msg.senderId);
    if (lastReply && Date.now() - lastReply < cooldownMs) {
      return false;
    }

    // GATE 8: Daily cap
    const dailyCap = cfg.dailyCap ?? 20;
    if (this.autoReplyCount >= dailyCap) {
      console.warn(`[gateway] Auto-reply daily cap reached (${dailyCap}). No more today.`);
      return false;
    }

    return true;
  }

  /** Health check all adapters + provider health */
  async healthCheck(): Promise<{
    adapters: Map<string, { connected: boolean; latencyMs?: number }>;
    providers?: Array<{ name: string; state: string; failureRate: number }>;
    bots: string[];
    uptime: number;
    sessions?: { active: number; closed: number; totalMessages: number };
    alerts?: number;
  }> {
    const adapterHealth = new Map<
      string,
      { connected: boolean; latencyMs?: number }
    >();
    for (const [key, adapter] of this.adapters) {
      adapterHealth.set(key, await adapter.healthCheck());
    }

    return {
      adapters: adapterHealth,
      providers: this.failover?.getProviderHealth(),
      bots: this.botRegistry.list(),
      uptime: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
      sessions: this.sessionStore?.stats(),
      alerts: this.alertMonitor?.getActiveAlerts().length,
    };
  }
}
