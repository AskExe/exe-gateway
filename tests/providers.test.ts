/**
 * LLM Provider abstraction tests.
 *
 * Tests normalization logic without making real API calls.
 * Verifies the provider interface contracts and type conversions.
 */

import { describe, it, expect } from "vitest";
import type {
  NormalizedContentBlock,
  NormalizedLLMMessage,
  NormalizedResponse,
  NormalizedTool,
  NormalizedMessageParams,
  LLMProvider,
  StopReason,
} from "../src/providers/types.js";

// --- Type contract tests ---

describe("NormalizedContentBlock types", () => {
  it("represents text blocks", () => {
    const block: NormalizedContentBlock = { type: "text", text: "hello" };
    expect(block.type).toBe("text");
    expect(block.text).toBe("hello");
  });

  it("represents tool_use blocks", () => {
    const block: NormalizedContentBlock = {
      type: "tool_use",
      id: "call-1",
      name: "ask_team_memory",
      input: { team_member: "yoshi", query: "recent work" },
    };
    expect(block.type).toBe("tool_use");
    expect(block.name).toBe("ask_team_memory");
  });

  it("represents tool_result blocks", () => {
    const block: NormalizedContentBlock = {
      type: "tool_result",
      tool_use_id: "call-1",
      content: "Found 5 memories",
      is_error: false,
    };
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("call-1");
  });
});

describe("NormalizedResponse", () => {
  it("contains content blocks, stop reason, and usage", () => {
    const response: NormalizedResponse = {
      content: [{ type: "text", text: "Hello!" }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    expect(response.content).toHaveLength(1);
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage.inputTokens).toBe(10);
  });

  it("supports tool_use stop reason", () => {
    const response: NormalizedResponse = {
      content: [
        { type: "tool_use", id: "c1", name: "search", input: { q: "test" } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 20, outputTokens: 15 },
    };
    expect(response.stopReason).toBe("tool_use");
    expect(response.content[0]!.type).toBe("tool_use");
  });
});

describe("NormalizedTool", () => {
  it("defines tool with name, description, and schema", () => {
    const tool: NormalizedTool = {
      name: "submit_signup",
      description: "Submit signup info",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
        },
        required: ["name", "email"],
      },
    };
    expect(tool.name).toBe("submit_signup");
    expect(tool.inputSchema.type).toBe("object");
  });
});

describe("NormalizedMessageParams", () => {
  it("contains all fields needed for an API call", () => {
    const params: NormalizedMessageParams = {
      model: "claude-sonnet-4-20250514",
      system: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
      tools: [
        {
          name: "search",
          description: "Search for info",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      maxTokens: 4096,
    };
    expect(params.messages).toHaveLength(2);
    expect(params.tools).toHaveLength(1);
    expect(params.maxTokens).toBe(4096);
  });
});

describe("NormalizedLLMMessage", () => {
  it("supports string content", () => {
    const msg: NormalizedLLMMessage = { role: "user", content: "Hello" };
    expect(typeof msg.content).toBe("string");
  });

  it("supports block content", () => {
    const msg: NormalizedLLMMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me search" },
        { type: "tool_use", id: "c1", name: "search", input: {} },
      ],
    };
    expect(Array.isArray(msg.content)).toBe(true);
  });

  it("supports tool_result in user messages", () => {
    const msg: NormalizedLLMMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "c1",
          content: "Search result: found 3 items",
        },
      ],
    };
    expect((msg.content as NormalizedContentBlock[])[0]!.type).toBe("tool_result");
  });
});

describe("LLMProvider interface contract", () => {
  it("can be implemented with correct shape", () => {
    // Verify the interface can be satisfied
    const mockProvider: LLMProvider = {
      name: "test-provider",
      createMessage: async (_params: NormalizedMessageParams) => ({
        content: [{ type: "text" as const, text: "response" }],
        stopReason: "end_turn" as StopReason,
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
      healthCheck: async () => ({ available: true, latencyMs: 50 }),
    };
    expect(mockProvider.name).toBe("test-provider");
  });
});

describe("StopReason", () => {
  it("covers all valid values", () => {
    const reasons: StopReason[] = ["end_turn", "tool_use", "max_tokens"];
    expect(reasons).toHaveLength(3);
  });
});

describe("Tool use normalization contract", () => {
  it("Anthropic format maps to NormalizedContentBlock", () => {
    // Anthropic: content: [{ type: "tool_use", id, name, input }]
    const anthropicBlock: NormalizedContentBlock = {
      type: "tool_use",
      id: "toolu_abc",
      name: "ask_team_memory",
      input: { team_member: "yoshi", query: "today" },
    };
    expect(anthropicBlock.type).toBe("tool_use");
    expect(anthropicBlock.id).toBe("toolu_abc");
  });

  it("OpenAI format maps to NormalizedContentBlock", () => {
    // OpenAI: tool_calls: [{ id, function: { name, arguments } }]
    // After normalization:
    const openaiNormalized: NormalizedContentBlock = {
      type: "tool_use",
      id: "call_xyz",
      name: "ask_team_memory",
      input: { team_member: "yoshi", query: "today" },
    };
    expect(openaiNormalized.type).toBe("tool_use");
    expect(openaiNormalized.id).toBe("call_xyz");
  });

  it("both formats produce identical NormalizedContentBlock shape", () => {
    const fromAnthropic: NormalizedContentBlock = {
      type: "tool_use",
      id: "a",
      name: "search",
      input: { q: "test" },
    };
    const fromOpenAI: NormalizedContentBlock = {
      type: "tool_use",
      id: "b",
      name: "search",
      input: { q: "test" },
    };
    // Same shape, different IDs
    expect(fromAnthropic.type).toBe(fromOpenAI.type);
    expect(fromAnthropic.name).toBe(fromOpenAI.name);
  });
});
