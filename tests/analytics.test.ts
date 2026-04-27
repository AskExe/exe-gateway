import { describe, it, expect, beforeEach } from "vitest";
import { AnalyticsCollector } from "../src/analytics.js";

describe("AnalyticsCollector", () => {
  let collector: AnalyticsCollector;
  const today = new Date().toISOString().split("T")[0]!;

  beforeEach(() => {
    collector = new AnalyticsCollector();
  });

  describe("recording events", () => {
    it("records conversation starts", () => {
      collector.conversationStarted("whatsapp", "signup-bot");
      expect(collector.eventCount()).toBe(1);
    });

    it("records responses", () => {
      collector.responseRecorded("whatsapp", "signup-bot", 500, 100, 200, "anthropic", true);
      expect(collector.eventCount()).toBe(1);
    });

    it("records escalations", () => {
      collector.escalationRecorded("whatsapp", "receptionist");
      expect(collector.eventCount()).toBe(1);
    });
  });

  describe("getDailyStats", () => {
    it("returns empty array for no events", () => {
      expect(collector.getDailyStats()).toEqual([]);
    });

    it("aggregates by platform and bot", () => {
      collector.conversationStarted("whatsapp", "signup-bot");
      collector.responseRecorded("whatsapp", "signup-bot", 400, 50, 100, "anthropic", true);
      collector.responseRecorded("whatsapp", "signup-bot", 600, 50, 100, "anthropic", true);

      collector.conversationStarted("signal", "exec-assistant");
      collector.responseRecorded("signal", "exec-assistant", 800, 200, 500, "anthropic", true);

      const stats = collector.getDailyStats(today);
      expect(stats).toHaveLength(2);

      const wa = stats.find((s) => s.platform === "whatsapp")!;
      expect(wa.conversations).toBe(1);
      expect(wa.messages).toBe(2);
      expect(wa.avgLatencyMs).toBe(500);
      expect(wa.totalInputTokens).toBe(100);
      expect(wa.totalOutputTokens).toBe(200);

      const sig = stats.find((s) => s.platform === "signal")!;
      expect(sig.conversations).toBe(1);
      expect(sig.messages).toBe(1);
      expect(sig.avgLatencyMs).toBe(800);
    });

    it("counts escalations", () => {
      collector.conversationStarted("whatsapp", "receptionist");
      collector.escalationRecorded("whatsapp", "receptionist");
      collector.escalationRecorded("whatsapp", "receptionist");

      const stats = collector.getDailyStats(today);
      expect(stats[0]!.escalationCount).toBe(2);
    });

    it("counts errors", () => {
      collector.responseRecorded("whatsapp", "bot", 0, 0, 0, "anthropic", false);
      collector.responseRecorded("whatsapp", "bot", 500, 50, 100, "anthropic", true);

      const stats = collector.getDailyStats(today);
      expect(stats[0]!.errorCount).toBe(1);
    });

    it("calculates avg messages per conversation", () => {
      collector.conversationStarted("whatsapp", "bot");
      collector.conversationStarted("whatsapp", "bot");
      collector.responseRecorded("whatsapp", "bot", 400, 50, 100, "anthropic", true);
      collector.responseRecorded("whatsapp", "bot", 400, 50, 100, "anthropic", true);
      collector.responseRecorded("whatsapp", "bot", 400, 50, 100, "anthropic", true);
      collector.responseRecorded("whatsapp", "bot", 400, 50, 100, "anthropic", true);

      const stats = collector.getDailyStats(today);
      expect(stats[0]!.avgMessagesPerConversation).toBe(2);
    });
  });

  describe("getSummary", () => {
    it("returns zeros for no events", () => {
      const summary = collector.getSummary();
      expect(summary.totalConversations).toBe(0);
      expect(summary.totalMessages).toBe(0);
      expect(summary.avgLatencyMs).toBe(0);
      expect(summary.escalationRate).toBe(0);
      expect(summary.errorRate).toBe(0);
    });

    it("aggregates across all bots", () => {
      collector.conversationStarted("whatsapp", "signup-bot");
      collector.responseRecorded("whatsapp", "signup-bot", 400, 50, 100, "anthropic", true);
      collector.conversationStarted("signal", "ea");
      collector.responseRecorded("signal", "ea", 800, 200, 500, "anthropic", true);

      const summary = collector.getSummary();
      expect(summary.totalConversations).toBe(2);
      expect(summary.totalMessages).toBe(2);
      expect(summary.avgLatencyMs).toBe(600); // (400+800)/2
      expect(summary.totalInputTokens).toBe(250);
      expect(summary.totalOutputTokens).toBe(600);
    });

    it("calculates escalation rate", () => {
      collector.conversationStarted("whatsapp", "receptionist");
      collector.conversationStarted("whatsapp", "receptionist");
      collector.escalationRecorded("whatsapp", "receptionist");

      const summary = collector.getSummary();
      expect(summary.escalationRate).toBe(0.5);
    });
  });

  describe("prune", () => {
    it("returns 0 when no events to prune", () => {
      expect(collector.prune()).toBe(0);
    });

    it("does not prune recent events", () => {
      collector.conversationStarted("whatsapp", "bot");
      expect(collector.prune()).toBe(0);
      expect(collector.eventCount()).toBe(1);
    });
  });
});
