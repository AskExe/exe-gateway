/**
 * Gateway reliability — health checks, retry with backoff, circuit breaker.
 *
 * Customer-facing means no drops. This module provides:
 * 1. Health checks per adapter + per bot
 * 2. Retry with exponential backoff (1s, 2s, 4s — max 3 retries)
 * 3. Basic circuit breaker (sliding window failure tracking)
 */

/** Health status for an individual component */
export interface HealthStatus {
  name: string;
  healthy: boolean;
  latencyMs?: number;
  lastError?: string;
  lastCheckAt: string;
}

/** Aggregated gateway health */
export interface GatewayHealth {
  healthy: boolean;
  adapters: HealthStatus[];
  bots: HealthStatus[];
  uptime: number;
}

// --- Retry with backoff ---

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 4000,
};

/**
 * Retry an async function with exponential backoff.
 * Returns the result on success, or throws the last error after all retries fail.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = {
    ...DEFAULT_RETRY,
    ...config,
  };

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// --- Circuit Breaker ---

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** Sliding window duration in ms (default 60s) */
  windowMs: number;
  /** Failure rate threshold to open circuit (default 0.5 = 50%) */
  failureThreshold: number;
  /** Minimum requests in window before evaluating (default 5) */
  minimumRequests: number;
  /** Time in ms before transitioning from open to half-open (default 30s) */
  halfOpenAfterMs: number;
}

const DEFAULT_CIRCUIT: CircuitBreakerConfig = {
  windowMs: 60_000,
  failureThreshold: 0.5,
  minimumRequests: 5,
  halfOpenAfterMs: 30_000,
};

interface RequestRecord {
  timestamp: number;
  success: boolean;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private records: RequestRecord[] = [];
  private lastStateChange = Date.now();
  private config: CircuitBreakerConfig;
  readonly name: string;

  constructor(name: string, config: Partial<CircuitBreakerConfig> = {}) {
    this.name = name;
    this.config = { ...DEFAULT_CIRCUIT, ...config };
  }

  /** Check if a request should be allowed through */
  canRequest(): boolean {
    this.pruneRecords();

    if (this.state === "closed") return true;

    if (this.state === "open") {
      const elapsed = Date.now() - this.lastStateChange;
      if (elapsed >= this.config.halfOpenAfterMs) {
        this.transition("half-open");
        return true; // Allow one test request
      }
      return false;
    }

    // half-open: allow one request at a time
    return true;
  }

  /** Record a successful request */
  recordSuccess(): void {
    this.records.push({ timestamp: Date.now(), success: true });
    if (this.state === "half-open") {
      this.transition("closed");
    }
  }

  /** Record a failed request */
  recordFailure(): void {
    this.records.push({ timestamp: Date.now(), success: false });

    if (this.state === "half-open") {
      this.transition("open");
      return;
    }

    if (this.state === "closed") {
      this.pruneRecords();
      if (this.records.length >= this.config.minimumRequests) {
        const failures = this.records.filter((r) => !r.success).length;
        const rate = failures / this.records.length;
        if (rate >= this.config.failureThreshold) {
          this.transition("open");
        }
      }
    }
  }

  /** Get current circuit state */
  getState(): CircuitState {
    // Check for auto-transition to half-open
    if (this.state === "open") {
      const elapsed = Date.now() - this.lastStateChange;
      if (elapsed >= this.config.halfOpenAfterMs) {
        this.transition("half-open");
      }
    }
    return this.state;
  }

  /** Get failure rate in current window */
  getFailureRate(): number {
    this.pruneRecords();
    if (this.records.length === 0) return 0;
    const failures = this.records.filter((r) => !r.success).length;
    return failures / this.records.length;
  }

  /** Reset the circuit breaker */
  reset(): void {
    this.records = [];
    this.transition("closed");
  }

  private transition(newState: CircuitState): void {
    this.state = newState;
    this.lastStateChange = Date.now();
  }

  private pruneRecords(): void {
    const cutoff = Date.now() - this.config.windowMs;
    while (this.records.length > 0 && this.records[0]!.timestamp < cutoff) {
      this.records.shift();
    }
  }
}

/**
 * Build a graceful degradation message for customers.
 */
export function buildDegradationMessage(): string {
  return "I'm having trouble right now. Let me get a human to help you.";
}
