/**
 * Bot template interface — defines a locked-down, single-purpose bot.
 */

import type Anthropic from "@anthropic-ai/sdk";

export interface BotTemplate {
  name: string;
  agentId: string;
  model: string;
  baseUrl?: string;
  systemPrompt: string;
  tools: Anthropic.Tool[];
  toolHandlers: Record<string, (input: unknown) => Promise<unknown>>;
  rateLimit: { messagesPerMinute: number };
  maxTurns: number;
}
