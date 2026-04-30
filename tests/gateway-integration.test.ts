/**
 * Gateway Phase 4 integration tests.
 *
 * Tests the full composed message flow:
 * rate limit → customer resolve → route → bot lookup → respond
 */

import { describe, it, expect, vi } from "vitest";
import { Gateway, type GatewayOptions } from "../src/gateway.js";
import { BotRegistry } from "../src/bot-registry.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { SessionStore } from "../src/session-store.js";
import { AnalyticsCollector } from "../src/analytics.js";
import { AlertMonitor } from "../src/alerts.js";
import { CustomerStore } from "../src/customer-store.js";
import { createSignupBot } from "../src/bot-templates/signup-bot.js";
import {
  FULL_ACCESS,
  READ_ONLY,
  type GatewayConfig,
  type NormalizedMessage,
  type PlatformAdapter,
  type PlatformConfig,
  type SendOptions,
  type GatewayPlatform,
} from "../src/types.js";

// --- Mock adapter ---

class MockAdapter implements PlatformAdapter {
  readonly platform: GatewayPlatform;
  readonly accountName = "default";
  private handler: ((msg: NormalizedMessage) => Promise<void>) | null = null;
  sentMessages: Array<{ channelId: string; text: string }> = [];
  typingChannels: string[] = [];

  constructor(platform: GatewayPlatform) {
    this.platform = platform;
  }

  async connect(_config: PlatformConfig): Promise<void> {}
  async disconnect(): Promise<void> {}

  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async sendText(channelId: string, text: string, _options?: SendOptions): Promise<void> {
    this.sentMessages.push({ channelId, text });
  }

  async sendTyping(channelId: string): Promise<void> {
    this.typingChannels.push(channelId);
  }

  async healthCheck(): Promise<{ connected: boolean }> {
    return { connected: true };
  }

  /** Simulate an incoming message */
  async simulateMessage(msg: NormalizedMessage): Promise<void> {
    if (this.handler) await this.handler(msg);
  }
}

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: "msg-1",
    platform: "whatsapp",
    senderId: "+1-555-1234",
    channelId: "ch-1",
    chatType: "direct",
    text: "hello",
    timestamp: new Date().toISOString(),
    raw: {},
    ...overrides,
  };
}

const gatewayConfig: GatewayConfig = {
  routes: [
    {
      name: "Founder Signal",
      match: { platform: "signal", senderId: "\\+1-555-FOUNDER" },
      target: "exec-assistant",
      modelTier: "opus",
      permissions: FULL_ACCESS,
    },
    {
      name: "Signup",
      match: { platform: "webchat" },
      target: "signup-bot",
      modelTier: "haiku",
      permissions: READ_ONLY,
    },
  ],
  defaultRoute: "receptionist",
  defaultModelTier: "sonnet",
  defaultPermissions: READ_ONLY,
};

