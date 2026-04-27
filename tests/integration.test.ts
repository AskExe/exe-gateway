/**
 * Gateway integration tests.
 *
 * Tests the full message flow: adapter → router → permission guard → response.
 * Uses mock adapters (no real WhatsApp/Signal connections).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { routeMessage } from "../src/router.js";
import {
  guardToolUseBlocks,
  buildPermissionContext,
  checkToolPermission,
  type ToolUseBlock,
} from "../src/permission-guard.js";
import {
  filterToolsForPermissions,
  buildExecAssistantSystemPrompt,
  buildExecAssistantTools,
} from "../src/bot-runtime.js";
import {
  FULL_ACCESS,
  READ_ONLY,
  type GatewayConfig,
  type NormalizedMessage,
  type AdapterPermissions,
} from "../src/types.js";

// --- Helpers ---

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: "msg-test",
    platform: "signal",
    senderId: "+1-555-FOUNDER",
    channelId: "+1-555-FOUNDER",
    chatType: "direct",
    text: "what did yoshi work on today?",
    timestamp: new Date().toISOString(),
    raw: {},
    ...overrides,
  };
}

function makeToolBlock(name: string): ToolUseBlock {
  return { type: "tool_use", id: `call_${name}`, name, input: {} };
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
      name: "Founder WhatsApp",
      match: { platform: "whatsapp", senderId: "\\+1-555-FOUNDER" },
      target: "exec-assistant",
      modelTier: "opus",
      permissions: READ_ONLY,
    },
  ],
  defaultRoute: "receptionist",
  defaultModelTier: "sonnet",
  defaultPermissions: READ_ONLY,
};

// --- Integration scenarios ---

describe("Integration: Signal message → full access flow", () => {
  it("routes Signal from founder to exec-assistant with full access", () => {
    const msg = makeMsg({ platform: "signal", senderId: "+1-555-FOUNDER" });
    const route = routeMessage(msg, gatewayConfig);

    expect(route.employee).toBe("exec-assistant");
    expect(route.permissions).toEqual(FULL_ACCESS);
    expect(route.modelTier).toBe("opus");
  });

  it("allows read tools from Signal", () => {
    const msg = makeMsg({ platform: "signal" });
    const route = routeMessage(msg, gatewayConfig);
    const result = checkToolPermission("ask_team_memory", route.permissions);
    expect(result.allowed).toBe(true);
  });

  it("allows write tools from Signal", () => {
    const msg = makeMsg({ platform: "signal" });
    const route = routeMessage(msg, gatewayConfig);
    const result = checkToolPermission("create_task", route.permissions);
    expect(result.allowed).toBe(true);
  });

  it("allows execute tools from Signal", () => {
    const msg = makeMsg({ platform: "signal" });
    const route = routeMessage(msg, gatewayConfig);
    const result = checkToolPermission("close_task", route.permissions);
    expect(result.allowed).toBe(true);
  });

  it("Signal write command → EA creates task → allowed", () => {
    const msg = makeMsg({ platform: "signal", text: "create a task for yoshi" });
    const route = routeMessage(msg, gatewayConfig);

    const blocks = [makeToolBlock("create_task")];
    const guard = guardToolUseBlocks(blocks, route.permissions);

    expect(guard.allowed).toHaveLength(1);
    expect(guard.blocked).toHaveLength(0);
  });
});

describe("Integration: WhatsApp message → read-only flow", () => {
  it("routes WhatsApp from founder to exec-assistant with read-only", () => {
    const msg = makeMsg({ platform: "whatsapp", senderId: "+1-555-FOUNDER" });
    const route = routeMessage(msg, gatewayConfig);

    expect(route.employee).toBe("exec-assistant");
    expect(route.permissions).toEqual(READ_ONLY);
  });

  it("allows read tools from WhatsApp", () => {
    const msg = makeMsg({ platform: "whatsapp", senderId: "+1-555-FOUNDER" });
    const route = routeMessage(msg, gatewayConfig);
    const result = checkToolPermission("ask_team_memory", route.permissions);
    expect(result.allowed).toBe(true);
  });

  it("BLOCKS write tools from WhatsApp", () => {
    const msg = makeMsg({ platform: "whatsapp", senderId: "+1-555-FOUNDER" });
    const route = routeMessage(msg, gatewayConfig);
    const result = checkToolPermission("create_task", route.permissions);
    expect(result.allowed).toBe(false);
    expect(result.requiredPermission).toBe("canWrite");
  });

  it("WhatsApp write command → BLOCKED by permission guard", () => {
    const msg = makeMsg({
      platform: "whatsapp",
      senderId: "+1-555-FOUNDER",
      text: "create a task for yoshi to fix the bug",
    });
    const route = routeMessage(msg, gatewayConfig);

    const blocks = [
      makeToolBlock("ask_team_memory"),
      makeToolBlock("create_task"),
      makeToolBlock("send_message"),
    ];
    const guard = guardToolUseBlocks(blocks, route.permissions);

    expect(guard.allowed).toHaveLength(1);
    expect(guard.allowed[0]!.name).toBe("ask_team_memory");
    expect(guard.blocked).toHaveLength(2);
    expect(guard.blocked.map((b) => b.check.tool)).toEqual([
      "create_task",
      "send_message",
    ]);
  });
});

describe("Integration: Both platforms share same exec-assistant target", () => {
  it("both Signal and WhatsApp route to same employee", () => {
    const signalRoute = routeMessage(
      makeMsg({ platform: "signal", senderId: "+1-555-FOUNDER" }),
      gatewayConfig,
    );
    const whatsappRoute = routeMessage(
      makeMsg({ platform: "whatsapp", senderId: "+1-555-FOUNDER" }),
      gatewayConfig,
    );

    expect(signalRoute.employee).toBe("exec-assistant");
    expect(whatsappRoute.employee).toBe("exec-assistant");
    // Same target, different permissions
    expect(signalRoute.permissions).not.toEqual(whatsappRoute.permissions);
  });
});

describe("Integration: Permission context injection", () => {
  it("Signal gets FULL ACCESS context", () => {
    const ctx = buildPermissionContext("signal", FULL_ACCESS);
    expect(ctx).toContain("FULL ACCESS");
    expect(ctx).toContain("read, write, and execute");
  });

  it("WhatsApp gets READ-ONLY context", () => {
    const ctx = buildPermissionContext("whatsapp", READ_ONLY);
    expect(ctx).toContain("READ-ONLY");
    expect(ctx).toContain("Signal for commands");
  });

  it("exec-assistant system prompt includes permission info", () => {
    const signalPrompt = buildExecAssistantSystemPrompt("signal", FULL_ACCESS);
    expect(signalPrompt).toContain("write access");

    const whatsappPrompt = buildExecAssistantSystemPrompt("whatsapp", READ_ONLY);
    expect(whatsappPrompt).toContain("READ-ONLY");
    expect(whatsappPrompt).toContain("Signal");
  });
});

describe("Integration: Tool filtering for permissions", () => {
  const allTools = buildExecAssistantTools();

  it("full access exposes all tools", () => {
    const filtered = filterToolsForPermissions(allTools, FULL_ACCESS);
    expect(filtered.length).toBe(allTools.length);
  });

  it("read-only exposes only read tools", () => {
    const filtered = filterToolsForPermissions(allTools, READ_ONLY);
    const names = filtered.map((t) => t.name);

    expect(names).toContain("ask_team_memory");
    expect(names).toContain("recall_my_memory");
    expect(names).toContain("list_tasks");
    expect(names).not.toContain("create_task");
    expect(names).not.toContain("send_message");
    expect(names).not.toContain("close_task");
  });

  it("read+write (no execute) filters correctly", () => {
    const perms: AdapterPermissions = {
      canRead: true,
      canWrite: true,
      canExecute: false,
    };
    const filtered = filterToolsForPermissions(allTools, perms);
    const names = filtered.map((t) => t.name);

    expect(names).toContain("ask_team_memory");
    expect(names).toContain("create_task");
    expect(names).not.toContain("close_task");
  });
});

describe("Integration: Unmatched sender defaults to receptionist", () => {
  it("unknown sender on WhatsApp → receptionist with read-only", () => {
    const msg = makeMsg({
      platform: "whatsapp",
      senderId: "+1-555-STRANGER",
    });
    const route = routeMessage(msg, gatewayConfig);

    expect(route.employee).toBe("receptionist");
    expect(route.permissions).toEqual(READ_ONLY);
    expect(route.routeName).toBe("default");
  });

  it("unknown sender blocked from all write tools", () => {
    const msg = makeMsg({
      platform: "whatsapp",
      senderId: "+1-555-STRANGER",
    });
    const route = routeMessage(msg, gatewayConfig);

    const blocks = [
      makeToolBlock("create_task"),
      makeToolBlock("send_message"),
      makeToolBlock("store_memory"),
      makeToolBlock("update_task"),
    ];
    const guard = guardToolUseBlocks(blocks, route.permissions);
    expect(guard.allowed).toHaveLength(0);
    expect(guard.blocked).toHaveLength(4);
  });
});
