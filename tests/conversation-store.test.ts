import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock pg.Pool
// ---------------------------------------------------------------------------

let queryResults: Record<string, unknown>[] = [];
let queryLog: Array<{ sql: string; args: unknown[] }> = [];

const mockQuery = vi.fn(async (sql: string, args?: unknown[]) => {
  queryLog.push({ sql, args: args ?? [] });

  // Auto-return RETURNING id rows
  if (sql.includes("RETURNING id")) {
    const nextId = queryResults.length > 0 ? queryResults.shift() : { id: 1 };
    return { rows: [nextId], rowCount: 1 };
  }

  // SELECT queries
  if (sql.trimStart().startsWith("SELECT")) {
    const rows = queryResults.splice(0);
    return { rows, rowCount: rows.length };
  }

  // DDL / UPDATE
  return { rows: [], rowCount: 0 };
});

const mockPool = {
  query: mockQuery,
  end: vi.fn(),
};

vi.mock("pg", () => ({
  default: { Pool: vi.fn(() => mockPool) },
}));

vi.mock("../src/db.js", () => ({
  getPool: () => mockPool,
  initPool: () => mockPool,
  closePool: async () => {},
}));

import {
  initConversationStore,
  upsertAccount,
  upsertContact,
  upsertThread,
  storeMessage,
  getThreadMessages,
  getThreads,
  linkContactToCRM,
} from "../src/conversation-store.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("conversation-store", () => {
  beforeEach(() => {
    mockQuery.mockClear();
    queryLog = [];
    queryResults = [];
  });

  describe("initConversationStore", () => {
    it("creates all 4 tables and 5 indexes", async () => {
      await initConversationStore(mockPool as never);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS gateway_accounts");
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS gateway_contacts");
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS gateway_threads");
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS gateway_messages");
      expect(sql).toContain("idx_messages_thread");
      expect(sql).toContain("idx_messages_account");
      expect(sql).toContain("idx_contacts_phone");
      expect(sql).toContain("idx_contacts_crm");
      expect(sql).toContain("idx_threads_account");
    });
  });

  describe("upsertAccount", () => {
    it("returns account id on insert", async () => {
      queryResults = [{ id: 42 }];
      const id = await upsertAccount("whatsapp", "main-account", undefined, mockPool as never);
      expect(id).toBe(42);
    });

    it("is idempotent (ON CONFLICT)", async () => {
      queryResults = [{ id: 42 }];
      await upsertAccount("whatsapp", "main-account", undefined, mockPool as never);

      const sql = queryLog[0].sql;
      expect(sql).toContain("ON CONFLICT");
      expect(sql).toContain("RETURNING id");
    });

    it("passes platform_id when provided", async () => {
      queryResults = [{ id: 5 }];
      await upsertAccount("whatsapp", "acct", "plat-123", mockPool as never);

      expect(queryLog[0].args).toContain("plat-123");
    });
  });

  describe("upsertContact", () => {
    it("returns contact id", async () => {
      queryResults = [{ id: 7 }];
      const id = await upsertContact("whatsapp", "+1234567890", undefined, mockPool as never);
      expect(id).toBe(7);
    });

    it("passes optional fields", async () => {
      queryResults = [{ id: 7 }];
      await upsertContact(
        "whatsapp",
        "+1234567890",
        { phone: "+1234567890", displayName: "Jane", pushName: "Janie" },
        mockPool as never,
      );

      const args = queryLog[0].args;
      expect(args).toContain("+1234567890");
      expect(args).toContain("Jane");
      expect(args).toContain("Janie");
    });

    it("uses ON CONFLICT for idempotency", async () => {
      queryResults = [{ id: 7 }];
      await upsertContact("whatsapp", "+1234567890", undefined, mockPool as never);
      expect(queryLog[0].sql).toContain("ON CONFLICT");
    });
  });

  describe("storeMessage", () => {
    it("inserts message and updates thread stats", async () => {
      queryResults = [{ id: 100 }];
      const id = await storeMessage(
        {
          threadId: 1,
          accountId: 2,
          messageId: "msg-001",
          fromJid: "+1234567890",
          text: "Hello",
          timestamp: "2026-04-27T10:00:00Z",
        },
        mockPool as never,
      );

      expect(id).toBe(100);
      // Should have 2 queries: INSERT + UPDATE thread stats
      expect(queryLog).toHaveLength(2);
      expect(queryLog[1].sql).toContain("UPDATE gateway_threads");
      expect(queryLog[1].sql).toContain("message_count = message_count + 1");
    });

    it("stores raw_payload as JSON", async () => {
      queryResults = [{ id: 101 }];
      await storeMessage(
        {
          threadId: 1,
          accountId: 2,
          messageId: "msg-002",
          fromJid: "+1234567890",
          timestamp: "2026-04-27T10:00:00Z",
          rawPayload: { key: "value" },
        },
        mockPool as never,
      );

      const args = queryLog[0].args;
      expect(args).toContain('{"key":"value"}');
    });
  });

  describe("getThreadMessages", () => {
    it("returns messages newest first", async () => {
      queryResults = [
        {
          id: 2,
          thread_id: 1,
          account_id: 1,
          message_id: "msg-002",
          from_jid: "+1234567890",
          from_me: false,
          text: "Second",
          push_name: "Jane",
          media_type: null,
          media_url: null,
          timestamp: "2026-04-27T11:00:00Z",
          is_historical: false,
          raw_payload: null,
          created_at: "2026-04-27T11:00:00Z",
        },
        {
          id: 1,
          thread_id: 1,
          account_id: 1,
          message_id: "msg-001",
          from_jid: "+1234567890",
          from_me: false,
          text: "First",
          push_name: "Jane",
          media_type: null,
          media_url: null,
          timestamp: "2026-04-27T10:00:00Z",
          is_historical: false,
          raw_payload: null,
          created_at: "2026-04-27T10:00:00Z",
        },
      ];

      const messages = await getThreadMessages(1, 50, 0, mockPool as never);

      expect(messages).toHaveLength(2);
      expect(messages[0].text).toBe("Second");
      expect(messages[1].text).toBe("First");
      expect(queryLog[0].sql).toContain("ORDER BY timestamp DESC");
    });
  });

  describe("getThreads", () => {
    it("joins with contacts and returns enriched threads", async () => {
      queryResults = [
        {
          id: 1,
          account_id: 1,
          contact_id: 5,
          group_jid: null,
          group_name: null,
          last_message: "2026-04-27T10:00:00Z",
          message_count: 3,
          contact_name: "Jane Doe",
          contact_phone: "+1234567890",
          contact_platform_jid: "+1234567890@s.whatsapp.net",
        },
      ];

      const threads = await getThreads({ accountId: 1 }, mockPool as never);

      expect(threads).toHaveLength(1);
      expect(threads[0].contactName).toBe("Jane Doe");
      expect(threads[0].messageCount).toBe(3);
      expect(queryLog[0].sql).toContain("JOIN gateway_contacts");
    });
  });

  describe("linkContactToCRM", () => {
    it("updates crm_person_id on contact", async () => {
      await linkContactToCRM(7, "crm-person-42", mockPool as never);

      expect(queryLog[0].sql).toContain("UPDATE gateway_contacts");
      expect(queryLog[0].args).toContain("crm-person-42");
      expect(queryLog[0].args).toContain(7);
    });
  });
});