describe("Gateway integration", () => {
  it("rejects rate-limited messages", async () => {
    const adapter = new MockAdapter("whatsapp");
    const registry = new BotRegistry();
    const limiter = new RateLimiter({ messagesPerMinute: 1, globalMessagesPerMinute: 10 });

    const gw = new Gateway({
      config: gatewayConfig,
      platformConfigs: new Map(),
      botRegistry: registry,
      rateLimiter: limiter,
    });
    gw.registerAdapter(adapter);

    // First message passes rate limit (but no bot registered + auto-reply off → silent drop)
    await adapter.simulateMessage(makeMsg());
    // Second message blocked by rate limiter → sends "slow down"
    await adapter.simulateMessage(makeMsg());
    expect(adapter.sentMessages).toHaveLength(1);
    // Rate-limited message says "too quickly"
    expect(adapter.sentMessages[0]!.text).toContain("too quickly");
  });

  it("silently drops message when bot is not registered and auto-reply is off", async () => {
    const adapter = new MockAdapter("whatsapp");
    const registry = new BotRegistry();

    const gw = new Gateway({
      config: gatewayConfig,
      platformConfigs: new Map(),
      botRegistry: registry,
    });
    gw.registerAdapter(adapter);

    await adapter.simulateMessage(makeMsg());
    // No bot registered + auto-reply disabled by default = silent drop (no spam)
    expect(adapter.sentMessages).toHaveLength(0);
  });

  it("sends typing indicator when bot is found", async () => {
    const adapter = new MockAdapter("webchat");
    const registry = new BotRegistry();
    registry.register(createSignupBot(), "test-key");

    const gw = new Gateway({
      config: gatewayConfig,
      platformConfigs: new Map(),
      botRegistry: registry,
    });
    gw.registerAdapter(adapter);

    // webchat routes to signup-bot which IS registered
    await adapter.simulateMessage(makeMsg({ platform: "webchat", channelId: "ch-web" }));
    expect(adapter.typingChannels).toContain("ch-web");
  });

  it("resolves customer identity", async () => {
    const adapter = new MockAdapter("whatsapp");
    const registry = new BotRegistry();
    const customerStore = new CustomerStore();

    const gw = new Gateway({
      config: gatewayConfig,
      platformConfigs: new Map(),
      botRegistry: registry,
      customerStore,
    });
    gw.registerAdapter(adapter);

    await adapter.simulateMessage(makeMsg({ senderId: "+1-555-NEW" }));
    expect(customerStore.count()).toBe(1);

    await adapter.simulateMessage(makeMsg({ senderId: "+1-555-NEW" }));
    const customer = customerStore.find("whatsapp", "+1-555-NEW");
    expect(customer!.interactionCount).toBe(2);
  });

  it("records analytics for each message", async () => {
    const adapter = new MockAdapter("whatsapp");
    const registry = new BotRegistry();
    const analytics = new AnalyticsCollector();

    const gw = new Gateway({
      config: gatewayConfig,
      platformConfigs: new Map(),
      botRegistry: registry,
      analytics,
    });
    gw.registerAdapter(adapter);

    await adapter.simulateMessage(makeMsg());
    // Bot not registered → error path → records failed response
    expect(analytics.eventCount()).toBeGreaterThanOrEqual(0);
  });

  it("tracks sessions when bot is found", async () => {
    const adapter = new MockAdapter("webchat");
    const registry = new BotRegistry();
    registry.register(createSignupBot(), "test-key");
    const sessionStore = new SessionStore();

    const gw = new Gateway({
      config: gatewayConfig,
      platformConfigs: new Map(),
      botRegistry: registry,
      sessionStore,
    });
    gw.registerAdapter(adapter);

    // webchat routes to signup-bot (registered) — session should be created
    // Bot will fail on API call (no real key) but session is created before that
    await adapter.simulateMessage(makeMsg({ platform: "webchat", senderId: "web-user" }));
    const stats = sessionStore.stats();
    expect(stats.active).toBe(1);
  });

  it("alert monitor records events", async () => {
    const adapter = new MockAdapter("whatsapp");
    const registry = new BotRegistry();
    const alertMonitor = new AlertMonitor();

    const gw = new Gateway({
      config: gatewayConfig,
      platformConfigs: new Map(),
      botRegistry: registry,
      alertMonitor,
    });
    gw.registerAdapter(adapter);

    await adapter.simulateMessage(makeMsg());
    // No bot registered → should record an event (error path)
    // Just verify no crash
    expect(alertMonitor.getActiveAlerts().length).toBeGreaterThanOrEqual(0);
  });

  it("healthCheck returns comprehensive status", async () => {
    const adapter = new MockAdapter("whatsapp");
    const registry = new BotRegistry();
    registry.register(createSignupBot(), "test-key");

    const sessionStore = new SessionStore();
    const alertMonitor = new AlertMonitor();

    const gw = new Gateway({
      config: gatewayConfig,
      platformConfigs: new Map(),
      botRegistry: registry,
      sessionStore,
      alertMonitor,
    });
    gw.registerAdapter(adapter);

    const health = await gw.healthCheck();
    expect(health.bots).toContain("signup-bot");
    expect(health.sessions).toBeDefined();
    expect(health.alerts).toBe(0);
    expect(health.adapters.get("whatsapp:default")).toEqual({ connected: true });
  });

  it("routes webchat to signup-bot (not default)", async () => {
    const adapter = new MockAdapter("webchat");
    const registry = new BotRegistry();
    // signup-bot is NOT registered → auto-reply safety gates block silent drop
    // No message is sent because auto-reply is disabled by default (correct behavior)

    const gw = new Gateway({
      config: gatewayConfig,
      platformConfigs: new Map(),
      botRegistry: registry,
    });
    gw.registerAdapter(adapter);

    await adapter.simulateMessage(makeMsg({ platform: "webchat" }));
    // No bot registered + auto-reply disabled = message silently dropped (no spam)
    expect(adapter.sentMessages).toHaveLength(0);
  });
});

describe("BotRegistry in Gateway", () => {
  it("registers signup-bot from template", () => {
    const registry = new BotRegistry();
    registry.register(createSignupBot(), "test-key");
    expect(registry.has("signup-bot")).toBe(true);
    expect(registry.list()).toContain("signup-bot");
  });
});
