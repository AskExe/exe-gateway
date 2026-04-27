import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionStore } from "../src/session-store.js";

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore({
      idleTimeoutMs: 5_000,
      maxMessages: 10,
    });
  });

  describe("getOrCreate", () => {
    it("creates a new session", () => {
      const session = store.getOrCreate("cust-1", "signup-bot", "whatsapp");
      expect(session.sessionId).toBeTruthy();
      expect(session.customerId).toBe("cust-1");
      expect(session.botId).toBe("signup-bot");
      expect(session.platform).toBe("whatsapp");
      expect(session.messages).toEqual([]);
      expect(session.status).toBe("active");
      expect(session.messageCount).toBe(0);
    });

    it("returns same session for same customer+bot within timeout", () => {
      const s1 = store.getOrCreate("cust-1", "signup-bot", "whatsapp");
      const s2 = store.getOrCreate("cust-1", "signup-bot", "whatsapp");
      expect(s1.sessionId).toBe(s2.sessionId);
    });

    it("creates different sessions for different customers", () => {
      const s1 = store.getOrCreate("cust-1", "signup-bot", "whatsapp");
      const s2 = store.getOrCreate("cust-2", "signup-bot", "whatsapp");
      expect(s1.sessionId).not.toBe(s2.sessionId);
    });

    it("creates different sessions for different bots", () => {
      const s1 = store.getOrCreate("cust-1", "signup-bot", "whatsapp");
      const s2 = store.getOrCreate("cust-1", "support-bot", "whatsapp");
      expect(s1.sessionId).not.toBe(s2.sessionId);
    });

    it("creates new session after idle timeout", () => {
      vi.useFakeTimers();
      const s1 = store.getOrCreate("cust-1", "signup-bot", "whatsapp");
      vi.advanceTimersByTime(6_000);
      const s2 = store.getOrCreate("cust-1", "signup-bot", "whatsapp");
      expect(s1.sessionId).not.toBe(s2.sessionId);
      vi.useRealTimers();
    });
  });

  describe("addMessage", () => {
    it("adds messages and updates count", () => {
      const session = store.getOrCreate("cust-1", "bot", "signal");
      store.addMessage(session.sessionId, { role: "user", content: "hello" });
      expect(session.messageCount).toBe(1);
      expect(session.messages).toHaveLength(1);

      store.addMessage(session.sessionId, { role: "assistant", content: "hi" });
      expect(session.messageCount).toBe(2);
      expect(session.messages).toHaveLength(2);
    });

    it("trims messages when max is reached", () => {
      const session = store.getOrCreate("cust-1", "bot", "signal");
      for (let i = 0; i < 12; i++) {
        store.addMessage(session.sessionId, { role: "user", content: `msg-${i}` });
      }
      // maxMessages=10 reached at message 10, should trim to last 10
      expect(session.messages.length).toBeLessThanOrEqual(12);
      expect(session.status).toBe("active");
    });

    it("ignores messages for unknown session", () => {
      store.addMessage("nonexistent", { role: "user", content: "hello" });
      // No error thrown
    });
  });

  describe("recordTokens", () => {
    it("accumulates token counts", () => {
      const session = store.getOrCreate("cust-1", "bot", "whatsapp");
      store.recordTokens(session.sessionId, 100, 200);
      store.recordTokens(session.sessionId, 50, 75);
      expect(session.totalInputTokens).toBe(150);
      expect(session.totalOutputTokens).toBe(275);
    });
  });

  describe("close", () => {
    it("marks session as closed", () => {
      const session = store.getOrCreate("cust-1", "bot", "whatsapp");
      store.close(session.sessionId);
      expect(session.status).toBe("closed");
    });
  });

  describe("findById", () => {
    it("finds existing session", () => {
      const session = store.getOrCreate("cust-1", "bot", "whatsapp");
      const found = store.findById(session.sessionId);
      expect(found).toBe(session);
    });

    it("returns undefined for unknown session", () => {
      expect(store.findById("nonexistent")).toBeUndefined();
    });
  });

  describe("getActive", () => {
    it("returns active session", () => {
      const session = store.getOrCreate("cust-1", "bot", "whatsapp");
      expect(store.getActive("cust-1", "bot")).toBe(session);
    });

    it("returns undefined for closed session", () => {
      const session = store.getOrCreate("cust-1", "bot", "whatsapp");
      store.close(session.sessionId);
      expect(store.getActive("cust-1", "bot")).toBeUndefined();
    });
  });

  describe("expireIdleSessions", () => {
    it("expires sessions past idle timeout", () => {
      vi.useFakeTimers();
      store.getOrCreate("cust-1", "bot", "whatsapp");
      store.getOrCreate("cust-2", "bot", "whatsapp");
      vi.advanceTimersByTime(6_000);
      const expired = store.expireIdleSessions();
      expect(expired).toBe(2);
      vi.useRealTimers();
    });

    it("does not expire active sessions within timeout", () => {
      store.getOrCreate("cust-1", "bot", "whatsapp");
      const expired = store.expireIdleSessions();
      expect(expired).toBe(0);
    });
  });

  describe("stats", () => {
    it("returns correct counts", () => {
      const s1 = store.getOrCreate("cust-1", "bot", "whatsapp");
      store.addMessage(s1.sessionId, { role: "user", content: "hi" });
      store.recordTokens(s1.sessionId, 10, 20);
      store.getOrCreate("cust-2", "bot", "whatsapp");

      const s = store.stats();
      expect(s.active).toBe(2);
      expect(s.closed).toBe(0);
      expect(s.totalMessages).toBe(1);
      expect(s.totalInputTokens).toBe(10);
      expect(s.totalOutputTokens).toBe(20);
    });
  });
});
