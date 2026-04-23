/**
 * Bot registry — maps route targets to BotRuntime instances.
 *
 * Converts BotTemplate → BotRuntimeConfig, resolves the impedance mismatch
 * between template toolHandlers and runtime toolExecutor.
 */

import { BotRuntime, type BotRuntimeConfig } from "./bot-runtime.js";
import type { BotTemplate } from "./bot-templates/types.js";

export class BotRegistry {
  private bots = new Map<string, BotRuntime>();

  /** Register a bot from a template */
  register(template: BotTemplate, apiKey: string): void {
    const config: BotRuntimeConfig = {
      apiKey,
      model: template.model,
      agentId: template.agentId,
      systemPrompt: template.systemPrompt,
      tools: template.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.input_schema as Record<string, unknown>,
      })),
      toolExecutor: async (name, input) => {
        const handler = template.toolHandlers[name];
        if (!handler) {
          throw new Error(`No handler for tool "${name}"`);
        }
        const result = await handler(input);
        return typeof result === "string" ? result : JSON.stringify(result);
      },
      maxTurns: template.maxTurns,
    };
    this.bots.set(template.name, new BotRuntime(config));
  }

  /** Register a pre-configured BotRuntime directly */
  registerRuntime(name: string, runtime: BotRuntime): void {
    this.bots.set(name, runtime);
  }

  /** Look up a bot by route target name */
  get(targetName: string): BotRuntime | undefined {
    return this.bots.get(targetName);
  }

  /** List registered bot names */
  list(): string[] {
    return [...this.bots.keys()];
  }

  /** Check if a bot is registered */
  has(targetName: string): boolean {
    return this.bots.has(targetName);
  }
}
