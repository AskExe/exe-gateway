/**
 * Anthropic provider — wraps @anthropic-ai/sdk.
 *
 * Covers: Claude family, MiniMax M2.7, GLM-5, any Anthropic-compatible endpoint.
 * Supports base_url swaps for alternative providers.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  NormalizedMessageParams,
  NormalizedResponse,
  NormalizedContentBlock,
  NormalizedLLMMessage,
} from "./types.js";

export interface AnthropicProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

export class AnthropicProvider implements LLMProvider {
  readonly name: string;
  private client: Anthropic;
  private defaultModel: string;

  constructor(name: string, config: AnthropicProviderConfig) {
    this.name = name;
    this.defaultModel = config.defaultModel ?? "claude-sonnet-4-20250514";
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl || undefined,
    });
  }

  async createMessage(params: NormalizedMessageParams): Promise<NormalizedResponse> {
    const response = await this.client.messages.create({
      model: params.model || this.defaultModel,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages.map((m) => this.toAnthropicMessage(m)),
      tools: params.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
    });

    return this.normalizeResponse(response);
  }

  async healthCheck(): Promise<{ available: boolean; latencyMs?: number }> {
    const start = Date.now();
    try {
      // Lightweight call to verify API connectivity
      await this.client.messages.create({
        model: this.defaultModel,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
      return { available: true, latencyMs: Date.now() - start };
    } catch {
      return { available: false, latencyMs: Date.now() - start };
    }
  }

  private toAnthropicMessage(
    msg: NormalizedLLMMessage,
  ): Anthropic.MessageParam {
    if (typeof msg.content === "string") {
      return { role: msg.role, content: msg.content };
    }

    // Convert NormalizedContentBlock[] to Anthropic format
    const blocks: Anthropic.ContentBlockParam[] = msg.content.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text };
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use" as const,
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      }
      if (block.type === "tool_result") {
        return {
          type: "tool_result" as const,
          tool_use_id: block.tool_use_id,
          content: block.content,
          is_error: block.is_error,
        };
      }
      return { type: "text" as const, text: "" };
    });

    return { role: msg.role, content: blocks };
  }

  private normalizeResponse(response: Anthropic.Message): NormalizedResponse {
    const content: NormalizedContentBlock[] = response.content.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text };
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use" as const,
          id: block.id,
          name: block.name,
          input: block.input,
        };
      }
      return { type: "text" as const, text: "" };
    });

    const stopReason =
      response.stop_reason === "tool_use"
        ? ("tool_use" as const)
        : response.stop_reason === "max_tokens"
          ? ("max_tokens" as const)
          : ("end_turn" as const);

    return {
      content,
      stopReason,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
