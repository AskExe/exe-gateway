import { describe, it, expect, beforeEach, vi } from "vitest";
import { RateLimiter } from "../src/rate-limiter.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      messagesPerMinute: 3,
      globalMessagesPerMinute: 5,
    });
  });

  it("allows messages under the per-sender limit", () => {
    expect(limiter.check("user-1").allowed).toBe(true);
    expect(limiter.check("user-1").allowed).toBe(true);
    expect(limiter.check("user-1").allowed).toBe(true);
  });

  it("blocks messages over the per-sender limit", () => {
    limiter.check("user-1");
    limiter.check("user-1");
    limiter.check("user-1");
    const result = limiter.check("user-1");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("too quickly");
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks senders independently", () => {
    limiter.check("user-1");
    limiter.check("user-1");
    limiter.check("user-1");
    expect(limiter.check("user-1").allowed).toBe(false);
    expect(limiter.check("user-2").allowed).toBe(true);
  });

  it("blocks messages over the global limit", () => {
    limiter.check("user-1");
    limiter.check("user-1");
    limiter.check("user-1");
    limiter.check("user-2");
    limiter.check("user-2");
    const result = limiter.check("user-3");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("too many messages");
  });

  it("allows messages after window expires", () => {
    vi.useFakeTimers();
    limiter.check("user-1");
    limiter.check("user-1");
    limiter.check("user-1");
    expect(limiter.check("user-1").allowed).toBe(false);

    vi.advanceTimersByTime(61_000);
    expect(limiter.check("user-1").allowed).toBe(true);
    vi.useRealTimers();
  });

  it("sliding window does not reset all at once", () => {
    vi.useFakeTimers();
    limiter.check("user-1"); // t=0
    vi.advanceTimersByTime(20_000);
    limiter.check("user-1"); // t=20s
    vi.advanceTimersByTime(20_000);
    limiter.check("user-1"); // t=40s
    expect(limiter.check("user-1").allowed).toBe(false); // at capacity

    // After 21s more (t=61s), first message falls off
    vi.advanceTimersByTime(21_000);
    expect(limiter.check("user-1").allowed).toBe(true);
    vi.useRealTimers();
  });

  it("reset clears all state", () => {
    limiter.check("user-1");
    limiter.check("user-1");
    limiter.check("user-1");
    expect(limiter.check("user-1").allowed).toBe(false);
    limiter.reset();
    expect(limiter.check("user-1").allowed).toBe(true);
  });

  it("stats returns current counts", () => {
    limiter.check("user-1");
    limiter.check("user-2");
    limiter.check("user-2");
    const s = limiter.stats();
    expect(s.globalCount).toBe(3);
    expect(s.globalLimit).toBe(5);
    expect(s.senderCounts.get("user-1")).toBe(1);
    expect(s.senderCounts.get("user-2")).toBe(2);
  });

  it("uses default config when none provided", () => {
    const defaultLimiter = new RateLimiter();
    // Should allow up to 10 per sender
    for (let i = 0; i < 10; i++) {
      expect(defaultLimiter.check("user-1").allowed).toBe(true);
    }
    expect(defaultLimiter.check("user-1").allowed).toBe(false);
  });
});
