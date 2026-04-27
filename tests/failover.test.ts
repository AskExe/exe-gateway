import { describe, it, expect, vi } from "vitest";
import {
  FailoverCascade,
  FailoverExhaustedError,
  type FailoverConfig,
  type ProviderConfig,
} from "../src/failover.js";

function makeProvider(name: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name,
    baseUrl: `https://${name}.example.com`,
    apiKey: `key-${name}`,
    models: { haiku: `${name}-haiku`, sonnet: `${name}-sonnet`, opus: `${name}-opus` },
    maxLatencyMs: 10_000,
    costMultiplier: 1,
    ...overrides,
  };
}

function makeConfig(providers: ProviderConfig[]): FailoverConfig {
  return {
    providers,
    tiers: {
      full: { providerCount: Infinity, timeoutMs: 15_000 },
      standard: { providerCount: 2, timeoutMs: 10_000 },
      basic: { providerCount: 1, timeoutMs: 5_000 },
    },
  };
}

describe("FailoverCascade", () => {
  it("initializes with providers and creates circuit breakers", () => {
    const config = makeConfig([makeProvider("anthropic"), makeProvider("minimax")]);
    const cascade = new FailoverCascade(config);
    const health = cascade.getProviderHealth();
    expect(health).toHaveLength(2);
    expect(health[0]!.name).toBe("anthropic");
    expect(health[0]!.state).toBe("closed");
    expect(health[1]!.name).toBe("minimax");
  });

  it("getProviderHealth returns state and failure rate for each provider", () => {
    const config = makeConfig([makeProvider("anthropic")]);
    const cascade = new FailoverCascade(config);
    const health = cascade.getProviderHealth();
    expect(health[0]!.failureRate).toBe(0);
    expect(health[0]!.state).toBe("closed");
  });

  it("resetAll clears all circuit breakers", () => {
    const config = makeConfig([makeProvider("anthropic"), makeProvider("minimax")]);
    const cascade = new FailoverCascade(config);
    cascade.resetAll();
    const health = cascade.getProviderHealth();
    expect(health.every((h) => h.state === "closed")).toBe(true);
  });
});

describe("FailoverExhaustedError", () => {
  it("includes failed provider names", () => {
    const err = new FailoverExhaustedError(["anthropic", "minimax"]);
    expect(err.failedProviders).toEqual(["anthropic", "minimax"]);
    expect(err.message).toContain("anthropic");
    expect(err.message).toContain("minimax");
    expect(err.name).toBe("FailoverExhaustedError");
  });

  it("has empty list for no providers", () => {
    const err = new FailoverExhaustedError([]);
    expect(err.failedProviders).toEqual([]);
  });
});

describe("FailoverConfig tiers", () => {
  it("full tier allows all providers", () => {
    const config = makeConfig([
      makeProvider("a"),
      makeProvider("b"),
      makeProvider("c"),
    ]);
    expect(config.tiers.full.providerCount).toBe(Infinity);
    expect(config.tiers.full.timeoutMs).toBe(15_000);
  });

  it("standard tier limits to 2 providers", () => {
    const config = makeConfig([makeProvider("a")]);
    expect(config.tiers.standard.providerCount).toBe(2);
    expect(config.tiers.standard.timeoutMs).toBe(10_000);
  });

  it("basic tier limits to 1 provider", () => {
    const config = makeConfig([makeProvider("a")]);
    expect(config.tiers.basic.providerCount).toBe(1);
    expect(config.tiers.basic.timeoutMs).toBe(5_000);
  });
});
