import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = {
  gatewayContact: { upsert: vi.fn() },
};

const mockGetPrisma = vi.fn(async () => mockPrisma);
const mockWithTransaction = vi.fn(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));

vi.mock("../src/db.js", () => ({
  getPrisma: () => mockGetPrisma(),
  withTransaction: (fn: (tx: typeof mockPrisma) => Promise<unknown>) => mockWithTransaction(fn),
  hasPool: () => true,
  getPool: () => ({ query: vi.fn(), end: vi.fn() }),
  initPool: () => ({ query: vi.fn(), end: vi.fn() }),
  closePool: async () => {},
}));

const mockUpsertContact = vi.fn().mockResolvedValue(42);
const mockLinkContactToCRM = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/conversation-store.js", () => ({
  upsertContact: (...args: unknown[]) => mockUpsertContact(...args),
  linkContactToCRM: (...args: unknown[]) => mockLinkContactToCRM(...args),
}));

const mockFindPersonByContact = vi.fn();
const mockIsCRMBridgeEnabled = vi.fn();
vi.mock("../src/crm-bridge.js", () => ({
  findPersonByContact: (...args: unknown[]) => mockFindPersonByContact(...args),
  isCRMBridgeEnabled: () => mockIsCRMBridgeEnabled(),
}));

import {
  bulkImportContacts,
  importContactFromMessage,
  parsePhoneFromJid,
  tryCRMLink,
} from "../src/contact-importer.js";
import type { NormalizedMessage } from "../src/types.js";

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

describe("contact-importer", () => {
  beforeEach(() => {
    mockGetPrisma.mockClear();
    mockWithTransaction.mockClear();
    mockUpsertContact.mockClear().mockResolvedValue(42);
    mockLinkContactToCRM.mockClear().mockResolvedValue(undefined);
    mockFindPersonByContact.mockReset();
    mockIsCRMBridgeEnabled.mockReset();
  });

  it("imports a contact from a message", async () => {
    const id = await importContactFromMessage(makeMsg());
    expect(id).toBe(42);
    expect(mockGetPrisma).toHaveBeenCalled();
    expect(mockUpsertContact).toHaveBeenCalledWith(
      "whatsapp",
      "5511999990000@s.whatsapp.net",
      expect.objectContaining({ phone: "+5511999990000", displayName: "Jane Doe", pushName: "Jane Doe" }),
      mockPrisma,
    );
  });

  it("uses senderPhone when available", async () => {
    await importContactFromMessage(makeMsg({ senderPhone: "+5511888880000" }));
    expect(mockUpsertContact).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ phone: "+5511888880000" }),
      mockPrisma,
    );
  });

  it("bulk imports contacts inside a Prisma transaction helper", async () => {
    const count = await bulkImportContacts("whatsapp", [
      { platformJid: "5511111111111@s.whatsapp.net", displayName: "Alice" },
      { platformJid: "5522222222222@s.whatsapp.net", displayName: "Bob" },
    ]);

    expect(count).toBe(2);
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockUpsertContact).toHaveBeenCalledTimes(2);
  });

  it("propagates transactional failures", async () => {
    mockUpsertContact.mockRejectedValueOnce(new Error("DB error"));
    await expect(
      bulkImportContacts("whatsapp", [{ platformJid: "5511111111111@s.whatsapp.net" }]),
    ).rejects.toThrow("DB error");
  });

  it("links contacts to CRM when a CRM person is found", async () => {
    mockIsCRMBridgeEnabled.mockReturnValue(true);
    mockFindPersonByContact.mockResolvedValueOnce("crm-person-99");

    const result = await tryCRMLink(42, "+5511999990000");

    expect(result).toBe(true);
    expect(mockGetPrisma).toHaveBeenCalled();
    expect(mockLinkContactToCRM).toHaveBeenCalledWith(42, "crm-person-99", mockPrisma);
  });

  it("returns false when CRM bridge is disabled", async () => {
    mockIsCRMBridgeEnabled.mockReturnValue(false);
    await expect(tryCRMLink(42, "+5511999990000")).resolves.toBe(false);
  });
});
