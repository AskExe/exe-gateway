/**
 * LLM Provider abstraction — model-agnostic interface for the gateway.
 *
 * Two implementations cover the entire landscape:
 * - AnthropicProvider: Claude family + any Anthropic-compatible endpoint
 * - OpenAICompatProvider: OpenRouter, Chutes, DeepSeek, Qwen, Together, Groq, Ollama
 */

/** Normalized message for LLM API calls */
export interface NormalizedLLMMessage {
  role: "user" | "assistant";
  content: string | NormalizedContentBlock[];
}

/** Normalized content block — abstracts Anthropic vs OpenAI formats */
export type NormalizedContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/** Normalized tool definition */
export interface NormalizedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Normalized API request params */
export interface NormalizedMessageParams {
  model: string;
  system: string;
  messages: NormalizedLLMMessage[];
  tools?: NormalizedTool[];
  maxTokens: number;
}

/** Stop reason — why the model stopped generating */
export type StopReason = "end_turn" | "tool_use" | "max_tokens";

/** Normalized API response */
export interface NormalizedResponse {
  content: NormalizedContentBlock[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
}

/** Streaming event */
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; input: string }
  | { type: "done"; response: NormalizedResponse };

/** LLM Provider interface — implemented by each provider */
export interface LLMProvider {
  readonly name: string;
  createMessage(params: NormalizedMessageParams): Promise<NormalizedResponse>;
  healthCheck(): Promise<{ available: boolean; latencyMs?: number }>;
}

/** Provider configuration */
export interface ProviderInstanceConfig {
  name: string;
  type: "anthropic" | "openai-compat" | "ollama";
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}
