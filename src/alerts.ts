/**
 * Gateway degradation alerts.
 *
 * Monitors gateway health and fires alerts when service quality degrades.
 * Alerts are stored as memories, pushed to exec-assistant, and logged.
 */

export type AlertSeverity = "critical" | "warning" | "info";

export interface GatewayAlert {
  severity: AlertSeverity;
  trigger: string;
  description: string;
  failoverStatus?: string;
  impact?: string;
  actionNeeded?: string;
  timestamp: string;
}

export interface AlertConfig {
  /** p95 latency threshold in ms (default 5000) */
  latencyThresholdMs: number;
  /** Error rate threshold (default 0.10 = 10%) */
  errorRateThreshold: number;
  /** Window for rate calculations in ms (default 5min) */
  windowMs: number;
  /** Minimum events in window before evaluating (default 10) */
  minimumEvents: number;
}

const DEFAULT_ALERT_CONFIG: AlertConfig = {
  latencyThresholdMs: 5_000,
  errorRateThreshold: 0.10,
  windowMs: 5 * 60_000,
  minimumEvents: 10,
};

export type AlertHandler = (alert: GatewayAlert) => void;

interface EventRecord {
  timestamp: number;
  latencyMs: number;
  success: boolean;
}

export class AlertMonitor {
  private config: AlertConfig;
  private events: EventRecord[] = [];
  private handlers: AlertHandler[] = [];
  private activeAlerts = new Map<string, GatewayAlert>();

  constructor(config: Partial<AlertConfig> = {}) {
    this.config = { ...DEFAULT_ALERT_CONFIG, ...config };
  }

  /** Register an alert handler */
  onAlert(handler: AlertHandler): void {
    this.handlers.push(handler);
  }

  /** Record a request event for monitoring */
  recordEvent(latencyMs: number, success: boolean): void {
    const now = Date.now();
    this.events.push({ timestamp: now, latencyMs, success });
    this.pruneEvents(now);
    this.evaluate(now);
  }

  /** Manually fire a circuit breaker alert */
  alertCircuitOpen(providerName: string, failureRate: number): void {
    this.fireAlert({
      severity: "critical",
      trigger: `Circuit breaker open: ${providerName}`,
      description: `${providerName} API degraded (${(failureRate * 100).toFixed(0)}% failure rate)`,
      failoverStatus: "active — using fallback providers",
      impact: "Customer bots running on fallback model (may be lower quality)",
      actionNeeded: "None (auto-recovering). Alert clears when circuit closes.",
      timestamp: new Date().toISOString(),
    });
  }

  /** Manually fire an adapter disconnect alert */
  alertAdapterDisconnected(platform: string, error?: string): void {
    this.fireAlert({
      severity: "critical",
      trigger: `Adapter disconnected: ${platform}`,
      description: `${platform} connection lost${error ? `: ${error}` : ""}`,
      impact: `${platform} messages will not be received until reconnected`,
      actionNeeded: "Check connection credentials and restart adapter",
      timestamp: new Date().toISOString(),
    });
  }

  /** Manually fire an all-providers-degraded alert */
  alertAllDegraded(failedProviders: string[]): void {
    this.fireAlert({
      severity: "critical",
      trigger: "All providers degraded",
      description: `Gateway operating in degraded mode. Failed: ${failedProviders.join(", ")}`,
      impact: "Customer messages receiving degradation message instead of AI responses",
      actionNeeded: "Check API keys, provider status pages, and network connectivity",
      timestamp: new Date().toISOString(),
    });
  }

  /** Get currently active alerts */
  getActiveAlerts(): GatewayAlert[] {
    return [...this.activeAlerts.values()];
  }

  /** Clear an alert by trigger */
  clearAlert(trigger: string): void {
    this.activeAlerts.delete(trigger);
  }

  /** Get current metrics */
  getMetrics(): {
    eventCount: number;
    errorRate: number;
    p95LatencyMs: number;
    avgLatencyMs: number;
  } {
    this.pruneEvents(Date.now());
    if (this.events.length === 0) {
      return { eventCount: 0, errorRate: 0, p95LatencyMs: 0, avgLatencyMs: 0 };
    }

    const failures = this.events.filter((e) => !e.success).length;
    const errorRate = failures / this.events.length;

    const latencies = this.events
      .filter((e) => e.success)
      .map((e) => e.latencyMs)
      .sort((a, b) => a - b);

    const p95Idx = Math.floor(latencies.length * 0.95);
    const p95 = latencies[p95Idx] ?? 0;
    const avg =
      latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0;

    return {
      eventCount: this.events.length,
      errorRate,
      p95LatencyMs: p95,
      avgLatencyMs: avg,
    };
  }

  private evaluate(now: number): void {
    if (this.events.length < this.config.minimumEvents) return;

    const metrics = this.getMetrics();

    // High error rate
    if (metrics.errorRate > this.config.errorRateThreshold) {
      const key = "high-error-rate";
      if (!this.activeAlerts.has(key)) {
        this.fireAlert({
          severity: "warning",
          trigger: key,
          description: `Error rate ${(metrics.errorRate * 100).toFixed(1)}% exceeds ${(this.config.errorRateThreshold * 100).toFixed(0)}% threshold`,
          impact: "Some customer messages may fail",
          actionNeeded: "Monitor — if sustained, check provider health",
          timestamp: new Date(now).toISOString(),
        });
      }
    } else {
      this.clearAlert("high-error-rate");
    }

    // High latency
    if (metrics.p95LatencyMs > this.config.latencyThresholdMs) {
      const key = "high-latency";
      if (!this.activeAlerts.has(key)) {
        this.fireAlert({
          severity: "warning",
          trigger: key,
          description: `p95 latency ${metrics.p95LatencyMs}ms exceeds ${this.config.latencyThresholdMs}ms threshold`,
          impact: "Customer response times degraded",
          actionNeeded: "Consider failover to faster provider",
          timestamp: new Date(now).toISOString(),
        });
      }
    } else {
      this.clearAlert("high-latency");
    }
  }

  private fireAlert(alert: GatewayAlert): void {
    this.activeAlerts.set(alert.trigger, alert);
    for (const handler of this.handlers) {
      try {
        handler(alert);
      } catch {
        // Alert handler failure must never crash the gateway
      }
    }
  }

  private pruneEvents(now: number): void {
    const cutoff = now - this.config.windowMs;
    while (this.events.length > 0 && this.events[0]!.timestamp < cutoff) {
      this.events.shift();
    }
  }
}

/** Format an alert for logging/display */
export function formatAlert(alert: GatewayAlert): string {
  const emoji =
    alert.severity === "critical"
      ? "🔴"
      : alert.severity === "warning"
        ? "🟠"
        : "🟢";
  const lines = [
    `${emoji} GATEWAY ALERT: ${alert.trigger}`,
    `  ${alert.description}`,
  ];
  if (alert.failoverStatus) lines.push(`  Failover: ${alert.failoverStatus}`);
  if (alert.impact) lines.push(`  Impact: ${alert.impact}`);
  if (alert.actionNeeded) lines.push(`  Action: ${alert.actionNeeded}`);
  return lines.join("\n");
}
