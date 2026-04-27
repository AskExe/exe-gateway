import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock pg.Pool
// ---------------------------------------------------------------------------

const mockQuery = vi.fn(async (sql: string, _args?: unknown[]) => {
  if (sql.includes("RETURNING id")) {
    return { rows: [{ id: 1 }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
});

const mockClientQuery = vi.fn(async (sql: string, _args?: unknown[]) => {
  return { rows: [], rowCount: 0 };
});

const mockRelease = vi.fn();

const mockPool = {
  query: mockQuery,
  connect: vi.fn(async () => ({
    query: mockClientQuery,
    release: mockRelease,
  })),
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

// Mock conversation-store
const mockUpsertContact = vi.fn().mockResolvedValue(42);
const mockLinkContactToCRM = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/conversation-store.js", () => ({
  upsertContact: (...args: unknown[]) => mockUpsertContact(...args),
  linkContactToCRM: (...args: unknown[]) => mockLinkContactToCRM(...args),
}));

// Mock crm-bridge
const mockFindPersonByContact = vi.fn();
const mockIsCRMBridgeEnabled = vi.fn();
vi.mock("../src/crm-bridge.js", () => ({
  findPersonByContact: (...args: unknown[]) => mockFindPersonByContact(...args),
  isCRMBridgeEnabled: () => mockIsCRMBridgeEnabled(),
}));

import {
  parsePhoneFromJid,
  importContactFromMessage,
  bulkImportContacts,
  tryCRMLink,
} from "../src/contact-importer.js";
import type { NormalizedMessage } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: "msg-001",
    platform: "whatsapp",
    senderId: "5511999990000@s.whatsapp.net",
    senderName: "Jane Doe",
    channelId: "ch-001",
    chatType: "direct",
    text: "Hello",
    timestamp: "2026-04-27T10:00:00Z",
    raw: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parsePhoneFromJid", () => {
  it("parses standard WhatsApp JID", () => {
    expect(parsePhoneFromJid("5511999990000@s.whatsapp.net")).toBe("+5511999990000");
  });

  it("strips device suffix", () => {
    expect(parsePhoneFromJid("5511999990000:42@s.whatsapp.net")).toBe("+5511999990000");
  });

  it("returns null for group JID", () => {
    expect(parsePhoneFromJid("120363123456789@g.us")).toBeNull();
  });

  it("returns null for broadcast JID", () => {
    expect(parsePhoneFromJid("status@broadcast")).toBeNull();
  });

  it("returns null for non-numeric senderId", () => {
    expect(parsePhoneFromJid("user@signal.org")).toBeNull();
  });

  it("handles bare phone numbers (non-WhatsApp)", () => {
    expect(parsePhoneFromJid("5511999990000")).toBe("+5511999990000");
  });

  it("returns null for very short numbers", () => {
    expect(parsePhoneFromJid("123")).toBeNull();
  });
});

describe("importContactFromMessage", () => {
  beforeEach(() => {
    mockUpsertContact.mockClear().mockResolvedValue(42);
  });

  it("upserts contact and returns ID", async () => {
    const msg = makeMsg();
    const id = await importContactFromMessage(msg);

    expect(id).toBe(42);
    expect(mockUpsertContact).toHaveBeenCalledWith(
      "whatsapp",
      "5511999990000@s.whatsapp.net",
      expect.objectContaining({
        phone: "+5511999990000",
        displayName: "Jane Doe",
        pushName: "Jane Doe",
      }),
      expect.anything(),
    );
  });

  it("uses senderPhone when available", async () => {
    const msg = makeMsg({ senderPhone: "+5511888880000" });
    await importContactFromMessage(msg);

    expect(mockUpsertContact).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ phone: "+5511888880000" }),
      expect.anything(),
    );
  });

  it("handles unparseable JID gracefully", async () => {
    const msg = makeMsg({ senderId: "user@signal.org" });
    const id = await importContactFromMessage(msg);

    expect(id).toBe(42);
    // phone should be undefined (parsed as null, passed as undefined)
    expect(mockUpsertContact).toHaveBeenCalledWith(
      expect.anything(),
      "user@signal.org",
      expect.objectContaining({ phone: undefined }),
      expect.anything(),
    );
  });
});

describe("bulkImportContacts", () => {
  beforeEach(() => {
    mockClientQuery.mockClear();
    mockRelease.mockClear();
  });

  it("upserts all contacts in a transaction", async () => {
    const contacts = [
      { platformJid: "5511111111111@s.whatsapp.net", displayName: "Alice" },
      { platformJid: "5522222222222@s.whatsapp.net", displayName: "Bob" },
    ];

    const count = await bulkImportContacts("whatsapp", contacts);

    expect(count).toBe(2);
    // BEGIN + 2 inserts + COMMIT = 4 queries
    expect(mockClientQuery).toHaveBeenCalledTimes(4);
    expect(mockClientQuery.mock.calls[0][0]).toBe("BEGIN");
    expect(mockClientQuery.mock.calls[3][0]).toBe("COMMIT");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("returns 0 for empty array", async () => {
    const count = await bulkImportContacts("whatsapp", []);
    expect(count).toBe(0);
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it("rolls back on error", async () => {
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValueOnce(new Error("DB error")); // first INSERT fails

    await expect(
      bulkImportContacts("whatsapp", [
        { platformJid: "5511111111111@s.whatsapp.net" },
      ]),
    ).rejects.toThrow("DB error");

    expect(mockClientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(mockRelease).toHaveBeenCalled();
  });
});

describe("tryCRMLink", () => {
  beforeEach(() => {
    mockFindPersonByContact.mockReset();
    mockIsCRMBridgeEnabled.mockReset();
    mockLinkContactToCRM.mockClear();
  });

  it("links contact when CRM person found", async () => {
    mockIsCRMBridgeEnabled.mockReturnValue(true);
    mockFindPersonByContact.mockResolvedValueOnce("crm-person-99");

    const result = await tryCRMLink(42, "+5511999990000");

    expect(result).toBe(true);
    expect(mockLinkContactToCRM).toHaveBeenCalledWith(42, "crm-person-99", expect.anything());
  });

  it("returns false when CRM bridge disabled", async () => {
    mockIsCRMBridgeEnabled.mockReturnValue(false);

    const result = await tryCRMLink(42, "+5511999990000");

    expect(result).toBe(false);
    expect(mockFindPersonByContact).not.toHaveBeenCalled();
  });

  it("returns false when no CRM person found", async () => {
    mockIsCRMBridgeEnabled.mockReturnValue(true);
    mockFindPersonByContact.mockResolvedValueOnce(null);

    const result = await tryCRMLink(42, "+5511999990000");

    expect(result).toBe(false);
    expect(mockLinkContactToCRM).not.toHaveBeenCalled();
  });

  it("fails silently on error", async () => {
    mockIsCRMBridgeEnabled.mockReturnValue(true);
    mockFindPersonByContact.mockRejectedValueOnce(new Error("Network error"));

    const result = await tryCRMLink(42, "+5511999990000");

    expect(result).toBe(false);
  });
});
