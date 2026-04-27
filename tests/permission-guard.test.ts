import { describe, it, expect } from "vitest";
import {
  checkToolPermission,
  guardToolUseBlocks,
  buildPermissionContext,
  classifyTool,
  type ToolUseBlock,
} from "../src/permission-guard.js";
import {
  FULL_ACCESS,
  READ_ONLY,
  type AdapterPermissions,
} from "../src/types.js";

describe("classifyTool", () => {
  it("classifies read tools", () => {
    expect(classifyTool("ask_team_memory")).toBe("canRead");
    expect(classifyTool("recall_my_memory")).toBe("canRead");
    expect(classifyTool("list_tasks")).toBe("canRead");
    expect(classifyTool("list_reminders")).toBe("canRead");
  });

  it("classifies write tools", () => {
    expect(classifyTool("create_task")).toBe("canWrite");
    expect(classifyTool("send_message")).toBe("canWrite");
    expect(classifyTool("store_memory")).toBe("canWrite");
    expect(classifyTool("update_task")).toBe("canWrite");
  });

  it("classifies execute tools", () => {
    expect(classifyTool("close_task")).toBe("canExecute");
  });

  it("returns null for unknown tools", () => {
    expect(classifyTool("hack_mainframe")).toBeNull();
    expect(classifyTool("")).toBeNull();
  });
});

describe("checkToolPermission", () => {
  describe("Signal (full access)", () => {
    it("allows read tools", () => {
      const result = checkToolPermission("ask_team_memory", FULL_ACCESS);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("allows write tools", () => {
      const result = checkToolPermission("create_task", FULL_ACCESS);
      expect(result.allowed).toBe(true);
    });

    it("allows execute tools", () => {
      const result = checkToolPermission("close_task", FULL_ACCESS);
      expect(result.allowed).toBe(true);
    });

    it("blocks unknown tools", () => {
      const result = checkToolPermission("hack_mainframe", FULL_ACCESS);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in the allowed tool list");
    });
  });

  describe("WhatsApp (read-only)", () => {
    it("allows read tools", () => {
      const result = checkToolPermission("ask_team_memory", READ_ONLY);
      expect(result.allowed).toBe(true);
    });

    it("blocks write tools", () => {
      const result = checkToolPermission("create_task", READ_ONLY);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("canWrite");
    });

    it("blocks execute tools", () => {
      const result = checkToolPermission("close_task", READ_ONLY);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("canExecute");
    });

    it("blocks send_message", () => {
      const result = checkToolPermission("send_message", READ_ONLY);
      expect(result.allowed).toBe(false);
      expect(result.requiredPermission).toBe("canWrite");
    });

    it("blocks store_memory", () => {
      const result = checkToolPermission("store_memory", READ_ONLY);
      expect(result.allowed).toBe(false);
    });
  });

  describe("custom permissions (read + write, no execute)", () => {
    const customPerms: AdapterPermissions = {
      canRead: true,
      canWrite: true,
      canExecute: false,
    };

    it("allows read tools", () => {
      expect(checkToolPermission("list_tasks", customPerms).allowed).toBe(true);
    });

    it("allows write tools", () => {
      expect(checkToolPermission("create_task", customPerms).allowed).toBe(true);
    });

    it("blocks execute tools", () => {
      expect(checkToolPermission("close_task", customPerms).allowed).toBe(false);
    });
  });
});

describe("guardToolUseBlocks", () => {
  const makeBlock = (name: string): ToolUseBlock => ({
    type: "tool_use",
    id: `call_${name}`,
    name,
    input: {},
  });

  it("allows all blocks under full access", () => {
    const blocks = [
      makeBlock("ask_team_memory"),
      makeBlock("create_task"),
      makeBlock("close_task"),
    ];
    const result = guardToolUseBlocks(blocks, FULL_ACCESS);
    expect(result.allowed).toHaveLength(3);
    expect(result.blocked).toHaveLength(0);
  });

  it("filters write/execute blocks under read-only", () => {
    const blocks = [
      makeBlock("ask_team_memory"),
      makeBlock("create_task"),
      makeBlock("recall_my_memory"),
      makeBlock("send_message"),
    ];
    const result = guardToolUseBlocks(blocks, READ_ONLY);
    expect(result.allowed).toHaveLength(2);
    expect(result.allowed.map((b) => b.name)).toEqual([
      "ask_team_memory",
      "recall_my_memory",
    ]);
    expect(result.blocked).toHaveLength(2);
    expect(result.blocked.map((b) => b.check.tool)).toEqual([
      "create_task",
      "send_message",
    ]);
  });

  it("handles empty block list", () => {
    const result = guardToolUseBlocks([], READ_ONLY);
    expect(result.allowed).toHaveLength(0);
    expect(result.blocked).toHaveLength(0);
  });

  it("blocks all unknown tools", () => {
    const blocks = [makeBlock("unknown_tool")];
    const result = guardToolUseBlocks(blocks, FULL_ACCESS);
    expect(result.allowed).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
  });
});

describe("buildPermissionContext", () => {
  it("returns full access message for Signal", () => {
    const ctx = buildPermissionContext("signal", FULL_ACCESS);
    expect(ctx).toContain("FULL ACCESS");
    expect(ctx).toContain("signal");
  });

  it("returns read-only message for WhatsApp", () => {
    const ctx = buildPermissionContext("whatsapp", READ_ONLY);
    expect(ctx).toContain("READ-ONLY");
    expect(ctx).toContain("Signal for commands");
  });

  it("returns custom message for partial permissions", () => {
    const perms: AdapterPermissions = {
      canRead: true,
      canWrite: true,
      canExecute: false,
    };
    const ctx = buildPermissionContext("slack", perms);
    expect(ctx).toContain("read");
    expect(ctx).toContain("write");
    expect(ctx).not.toContain("execute");
  });
});
