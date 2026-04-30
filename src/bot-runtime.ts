/**
 * Exec-assistant runtime — model-agnostic bot using the LLMProvider interface.
 *
 * This is NOT Claude Code. It's a lightweight conversational runtime
 * that calls ANY LLM provider (Anthropic, OpenAI, Ollama, OpenCode) via
 * the unified LLMProvider interface with a system prompt + MCP-like tools.
 * Permission guard runs AFTER model response, BEFORE tool execution.
 *
 * Provider abstraction: bot-runtime does NOT import Anthropic SDK directly.
 * It uses NormalizedMessageParams/NormalizedResponse from providers/types.ts.
 * This means each bot can use a different model — Claude, GPT-4, Llama, etc.
 */

import type { AdapterPermissions, NormalizedMessage } from "./types.js";
import {
  guardToolUseBlocks,
  buildPermissionContext,
  type ToolUseBlock,
} from "./permission-guard.js";
import { READ_TOOLS, WRITE_TOOLS, EXECUTE_TOOLS } from "./types.js";
import type {
  LLMProvider,
  NormalizedContentBlock,
  NormalizedLLMMessage,
  NormalizedTool,
} from "./providers/types.js";
import { CircuitBreaker } from "./reliability.js";

/** Tool definition for the bot runtime */
interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Conversation message for history tracking */
interface ConversationMessage {
  role: "user" | "assistant";
  content: string | NormalizedContentBlock[];
}

/** Tool executor function */
type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<string>;

/** Bot runtime configuration */
export interface BotRuntimeConfig {
  /** LLM provider instance (Anthropic, OpenAI, Ollama, etc.) */
  provider: LLMProvider;
  /** Model to use (e.g., "claude-sonnet-4-20250514", "gpt-4o", "llama3.1") */
  model?: string;
  agentId: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  toolExecutor: ToolExecutor;
  maxTurns?: number;

  /** @deprecated Use `provider` instead. Kept for backwards compatibility. */
  apiKey?: string;
}

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const MAX_TURNS = 10;
const MAX_HISTORY = 50;

/**
 * Build the exec-assistant system prompt.
 */
export function buildExecAssistantSystemPrompt(
  platform: string,
  permissions: AdapterPermissions,
): string {
  const permContext = buildPermissionContext(platform, permissions);

  return `You are the founder's executive assistant (agent_id: "ea").

You are a relay between the founder and their AI team. You have access to team memories, task lists, and session context. Your job is to answer the founder's questions by querying the team and presenting clear, synthesized answers.

${permContext}

Your personality:
- Direct and concise — the founder is busy
- Lead with the answer, not the process
- When summarizing team work, be specific: names, counts, what shipped
- If you don't know something, say so and suggest who might

Your tools:
- ask_team_memory: Query any employee's memories (yoshi, tom, mari, exe)
- recall_my_memory: Search your own past conversations with the founder
- list_tasks: See what's in progress across the org
- get_session_context: Get context from a specific session
- list_reminders: Check active reminders

${permissions.canWrite ? "You also have write access: create_task, send_message, store_memory, etc." : "You are READ-ONLY on this channel. If the founder wants to create tasks or send commands, they should use Signal."}`;
}

/**
 * Filter tool definitions based on permissions.
 * Only expose tools the adapter has permission to use.
 */
export function filterToolsForPermissions(
  tools: ToolDefinition[],
  permissions: AdapterPermissions,
): ToolDefinition[] {
  const allAllowed = new Set<string>();

  if (permissions.canRead) {
    for (const t of READ_TOOLS) allAllowed.add(t);
  }
  if (permissions.canWrite) {
    for (const t of WRITE_TOOLS) allAllowed.add(t);
  }
  if (permissions.canExecute) {
    for (const t of EXECUTE_TOOLS) allAllowed.add(t);
  }

  return tools.filter((t) => allAllowed.has(t.name));
}

/**
 * Exec-assistant bot runtime.
 * Manages conversation history and tool execution with permission enforcement.
 * Model-agnostic — works with any LLMProvider implementation.
 */
export class BotRuntime {
  private provider: LLMProvider;
  private config: BotRuntimeConfig;
  private conversations = new Map<string, ConversationMessage[]>();
  private circuitBreaker: CircuitBreaker;

