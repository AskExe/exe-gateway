/**
 * Provider factory — dispatches to the right LLMProvider implementation
 * based on providerId + model.
 *
 * OpenCode Zen Go is dual-protocol: some models speak Anthropic's messages
 * API (`/v1/messages`) and others speak OpenAI's chat-completions API
 * (`/v1/chat/completions`). The factory routes by model name so callers
 * don't need to know which wire format each OpenCode model uses.
 */

import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import type { LLMProvider } from "./types.js";

export type FactoryProviderId = "anthropic" | "openai" | "opencode";

export interface CreateProviderOptions {
  providerId: FactoryProviderId;
  model: string;
  apiKey: string;
}

export const OPENCODE_BASE_URL = "https://opencode.ai/zen/go/v1";

/** OpenCode Zen Go models that use the Anthropic messages protocol. */
export const OPENCODE_ANTHROPIC_MODELS: readonly string[] = [
  "minimax-m2.7",
  "minimax-m2.5",
] as const;

/** OpenCode Zen Go models that use the OpenAI chat-completions protocol. */
export const OPENCODE_OPENAI_MODELS: readonly string[] = [
  "glm-5.1",
  "glm-5",
  "kimi-k2.5",
  "mimo-v2-pro",
  "mimo-v2-omni",
] as const;

const OPENAI_BASE_URL = "https://api.openai.com/v1";

export function createProvider(opts: CreateProviderOptions): LLMProvider {
  const { providerId, model, apiKey } = opts;

  if (providerId === "anthropic") {
    return new AnthropicProvider("anthropic", { apiKey });
  }

  if (providerId === "openai") {
    return new OpenAICompatProvider("openai", {
      apiKey,
      baseUrl: OPENAI_BASE_URL,
    });
  }

  if (providerId === "opencode") {
    if (OPENCODE_ANTHROPIC_MODELS.includes(model)) {
      return new AnthropicProvider("opencode", {
        apiKey,
        baseUrl: OPENCODE_BASE_URL,
        defaultModel: model,
      });
    }
    if (OPENCODE_OPENAI_MODELS.includes(model)) {
      return new OpenAICompatProvider("opencode", {
        apiKey,
        baseUrl: OPENCODE_BASE_URL,
        defaultModel: model,
      });
    }
    throw new Error(
      `Unknown OpenCode model "${model}". ` +
        `Expected one of: ${[...OPENCODE_ANTHROPIC_MODELS, ...OPENCODE_OPENAI_MODELS].join(", ")}`,
    );
  }

  throw new Error(`Unknown providerId "${providerId as string}"`);
}
