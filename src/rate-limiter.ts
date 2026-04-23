/**
 * Gateway rate limiter — sliding window algorithm.
 *
 * Prevents abuse with per-sender and global limits.
 * Uses a sliding window (not fixed window) to prevent burst at boundaries.
 */

export interface RateLimitConfig {
  /** Max messages per minute per sender (default 10) */
  messagesPerMinute: number;
  /** Global max messages per minute across all senders (default 100) */
  globalMessagesPerMinute: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: string;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  messagesPerMinute: 10,
  globalMessagesPerMinute: 100,
};

const WINDOW_MS = 60_000;

export class RateLimiter {
  private senderWindows = new Map<string, number[]>();
  private globalWindow: number[] = [];
  private config: RateLimitConfig;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a message from the given sender is allowed.
   * If allowed, records the timestamp. If not, returns retry info.
   */
  check(senderId: string): RateLimitResult {
    const now = Date.now();
    this.pruneWindow(this.globalWindow, now);

    // Global limit check
    if (this.globalWindow.length >= this.config.globalMessagesPerMinute) {
      const oldest = this.globalWindow[0]!;
      return {
        allowed: false,
        retryAfterMs: oldest + WINDOW_MS - now,
        reason: "Gateway is receiving too many messages. Please wait a moment.",
      };
    }

    // Per-sender limit check
    if (!this.senderWindows.has(senderId)) {
      this.senderWindows.set(senderId, []);
    }
    const senderWindow = this.senderWindows.get(senderId)!;
    this.pruneWindow(senderWindow, now);

    if (senderWindow.length >= this.config.messagesPerMinute) {
      const oldest = senderWindow[0]!;
      return {
        allowed: false,
        retryAfterMs: oldest + WINDOW_MS - now,
        reason: "You're sending messages too quickly. Please wait a moment.",
      };
    }

    // Record this message
    senderWindow.push(now);
    this.globalWindow.push(now);
    return { allowed: true };
  }

  /** Get current usage stats */
  stats(): {
    globalCount: number;
    globalLimit: number;
    senderCounts: Map<string, number>;
  } {
    const now = Date.now();
    this.pruneWindow(this.globalWindow, now);
    const senderCounts = new Map<string, number>();
    for (const [id, window] of this.senderWindows) {
      this.pruneWindow(window, now);
      if (window.length > 0) {
        senderCounts.set(id, window.length);
      }
    }
    return {
      globalCount: this.globalWindow.length,
      globalLimit: this.config.globalMessagesPerMinute,
      senderCounts,
    };
  }

  /** Reset all rate limit state */
  reset(): void {
    this.senderWindows.clear();
    this.globalWindow = [];
  }

  private pruneWindow(window: number[], now: number): void {
    const cutoff = now - WINDOW_MS;
    while (window.length > 0 && window[0]! < cutoff) {
      window.shift();
    }
  }
}
