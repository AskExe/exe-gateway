/**
 * Multi-provider failover cascade.
 *
 * Tries providers in order per config.failoverChain using the LLMProvider interface.
 * Integrates with the circuit breaker to skip degraded providers.
 * Per-tier behavior controls how aggressively we failover.
 *
 * Model-agnostic — works with any LLMProvider (Anthropic, OpenAI, Ollama, etc.)
 */

import { CircuitBreaker, retryWithBackoff } from "./reliability.js";
import type {
  LLMProvider,
  NormalizedMessageParams,
  NormalizedResponse,
} from "./providers/types.js";
import { createProvider, type FactoryProviderId } from "./providers/factory.js";

export interface ProviderConfig {
  name: string;
  providerId: FactoryProviderId;
  baseUrl?: string;
  apiKey: string;
  models: {
    haiku: string;
    sonnet: string;
    opus: string;
  };
  maxLatencyMs: number;
  costMultiplier: number;
}

export type FailoverTier = "full" | "standard" | "basic";

export interface FailoverConfig {
  providers: ProviderConfig[];
  tiers: {
    full: { providerCount: number; timeoutMs: number };
    standard: { providerCount: number; timeoutMs: number };
    basic: { providerCount: number; timeoutMs: number };
  };
}

export const DEFAULT_FAILOVER_CONFIG: FailoverConfig = {
  providers: [],
  tiers: {
    full: { providerCount: Infinity, timeoutMs: 15_000 },
    standard: { providerCount: 2, timeoutMs: 10_000 },
    basic: { providerCount: 1, timeoutMs: 5_000 },
  },
};

export interface FailoverResult {
  response: NormalizedResponse;
  provider: string;
  latencyMs: number;
  failedProviders: string[];
}

export class FailoverCascade {
  private config: FailoverConfig;
  private breakers = new Map<string, CircuitBreaker>();
  private llmProviders = new Map<string, LLMProvider>();

  constructor(config: FailoverConfig) {
    this.config = config;
    for (const provider of config.providers) {
      this.breakers.set(
        provider.name,
        new CircuitBreaker(provider.name, {
          windowMs: 60_000,
          failureThreshold: 0.5,
          minimumRequests: 5,
          halfOpenAfterMs: 30_000,
        }),
      );
      this.llmProviders.set(
        provider.name,
        createProvider({
          providerId: provider.providerId,
          model: provider.models.sonnet,
          apiKey: provider.apiKey,
        }),
      );
    }
  }

  /**
   * Execute an API call with failover across providers.
   * Tries providers in order, respecting circuit breakers and tier limits.
   */
  async execute(
    params: Omit<NormalizedMessageParams, "model"> & {
      modelTier: "haiku" | "sonnet" | "opus";
    },
    tier: FailoverTier = "standard",
  ): Promise<FailoverResult> {
    const tierConfig = this.config.tiers[tier];
    const maxProviders = Math.min(
      tierConfig.providerCount,
      this.config.providers.length,
    );
    const failedProviders: string[] = [];

    for (let i = 0; i < maxProviders; i++) {
      const provider = this.config.providers[i]!;
      const breaker = this.breakers.get(provider.name)!;
      const llm = this.llmProviders.get(provider.name)!;

      if (!breaker.canRequest()) {
        failedProviders.push(provider.name);
        continue;
      }

      const model = provider.models[params.modelTier];
      const start = Date.now();

      try {
        const response = await retryWithBackoff(
          () =>
            Promise.race([
              llm.createMessage({ ...params, model }),
              rejectAfter(tierConfig.timeoutMs, provider.name),
            ]),
          { maxRetries: 1, baseDelayMs: 500, maxDelayMs: 2000 },
        );

        const latencyMs = Date.now() - start;
        breaker.recordSuccess();

        return { response, provider: provider.name, latencyMs, failedProviders };
      } catch {
        breaker.recordFailure();
        failedProviders.push(provider.name);
      }
    }

    throw new FailoverExhaustedError(failedProviders);
  }

  /** Get health status of all providers */
  getProviderHealth(): Array<{
    name: string;
    state: string;
    failureRate: number;
  }> {
    return this.config.providers.map((p) => {
      const breaker = this.breakers.get(p.name)!;
      return {
        name: p.name,
        state: breaker.getState(),
        failureRate: breaker.getFailureRate(),
      };
    });
  }

  /** Reset all circuit breakers */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}

function rejectAfter(ms: number, provider: string): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${provider} timed out after ${ms}ms`)), ms),
  );
}

export class FailoverExhaustedError extends Error {
  readonly failedProviders: string[];
  constructor(failedProviders: string[]) {
    super(
      `All providers exhausted: ${failedProviders.join(", ")}. ` +
        `Returning degradation message.`,
    );
    this.name = "FailoverExhaustedError";
    this.failedProviders = failedProviders;
  }
}