  constructor(config: BotRuntimeConfig) {
    this.config = config;
    this.provider = config.provider;
    this.circuitBreaker = new CircuitBreaker(`llm-${config.agentId}`, {
      windowMs: 60_000,
      failureThreshold: 0.5,
      minimumRequests: 3,
      halfOpenAfterMs: 30_000,
    });
  }

  /** The provider powering this bot */
  get providerName(): string {
    return this.provider.name;
  }

  /**
   * Process an incoming message and return the text response.
   * Handles multi-turn tool use internally.
   */
  async processMessage(
    msg: NormalizedMessage,
    permissions: AdapterPermissions,
  ): Promise<string> {
    // Circuit breaker check — fail fast if provider is down
    if (!this.circuitBreaker.canRequest()) {
      const state = this.circuitBreaker.getState();
      console.warn(`[bot-runtime] Circuit breaker ${state} for ${this.provider.name} — failing fast`);
      return "I'm having trouble connecting to my language model right now. Please try again in a minute.";
    }

    const sessionKey = msg.chatType === "group" ? msg.channelId : msg.senderId;
    const history = this.getHistory(sessionKey);

    // Add user message
    history.push({ role: "user", content: msg.text });

    // Build system prompt with permission context
    const systemPrompt =
      this.config.systemPrompt +
      "\n\n" +
      buildPermissionContext(msg.platform, permissions);

    // Filter tools based on permissions (defense in depth — guard also enforces)
    const allowedTools = filterToolsForPermissions(
      this.config.tools,
      permissions,
    );

    // Convert tool definitions to normalized format
    const normalizedTools: NormalizedTool[] = allowedTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
    }));

    const model = this.config.model ?? DEFAULT_MODEL;
    const maxTurns = this.config.maxTurns ?? MAX_TURNS;
    let turns = 0;

    while (turns < maxTurns) {
      turns++;

      let response;
      try {
        response = await this.provider.createMessage({
          model,
          maxTokens: 4096,
          system: systemPrompt,
          messages: history.map((m) => ({
            role: m.role,
            content: m.content,
          })) as NormalizedLLMMessage[],
          tools: normalizedTools,
        });
        this.circuitBreaker.recordSuccess();
      } catch (err) {
        this.circuitBreaker.recordFailure();
        throw err;
      }

      // Extract tool_use blocks
      const toolUseBlocks = response.content.filter(
        (b): b is Extract<NormalizedContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );

      // If no tool calls, extract text and return
      if (toolUseBlocks.length === 0) {
        const textContent = response.content
          .filter((b): b is Extract<NormalizedContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n");

        history.push({ role: "assistant", content: textContent });
        this.trimHistory(sessionKey);
        return textContent;
      }

      // Permission guard — enforce at middleware level
      const { allowed, blocked } = guardToolUseBlocks(
        toolUseBlocks as unknown as ToolUseBlock[],
        permissions,
      );

      // Add assistant response to history
      history.push({
        role: "assistant",
        content: response.content,
      });

      // Build tool results
      const toolResults: NormalizedContentBlock[] = [];

      // Execute allowed tools
      for (const block of allowed) {
        try {
          const result = await this.config.toolExecutor(
            block.name,
            block.input as Record<string, unknown>,
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          });
        }
      }

      // Return errors for blocked tools (matched by block ID, not name)
      for (const { block, check } of blocked) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Permission denied: ${check.reason}`,
          is_error: true,
        });
      }

      // Add tool results to history
      history.push({
        role: "user",
        content: toolResults,
      });
    }

    return "I reached the maximum number of tool calls for this request. Please try again with a more specific question.";
  }

  private getHistory(sessionKey: string): ConversationMessage[] {
    if (!this.conversations.has(sessionKey)) {
      this.conversations.set(sessionKey, []);
    }
    return this.conversations.get(sessionKey)!;
  }

  private trimHistory(sessionKey: string): void {
    const history = this.conversations.get(sessionKey);
    if (history && history.length > MAX_HISTORY) {
      // Keep most recent messages
      this.conversations.set(sessionKey, history.slice(-MAX_HISTORY));
    }
  }

  /** Clear conversation history for a session */
  clearHistory(sessionKey: string): void {
    this.conversations.delete(sessionKey);
  }

  /** Get circuit breaker state for health monitoring */
  getCircuitState(): { state: string; failureRate: number } {
    return {
      state: this.circuitBreaker.getState(),
      failureRate: this.circuitBreaker.getFailureRate(),
    };
  }
}

/**
 * Build the standard exec-assistant tool definitions.
 * These mirror the exe-os MCP tools but are defined inline for API-direct use.
 */
export function buildExecAssistantTools(): ToolDefinition[] {
  return [
    {
      name: "ask_team_memory",
      description:
        "Search another employee's memories. Use this to find what a team member worked on, learned, or solved.",
      input_schema: {
        type: "object",
        properties: {
          team_member: {
            type: "string",
            description: "Name of the team member (e.g., 'yoshi', 'mari', 'exe')",
          },
          query: { type: "string", description: "What to search for" },
          project_name: {
            type: "string",
            description: "Filter by project name",
          },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["team_member", "query"],
      },
    },
    {
      name: "recall_my_memory",
      description:
        "Search your own past memories using semantic search.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for" },
          project_name: {
            type: "string",
            description: "Filter by project name",
          },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "list_tasks",
      description: "List tasks across the organization.",
      input_schema: {
        type: "object",
        properties: {
          assigned_to: {
            type: "string",
            description: "Filter by assignee",
          },
          status: {
            type: "string",
            description: "Filter by status (open, in_progress, done)",
          },
          project_name: {
            type: "string",
            description: "Filter by project",
          },
        },
      },
    },
    {
      name: "get_session_context",
      description: "Get context from a specific session.",
      input_schema: {
        type: "object",
        properties: {
          session_key: {
            type: "string",
            description: "Session key to look up",
          },
        },
        required: ["session_key"],
      },
    },
    {
      name: "list_reminders",
      description: "List active reminders.",
      input_schema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Filter by status",
          },
        },
      },
    },
    // Write tools (only available on Signal with full access)
    {
      name: "create_task",
      description: "Create a new task and assign it to an employee.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title" },
          description: { type: "string", description: "Task description" },
          assigned_to: {
            type: "string",
            description: "Employee to assign to",
          },
          priority: {
            type: "string",
            enum: ["p0", "p1", "p2"],
            description: "Task priority",
          },
          project_name: { type: "string", description: "Project name" },
        },
        required: ["title", "assigned_to"],
      },
    },
    {
      name: "send_message",
      description: "Send a message to an employee.",
      input_schema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Employee name" },
          message: { type: "string", description: "Message content" },
        },
        required: ["to", "message"],
      },
    },
    {
      name: "store_memory",
      description: "Store a memory for future reference.",
      input_schema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Memory content" },
          project_name: { type: "string", description: "Project name" },
        },
        required: ["content"],
      },
    },
    {
      name: "store_behavior",
      description: "Store a behavioral directive.",
      input_schema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Behavioral directive content",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "update_task",
      description: "Update a task's status.",
      input_schema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
          status: {
            type: "string",
            enum: ["open", "in_progress", "done", "blocked", "cancelled"],
            description: "New status",
          },
          result: { type: "string", description: "Result summary" },
        },
        required: ["task_id", "status"],
      },
    },
    {
      name: "create_reminder",
      description: "Create a reminder.",
      input_schema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Reminder content" },
          due_at: { type: "string", description: "ISO 8601 due date" },
        },
        required: ["content"],
      },
    },
    {
      name: "complete_reminder",
      description: "Mark a reminder as complete.",
      input_schema: {
        type: "object",
        properties: {
          reminder_id: { type: "string", description: "Reminder ID" },
        },
        required: ["reminder_id"],
      },
    },
    {
      name: "close_task",
      description: "Reviewer-only: finalize a task after review. Only exe/ea can use this.",
      input_schema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
          result: { type: "string", description: "Completion summary" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "query_conversations",
      description: "Search stored conversations across all platforms. Find messages by content, sender, or time range.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search text to find in messages" },
          platform: { type: "string", description: "Filter by platform (whatsapp, telegram, etc.)" },
          sender_id: { type: "string", description: "Filter by sender" },
          limit: { type: "number", description: "Max results (default 20)" },
        },
        required: ["query"],
      },
    },
  ];
}
