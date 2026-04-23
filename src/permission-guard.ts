/**
 * Permission guard — intercepts tool_use blocks from the model and blocks
 * unauthorized calls based on per-adapter permissions.
 *
 * This is middleware, not a prompt instruction. The LLM cannot bypass it.
 * The guard runs AFTER the model responds and BEFORE tool execution.
 */

import type { AdapterPermissions } from "./types.js";
import { READ_TOOLS, WRITE_TOOLS, EXECUTE_TOOLS } from "./types.js";

/** A tool_use content block from the Anthropic API response */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Result of checking a single tool call against permissions */
export interface PermissionCheckResult {
  allowed: boolean;
  tool: string;
  requiredPermission: "canRead" | "canWrite" | "canExecute";
  reason?: string;
}

type PermissionLevel = "canRead" | "canWrite" | "canExecute";

const TOOL_CLASSIFICATION = new Map<string, PermissionLevel>();
for (const tool of READ_TOOLS) TOOL_CLASSIFICATION.set(tool, "canRead");
for (const tool of WRITE_TOOLS) TOOL_CLASSIFICATION.set(tool, "canWrite");
for (const tool of EXECUTE_TOOLS) TOOL_CLASSIFICATION.set(tool, "canExecute");

/**
 * Classify a tool name into its permission level.
 * Returns null for unknown tools.
 */
export function classifyTool(toolName: string): PermissionLevel | null {
  return TOOL_CLASSIFICATION.get(toolName) ?? null;
}

/**
 * Check whether a single tool call is allowed under the given permissions.
 */
export function checkToolPermission(
  toolName: string,
  permissions: AdapterPermissions,
): PermissionCheckResult {
  const classification = classifyTool(toolName);

  if (!classification) {
    return {
      allowed: false,
      tool: toolName,
      requiredPermission: "canExecute",
      reason: `Unknown tool "${toolName}" is not in the allowed tool list`,
    };
  }

  const allowed = permissions[classification];
  return {
    allowed,
    tool: toolName,
    requiredPermission: classification,
    reason: allowed
      ? undefined
      : `Tool "${toolName}" requires ${classification} permission, which is not granted on this channel`,
  };
}

/** A blocked tool paired with its original block for ID-based matching */
export interface BlockedTool {
  block: ToolUseBlock;
  check: PermissionCheckResult;
}

/** Result of filtering a batch of tool_use blocks */
export interface GuardResult {
  allowed: ToolUseBlock[];
  blocked: BlockedTool[];
}

/**
 * Filter tool_use blocks, separating allowed from blocked.
 * Blocked tools get an error result returned to the model instead.
 */
export function guardToolUseBlocks(
  blocks: ToolUseBlock[],
  permissions: AdapterPermissions,
): GuardResult {
  const allowed: ToolUseBlock[] = [];
  const blocked: BlockedTool[] = [];

  for (const block of blocks) {
    const result = checkToolPermission(block.name, permissions);
    if (result.allowed) {
      allowed.push(block);
    } else {
      blocked.push({ block, check: result });
    }
  }

  return { allowed, blocked };
}

/**
 * Build a permission context string to inject into the system prompt.
 * This tells the model what it can and cannot do on this channel.
 */
export function buildPermissionContext(
  platform: string,
  permissions: AdapterPermissions,
): string {
  if (permissions.canRead && permissions.canWrite && permissions.canExecute) {
    return `[FULL ACCESS — you can read, write, and execute via ${platform}]`;
  }

  if (permissions.canRead && !permissions.canWrite && !permissions.canExecute) {
    return `[READ-ONLY — this ${platform} channel cannot create tasks, send messages, or execute commands. Tell the founder to use Signal for commands.]`;
  }

  const parts: string[] = [];
  if (permissions.canRead) parts.push("read");
  if (permissions.canWrite) parts.push("write");
  if (permissions.canExecute) parts.push("execute");
  return `[${platform.toUpperCase()} — allowed: ${parts.join(", ")}]`;
}

