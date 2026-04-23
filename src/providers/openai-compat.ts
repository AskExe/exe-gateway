/**
 * OpenAI-compatible provider — wraps any OpenAI API-compatible endpoint.
 *
 * Covers: OpenRouter (200+ models), Chutes, DeepSeek, Qwen, Together,
 * Groq, Ollama (via OpenAI-compat mode), and any standard endpoint.
 *
 * Handles the tool_use format translation between OpenAI function_calling
 * and our NormalizedResponse format.
 */

import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import type {
  LLMProvider,
  NormalizedMessageParams,
  NormalizedResponse,
  NormalizedContentBlock,
  NormalizedLLMMessage,
} from "./types.js";

export interface OpenAICompatProviderConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel?: string;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  private client: OpenAI;
  private defaultModel: string;

  constructor(name: string, config: OpenAICompatProviderConfig) {
    this.name = name;
    this.defaultModel = config.defaultModel ?? "gpt-4o";
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  async createMessage(params: NormalizedMessageParams): Promise<NormalizedResponse> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: params.system },
      ...params.messages.flatMap((m) => this.toOpenAIMessages(m)),
    ];

    const tools: OpenAI.ChatCompletionTool[] | undefined = params.tools?.map(
      (t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }),
    );

    const response = await this.client.chat.completions.create({
      model: params.model || this.defaultModel,
      max_tokens: params.maxTokens,
      messages,
      tools: tools?.length ? tools : undefined,
    });

    return this.normalizeResponse(response);
  }

  async healthCheck(): Promise<{ available: boolean; latencyMs?: number }> {
    const start = Date.now();
    try {
      await this.client.chat.completions.create({
        model: this.defaultModel,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
      return { available: true, latencyMs: Date.now() - start };
    } catch {
      return { available: false, latencyMs: Date.now() - start };
    }
  }

  private toOpenAIMessages(
    msg: NormalizedLLMMessage,
  ): OpenAI.ChatCompletionMessageParam[] {
    if (typeof msg.content === "string") {
      return [{ role: msg.role, content: msg.content }];
    }

    // Handle complex content blocks
    if (msg.role === "assistant") {
      const textParts = msg.content
        .filter((b): b is Extract<NormalizedContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      const toolCalls = msg.content
        .filter((b): b is Extract<NormalizedContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: {
            name: b.name,
            arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input),
          },
        }));

      if (toolCalls.length > 0) {
        return [{
          role: "assistant",
          content: textParts || null,
          tool_calls: toolCalls,
        }];
      }
      return [{ role: "assistant", content: textParts }];
    }

    // User messages with tool_results — OpenAI expects one "tool" message per result
    if (msg.role === "user") {
      const toolResults = msg.content.filter(
        (b): b is Extract<NormalizedContentBlock, { type: "tool_result" }> =>
          b.type === "tool_result",
      );

      if (toolResults.length > 0) {
        return toolResults.map((r) => ({
          role: "tool" as const,
          tool_call_id: r.tool_use_id,
          content: r.content,
        }));
      }

      const text = msg.content
        .filter((b): b is Extract<NormalizedContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return [{ role: "user", content: text }];
    }

    return [{ role: msg.role, content: "" }];
  }

  private normalizeResponse(
    response: OpenAI.ChatCompletion,
  ): NormalizedResponse {
    const choice = response.choices[0];
    if (!choice) {
      return {
        content: [{ type: "text", text: "" }],
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    const content: NormalizedContentBlock[] = [];

    // Text content
    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }

    // Tool calls → normalized tool_use blocks
    if (choice.message.tool_calls) {
      for (const call of choice.message.tool_calls) {
        // Handle both standard and custom tool call formats
        const fn = (call as { function?: { name: string; arguments: string } }).function;
        if (!fn) continue;
        let input: unknown;
        try {
          input = JSON.parse(fn.arguments);
        } catch {
          input = fn.arguments;
        }
        content.push({
          type: "tool_use",
          id: call.id ?? randomUUID(),
          name: fn.name,
          input,
        });
      }
    }

    if (content.length === 0) {
      content.push({ type: "text", text: "" });
    }

    const stopReason =
      choice.finish_reason === "tool_calls"
        ? ("tool_use" as const)
        : choice.finish_reason === "length"
          ? ("max_tokens" as const)
          : ("end_turn" as const);

    return {
      content,
      stopReason,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}
