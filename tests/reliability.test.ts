import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  retryWithBackoff,
  CircuitBreaker,
  buildDegradationMessage,
} from "../src/reliability.js";

describe("retryWithBackoff", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { baseDelayMs: 1, maxDelayMs: 2 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(
      retryWithBackoff(fn, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 }),
    ).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("wraps non-Error throws", async () => {
    const fn = vi.fn().mockRejectedValue("string error");
    await expect(
      retryWithBackoff(fn, { maxRetries: 0 }),
    ).rejects.toThrow("string error");
  });
});

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker("test-provider", {
      windowMs: 60_000,
      failureThreshold: 0.5,
      minimumRequests: 4,
      halfOpenAfterMs: 5_000,
    });
  });

  it("starts in closed state", () => {
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canRequest()).toBe(true);
  });

  it("stays closed below failure threshold", () => {
    breaker.recordSuccess();
    breaker.recordSuccess();
    breaker.recordSuccess();
    breaker.recordFailure();
    // 1/4 = 25% < 50% threshold
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canRequest()).toBe(true);
  });

  it("opens when failure rate exceeds threshold", () => {
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    // 3/4 = 75% > 50% threshold
    expect(breaker.getState()).toBe("open");
    expect(breaker.canRequest()).toBe(false);
  });

  it("does not evaluate until minimum requests reached", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    // 3/3 = 100% but below minimumRequests (4)
    expect(breaker.getState()).toBe("closed");
  });

  it("transitions to half-open after timeout", () => {
    vi.useFakeTimers();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");

    vi.advanceTimersByTime(5_001);
    expect(breaker.getState()).toBe("half-open");
    expect(breaker.canRequest()).toBe(true);
    vi.useRealTimers();
  });

  it("closes from half-open on success", () => {
    vi.useFakeTimers();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    vi.advanceTimersByTime(5_001);
    expect(breaker.getState()).toBe("half-open");

    breaker.recordSuccess();
    expect(breaker.getState()).toBe("closed");
    vi.useRealTimers();
  });

  it("re-opens from half-open on failure", () => {
    vi.useFakeTimers();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    vi.advanceTimersByTime(5_001);
    expect(breaker.getState()).toBe("half-open");

    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    vi.useRealTimers();
  });

  it("getFailureRate returns correct rate", () => {
    breaker.recordSuccess();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.getFailureRate()).toBeCloseTo(1 / 3);
  });

  it("getFailureRate returns 0 with no records", () => {
    expect(breaker.getFailureRate()).toBe(0);
  });

  it("reset clears state", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    breaker.reset();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.getFailureRate()).toBe(0);
  });

  it("prunes old records outside window", () => {
    vi.useFakeTimers();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    // Would be open, but advance past window
    vi.advanceTimersByTime(61_000);
    // Records pruned, failure rate is 0
    expect(breaker.getFailureRate()).toBe(0);
    vi.useRealTimers();
  });
});

describe("buildDegradationMessage", () => {
  it("returns a helpful message", () => {
    const msg = buildDegradationMessage();
    expect(msg).toContain("trouble");
    expect(msg).toContain("human");
  });
});
