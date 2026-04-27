import { describe, it, expect, vi, beforeEach } from "vitest";
import { AlertMonitor, formatAlert, type GatewayAlert } from "../src/alerts.js";

describe("AlertMonitor", () => {
  let monitor: AlertMonitor;

  beforeEach(() => {
    monitor = new AlertMonitor({
      latencyThresholdMs: 1000,
      errorRateThreshold: 0.3,
      windowMs: 10_000,
      minimumEvents: 5,
    });
  });

  describe("circuit breaker alerts", () => {
    it("fires circuit open alert", () => {
      const alerts: GatewayAlert[] = [];
      monitor.onAlert((a) => alerts.push(a));
      monitor.alertCircuitOpen("anthropic", 0.78);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.severity).toBe("critical");
      expect(alerts[0]!.trigger).toContain("anthropic");
      expect(alerts[0]!.description).toContain("78%");
    });
  });

  describe("adapter disconnect alerts", () => {
    it("fires disconnect alert", () => {
      const alerts: GatewayAlert[] = [];
      monitor.onAlert((a) => alerts.push(a));
      monitor.alertAdapterDisconnected("whatsapp", "connection reset");

      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.severity).toBe("critical");
      expect(alerts[0]!.trigger).toContain("whatsapp");
      expect(alerts[0]!.description).toContain("connection reset");
    });
  });

  describe("all degraded alerts", () => {
    it("fires all-degraded alert", () => {
      const alerts: GatewayAlert[] = [];
      monitor.onAlert((a) => alerts.push(a));
      monitor.alertAllDegraded(["anthropic", "minimax"]);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.severity).toBe("critical");
      expect(alerts[0]!.description).toContain("anthropic");
      expect(alerts[0]!.description).toContain("minimax");
    });
  });

  describe("automatic threshold alerts", () => {
    it("fires high error rate alert when threshold exceeded", () => {
      const alerts: GatewayAlert[] = [];
      monitor.onAlert((a) => alerts.push(a));

      // Record 5 events: 3 failures = 60% > 30% threshold
      monitor.recordEvent(100, true);
      monitor.recordEvent(100, true);
      monitor.recordEvent(100, false);
      monitor.recordEvent(100, false);
      monitor.recordEvent(100, false);

      expect(alerts.some((a) => a.trigger === "high-error-rate")).toBe(true);
    });

    it("does not fire below minimum events", () => {
      const alerts: GatewayAlert[] = [];
      monitor.onAlert((a) => alerts.push(a));

      // Only 3 events (below minimum of 5)
      monitor.recordEvent(100, false);
      monitor.recordEvent(100, false);
      monitor.recordEvent(100, false);

      expect(alerts).toHaveLength(0);
    });

    it("fires high latency alert when p95 exceeds threshold", () => {
      const alerts: GatewayAlert[] = [];
      monitor.onAlert((a) => alerts.push(a));

      // 5 events with high latency
      monitor.recordEvent(2000, true);
      monitor.recordEvent(2000, true);
      monitor.recordEvent(2000, true);
      monitor.recordEvent(2000, true);
      monitor.recordEvent(2000, true);

      expect(alerts.some((a) => a.trigger === "high-latency")).toBe(true);
    });

    it("does not fire duplicate alerts", () => {
      const alerts: GatewayAlert[] = [];
      monitor.onAlert((a) => alerts.push(a));

      for (let i = 0; i < 10; i++) {
        monitor.recordEvent(100, false);
      }

      const errorAlerts = alerts.filter((a) => a.trigger === "high-error-rate");
      expect(errorAlerts).toHaveLength(1);
    });

    it("clears alert when condition resolves", () => {
      // First trigger the alert
      for (let i = 0; i < 5; i++) {
        monitor.recordEvent(100, false);
      }
      expect(monitor.getActiveAlerts().some((a) => a.trigger === "high-error-rate")).toBe(true);

      // Now clear by adding many successes (old failures fall off)
      vi.useFakeTimers();
      vi.advanceTimersByTime(11_000); // Past window
      for (let i = 0; i < 5; i++) {
        monitor.recordEvent(100, true);
      }
      expect(monitor.getActiveAlerts().some((a) => a.trigger === "high-error-rate")).toBe(false);
      vi.useRealTimers();
    });
  });

  describe("getMetrics", () => {
    it("returns zeros for no events", () => {
      const m = monitor.getMetrics();
      expect(m.eventCount).toBe(0);
      expect(m.errorRate).toBe(0);
      expect(m.p95LatencyMs).toBe(0);
    });

    it("calculates metrics correctly", () => {
      monitor.recordEvent(100, true);
      monitor.recordEvent(200, true);
      monitor.recordEvent(300, true);
      monitor.recordEvent(400, true);
      monitor.recordEvent(500, false);

      const m = monitor.getMetrics();
      expect(m.eventCount).toBe(5);
      expect(m.errorRate).toBeCloseTo(0.2);
      expect(m.avgLatencyMs).toBe(250); // (100+200+300+400)/4 successes
    });
  });

  describe("getActiveAlerts / clearAlert", () => {
    it("tracks active alerts", () => {
      monitor.alertCircuitOpen("anthropic", 0.8);
      expect(monitor.getActiveAlerts()).toHaveLength(1);

      monitor.clearAlert("Circuit breaker open: anthropic");
      expect(monitor.getActiveAlerts()).toHaveLength(0);
    });
  });
});

describe("formatAlert", () => {
  it("formats critical alert with emoji", () => {
    const alert: GatewayAlert = {
      severity: "critical",
      trigger: "test",
      description: "Test alert",
      failoverStatus: "active",
      impact: "None",
      actionNeeded: "Nothing",
      timestamp: new Date().toISOString(),
    };
    const formatted = formatAlert(alert);
    expect(formatted).toContain("🔴");
    expect(formatted).toContain("test");
    expect(formatted).toContain("Failover: active");
  });

  it("formats warning alert with emoji", () => {
    const formatted = formatAlert({
      severity: "warning",
      trigger: "latency",
      description: "Slow",
      timestamp: new Date().toISOString(),
    });
    expect(formatted).toContain("🟠");
  });

  it("formats info alert with emoji", () => {
    const formatted = formatAlert({
      severity: "info",
      trigger: "resolved",
      description: "All clear",
      timestamp: new Date().toISOString(),
    });
    expect(formatted).toContain("🟢");
  });
});
