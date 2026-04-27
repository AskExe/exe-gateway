import { describe, it, expect } from "vitest";
import { routeMessage, validateGatewayConfig } from "../src/router.js";
import {
  FULL_ACCESS,
  READ_ONLY,
  type GatewayConfig,
  type NormalizedMessage,
} from "../src/types.js";

function makeMessage(
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage {
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

const testConfig: GatewayConfig = {
  routes: [
    {
      name: "Founder Signal",
      match: { platform: "signal", senderId: "\\+1-555-FOUNDER" },
      target: "exec-assistant",
      modelTier: "opus",
      permissions: FULL_ACCESS,
    },
    {
      name: "Founder WhatsApp",
      match: { platform: "whatsapp", senderId: "\\+1-555-FOUNDER" },
      target: "exec-assistant",
      modelTier: "opus",
      permissions: READ_ONLY,
    },
    {
      name: "Support channel",
      match: { platform: "whatsapp", channelId: "support-ch" },
      target: "support-bot",
      modelTier: "sonnet",
      permissions: READ_ONLY,
    },
  ],
  defaultRoute: "receptionist",
  defaultModelTier: "sonnet",
  defaultPermissions: READ_ONLY,
};

describe("routeMessage", () => {
  it("routes Signal from founder to exec-assistant with full access", () => {
    const msg = makeMessage({
      platform: "signal",
      senderId: "+1-555-FOUNDER",
    });
    const result = routeMessage(msg, testConfig);
    expect(result.employee).toBe("exec-assistant");
    expect(result.modelTier).toBe("opus");
    expect(result.permissions).toEqual(FULL_ACCESS);
    expect(result.routeName).toBe("Founder Signal");
  });

  it("routes WhatsApp from founder to exec-assistant with read-only", () => {
    const msg = makeMessage({
      platform: "whatsapp",
      senderId: "+1-555-FOUNDER",
    });
    const result = routeMessage(msg, testConfig);
    expect(result.employee).toBe("exec-assistant");
    expect(result.permissions).toEqual(READ_ONLY);
    expect(result.routeName).toBe("Founder WhatsApp");
  });

  it("routes support channel messages to support-bot", () => {
    const msg = makeMessage({
      platform: "whatsapp",
      channelId: "support-ch",
      senderId: "+1-555-RANDOM",
    });
    const result = routeMessage(msg, testConfig);
    expect(result.employee).toBe("support-bot");
    expect(result.modelTier).toBe("sonnet");
  });

  it("falls back to default route for unmatched messages", () => {
    const msg = makeMessage({
      platform: "whatsapp",
      senderId: "+1-555-UNKNOWN",
      channelId: "random-ch",
    });
    const result = routeMessage(msg, testConfig);
    expect(result.employee).toBe("receptionist");
    expect(result.routeName).toBe("default");
    expect(result.permissions).toEqual(READ_ONLY);
  });

  it("uses first matching route when multiple match", () => {
    const config: GatewayConfig = {
      routes: [
        {
          name: "first",
          match: { platform: "signal" },
          target: "employee-a",
          modelTier: "opus",
          permissions: FULL_ACCESS,
        },
        {
          name: "second",
          match: { platform: "signal" },
          target: "employee-b",
          modelTier: "sonnet",
          permissions: READ_ONLY,
        },
      ],
      defaultRoute: "fallback",
      defaultModelTier: "haiku",
      defaultPermissions: READ_ONLY,
    };
    const msg = makeMessage({ platform: "signal" });
    const result = routeMessage(msg, config);
    expect(result.employee).toBe("employee-a");
    expect(result.routeName).toBe("first");
  });

  it("matches textPattern case-insensitively", () => {
    const config: GatewayConfig = {
      routes: [
        {
          name: "help",
          match: { textPattern: "^help" },
          target: "help-bot",
          modelTier: "haiku",
          permissions: READ_ONLY,
        },
      ],
      defaultRoute: "fallback",
      defaultModelTier: "sonnet",
      defaultPermissions: READ_ONLY,
    };
    const msg = makeMessage({ text: "HELP me with something" });
    const result = routeMessage(msg, config);
    expect(result.employee).toBe("help-bot");
  });

  it("matches array of platforms", () => {
    const config: GatewayConfig = {
      routes: [
        {
          name: "multi-platform",
          match: { platform: ["whatsapp", "signal"] },
          target: "multi-bot",
          modelTier: "sonnet",
          permissions: READ_ONLY,
        },
      ],
      defaultRoute: "fallback",
      defaultModelTier: "haiku",
      defaultPermissions: READ_ONLY,
    };
    expect(
      routeMessage(makeMessage({ platform: "whatsapp" }), config).employee,
    ).toBe("multi-bot");
    expect(
      routeMessage(makeMessage({ platform: "signal" }), config).employee,
    ).toBe("multi-bot");
  });

  it("matches array of channelIds", () => {
    const config: GatewayConfig = {
      routes: [
        {
          name: "multi-channel",
          match: { channelId: ["ch-a", "ch-b"] },
          target: "channel-bot",
          modelTier: "haiku",
          permissions: READ_ONLY,
        },
      ],
      defaultRoute: "fallback",
      defaultModelTier: "haiku",
      defaultPermissions: READ_ONLY,
    };
    expect(
      routeMessage(makeMessage({ channelId: "ch-a" }), config).employee,
    ).toBe("channel-bot");
    expect(
      routeMessage(makeMessage({ channelId: "ch-c" }), config).employee,
    ).toBe("fallback");
  });
});

describe("validateGatewayConfig", () => {
  it("returns no warnings for valid config", () => {
    expect(validateGatewayConfig(testConfig)).toEqual([]);
  });

  it("warns on empty routes", () => {
    const config: GatewayConfig = {
      routes: [],
      defaultRoute: "fallback",
      defaultModelTier: "sonnet",
      defaultPermissions: READ_ONLY,
    };
    const warnings = validateGatewayConfig(config);
    expect(warnings).toContainEqual(
      expect.stringContaining("No routes configured"),
    );
  });

  it("warns on duplicate route names", () => {
    const config: GatewayConfig = {
      routes: [
        {
          name: "dup",
          match: { platform: "signal" },
          target: "a",
          modelTier: "opus",
          permissions: FULL_ACCESS,
        },
        {
          name: "dup",
          match: { platform: "whatsapp" },
          target: "b",
          modelTier: "sonnet",
          permissions: READ_ONLY,
        },
      ],
      defaultRoute: "fallback",
      defaultModelTier: "sonnet",
      defaultPermissions: READ_ONLY,
    };
    const warnings = validateGatewayConfig(config);
    expect(warnings).toContainEqual(
      expect.stringContaining('Duplicate route name: "dup"'),
    );
  });

  it("warns on catch-all route that is not last", () => {
    const config: GatewayConfig = {
      routes: [
        {
          name: "catch-all",
          match: {},
          target: "a",
          modelTier: "sonnet",
          permissions: READ_ONLY,
        },
        {
          name: "specific",
          match: { platform: "signal" },
          target: "b",
          modelTier: "opus",
          permissions: FULL_ACCESS,
        },
      ],
      defaultRoute: "fallback",
      defaultModelTier: "sonnet",
      defaultPermissions: READ_ONLY,
    };
    const warnings = validateGatewayConfig(config);
    expect(warnings).toContainEqual(
      expect.stringContaining("matches everything but is not the last route"),
    );
  });

  it("warns on missing default route", () => {
    const config: GatewayConfig = {
      routes: [
        {
          name: "a",
          match: { platform: "signal" },
          target: "b",
          modelTier: "opus",
          permissions: FULL_ACCESS,
        },
      ],
      defaultRoute: "",
      defaultModelTier: "sonnet",
      defaultPermissions: READ_ONLY,
    };
    const warnings = validateGatewayConfig(config);
    expect(warnings).toContainEqual(
      expect.stringContaining("No default route"),
    );
  });
});
