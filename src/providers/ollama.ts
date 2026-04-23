/**
 * Ollama provider — direct REST API for local models.
 *
 * Simpler than OpenAI-compat mode. For local development with
 * Qwen 3.5, Llama, etc.
 */

import { randomUUID } from "node:crypto";
import type {
  LLMProvider,
  NormalizedMessageParams,
  NormalizedResponse,
  NormalizedContentBlock,
} from "./types.js";

export interface OllamaProviderConfig {
  host?: string;
  defaultModel?: string;
}

interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> };
    }>;
  };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export class OllamaProvider implements LLMProvider {
  readonly name: string;
  private host: string;
  private defaultModel: string;

  constructor(name: string, config: OllamaProviderConfig = {}) {
    this.name = name;
    this.host = (config.host ?? "http://localhost:11434").replace(/\/+$/, "");
    this.defaultModel = config.defaultModel ?? "qwen3:14b";
  }

  async createMessage(params: NormalizedMessageParams): Promise<NormalizedResponse> {
    const messages: OllamaChatMessage[] = [
      { role: "system", content: params.system },
    ];

    for (const msg of params.messages) {
      if (typeof msg.content === "string") {
        messages.push({ role: msg.role, content: msg.content });
      } else {
        const text = msg.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("\n");
        messages.push({ role: msg.role, content: text });
      }
    }

    const tools: OllamaTool[] | undefined = params.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const body: Record<string, unknown> = {
      model: params.model || this.defaultModel,
      messages,
      stream: false,
      options: { num_predict: params.maxTokens },
    };
    if (tools?.length) body.tools = tools;

    const res = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`Ollama API error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    return this.normalizeResponse(data);
  }

  async healthCheck(): Promise<{ available: boolean; latencyMs?: number }> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.host}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      return { available: res.ok, latencyMs: Date.now() - start };
    } catch {
      return { available: false };
    }
  }

  private normalizeResponse(data: OllamaChatResponse): NormalizedResponse {
    const content: NormalizedContentBlock[] = [];

    if (data.message.content) {
      content.push({ type: "text", text: data.message.content });
    }

    if (data.message.tool_calls) {
      for (const call of data.message.tool_calls) {
        content.push({
          type: "tool_use",
          id: randomUUID(),
          name: call.function.name,
          input: call.function.arguments,
        });
      }
    }

    if (content.length === 0) {
      content.push({ type: "text", text: "" });
    }

    const hasToolUse = content.some((b) => b.type === "tool_use");

    return {
      content,
      stopReason: hasToolUse ? "tool_use" : "end_turn",
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
    };
  }
}
