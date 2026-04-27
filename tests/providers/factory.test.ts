/**
 * Tests for src/gateway/providers/factory.ts — provider dispatch.
 *
 * No network calls — spy the provider constructors and assert on the
 * arguments they receive.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Spy on provider constructors BEFORE importing the factory, so the factory's
// internal import of each provider module gets the spied version.
//
// `vi.hoisted` is required because `vi.mock` factory bodies run before any
// top-level code; plain references would be undefined at mock time.
// ---------------------------------------------------------------------------

const { anthropicCtor, openAICompatCtor, FakeAnthropicProvider, FakeOpenAICompatProvider } = vi.hoisted(() => {
  const anthropicCtor = vi.fn();
  const openAICompatCtor = vi.fn();
  class FakeAnthropicProvider {
    readonly name: string;
    readonly config: { apiKey: string; baseUrl?: string; defaultModel?: string };
    constructor(name: string, config: { apiKey: string; baseUrl?: string; defaultModel?: string }) {
      this.name = name;
      this.config = config;
      anthropicCtor(name, config);
    }
  }
  class FakeOpenAICompatProvider {
    readonly name: string;
    readonly config: { apiKey: string; baseUrl: string; defaultModel?: string };
    constructor(name: string, config: { apiKey: string; baseUrl: string; defaultModel?: string }) {
      this.name = name;
      this.config = config;
      openAICompatCtor(name, config);
    }
  }
  return { anthropicCtor, openAICompatCtor, FakeAnthropicProvider, FakeOpenAICompatProvider };
});

vi.mock("../../src/providers/anthropic.js", () => ({
  AnthropicProvider: FakeAnthropicProvider,
}));

vi.mock("../../src/providers/openai-compat.js", () => ({
  OpenAICompatProvider: FakeOpenAICompatProvider,
}));

// Import AFTER the mocks are registered
import {
  createProvider,
  OPENCODE_BASE_URL,
  OPENCODE_ANTHROPIC_MODELS,
  OPENCODE_OPENAI_MODELS,
} from "../../src/providers/factory.js";

beforeEach(() => {
  anthropicCtor.mockReset();
  openAICompatCtor.mockReset();
});

describe("createProvider — OpenCode dual-protocol dispatch", () => {
  it("routes opencode + minimax-m2.7 to AnthropicProvider with OpenCode Zen Go baseUrl", () => {
    const p = createProvider({ providerId: "opencode", model: "minimax-m2.7", apiKey: "oc-key" });
    expect(p).toBeInstanceOf(FakeAnthropicProvider);
    expect(anthropicCtor).toHaveBeenCalledTimes(1);
    expect(anthropicCtor).toHaveBeenCalledWith("opencode", {
      apiKey: "oc-key",
      baseUrl: OPENCODE_BASE_URL,
      defaultModel: "minimax-m2.7",
    });
    expect(openAICompatCtor).not.toHaveBeenCalled();
  });

  it("routes opencode + kimi-k2.5 to OpenAICompatProvider with OpenCode Zen Go baseUrl", () => {
    const p = createProvider({ providerId: "opencode", model: "kimi-k2.5", apiKey: "oc-key" });
    expect(p).toBeInstanceOf(FakeOpenAICompatProvider);
    expect(openAICompatCtor).toHaveBeenCalledTimes(1);
    expect(openAICompatCtor).toHaveBeenCalledWith("opencode", {
      apiKey: "oc-key",
      baseUrl: OPENCODE_BASE_URL,
      defaultModel: "kimi-k2.5",
    });
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it("throws on an unknown OpenCode model", () => {
    expect(() =>
      createProvider({ providerId: "opencode", model: "mystery-model-9000", apiKey: "oc-key" }),
    ).toThrow(/Unknown OpenCode model/);
    expect(anthropicCtor).not.toHaveBeenCalled();
    expect(openAICompatCtor).not.toHaveBeenCalled();
  });

  it.each(OPENCODE_ANTHROPIC_MODELS)(
    "routes opencode + %s (anthropic-protocol model) through AnthropicProvider",
    (model) => {
      createProvider({ providerId: "opencode", model, apiKey: "oc-key" });
      expect(anthropicCtor).toHaveBeenCalledWith(
        "opencode",
        expect.objectContaining({ baseUrl: OPENCODE_BASE_URL, defaultModel: model }),
      );
    },
  );

  it.each(OPENCODE_OPENAI_MODELS)(
    "routes opencode + %s (openai-protocol model) through OpenAICompatProvider",
    (model) => {
      createProvider({ providerId: "opencode", model, apiKey: "oc-key" });
      expect(openAICompatCtor).toHaveBeenCalledWith(
        "opencode",
        expect.objectContaining({ baseUrl: OPENCODE_BASE_URL, defaultModel: model }),
      );
    },
  );
});

describe("createProvider — native Anthropic + OpenAI", () => {
  it("anthropic providerId returns AnthropicProvider with NO baseUrl", () => {
    const p = createProvider({ providerId: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "sk-ant" });
    expect(p).toBeInstanceOf(FakeAnthropicProvider);
    expect(anthropicCtor).toHaveBeenCalledTimes(1);
    const [, config] = anthropicCtor.mock.calls[0]!;
    expect(config.apiKey).toBe("sk-ant");
    expect(config.baseUrl).toBeUndefined();
    expect(openAICompatCtor).not.toHaveBeenCalled();
  });

  it("openai providerId returns OpenAICompatProvider with the OpenAI base URL", () => {
    const p = createProvider({ providerId: "openai", model: "gpt-4o", apiKey: "sk-openai" });
    expect(p).toBeInstanceOf(FakeOpenAICompatProvider);
    expect(openAICompatCtor).toHaveBeenCalledTimes(1);
    const [name, config] = openAICompatCtor.mock.calls[0]!;
    expect(name).toBe("openai");
    expect(config.apiKey).toBe("sk-openai");
    expect(config.baseUrl).toBe("https://api.openai.com/v1");
    expect(anthropicCtor).not.toHaveBeenCalled();
  });
});
