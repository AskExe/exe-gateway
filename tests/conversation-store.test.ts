import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPool = {
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  end: vi.fn(),
};

const mockPrisma = {
  gatewayAccount: { upsert: vi.fn() },
  gatewayContact: { upsert: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  gatewayThread: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  gatewayMessage: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn() },
};

vi.mock("../src/db.js", () => ({
  getPool: () => mockPool,
  getPrisma: async () => mockPrisma,
  withTransaction: async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
  hasPool: () => true,
  initPool: () => mockPool,
  closePool: async () => {},
}));

import {
  getContactDetail,
  getContacts,
  getThreadMessages,
  getThreads,
  initConversationStore,
  linkContactToCRM,
  storeMessage,
  upsertAccount,
  upsertContact,
  upsertThread,
} from "../src/conversation-store.js";

describe("conversation-store", () => {
  beforeEach(() => {
    mockPool.query.mockClear();
    Object.values(mockPrisma).forEach((delegate: any) => {
      Object.values(delegate).forEach((fn: any) => fn.mockReset());
    });
  });

  it("initializes gateway helper tables", async () => {
    await initConversationStore();
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const sql = mockPool.query.mock.calls[0][0] as string;
    expect(sql).toContain("gateway_auto_reply_state");
    expect(sql).toContain("gateway_daily_caps");
  });

  it("upserts accounts via Prisma", async () => {
    mockPrisma.gatewayAccount.upsert.mockResolvedValue({ id: 42 });
    const id = await upsertAccount("whatsapp", "main-account", "platform-1");
    expect(id).toBe(42);
    expect(mockPrisma.gatewayAccount.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { platform_accountName: { platform: "whatsapp", accountName: "main-account" } },
      }),
    );
  });

  it("upserts contacts via Prisma and preserves optional fields", async () => {
    mockPrisma.gatewayContact.upsert.mockResolvedValue({ id: 7 });
    const id = await upsertContact("whatsapp", "jid-1", {
      phone: "+123",
      displayName: "Jane",
      pushName: "Janie",
      lid: "ignored-lid",
    });
    expect(id).toBe(7);
    expect(mockPrisma.gatewayContact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { platform_platformJid: { platform: "whatsapp", platformJid: "jid-1" } },
        create: expect.objectContaining({ phone: "+123", displayName: "Jane", pushName: "Janie" }),
      }),
    );
  });

  it("reuses existing thread when present", async () => {
    mockPrisma.gatewayThread.findFirst.mockResolvedValue({ id: 9 });
    mockPrisma.gatewayThread.update.mockResolvedValue({ id: 9 });
    const id = await upsertThread(1, 2);
    expect(id).toBe(9);
    expect(mockPrisma.gatewayThread.update).toHaveBeenCalled();
    expect(mockPrisma.gatewayThread.create).not.toHaveBeenCalled();
  });

  it("stores messages via Prisma and updates thread stats", async () => {
    mockPrisma.gatewayMessage.findFirst.mockResolvedValue(null);
    mockPrisma.gatewayMessage.create.mockResolvedValue({ id: 100 });
    mockPrisma.gatewayThread.update.mockResolvedValue({ id: 1 });

    const id = await storeMessage({
      threadId: 1,
      accountId: 2,
      messageId: "msg-001",
      fromJid: "+1234567890",
      text: "Hello",
      timestamp: "2026-04-27T10:00:00Z",
      rawPayload: { key: "value" },
    });

    expect(id).toBe(100);
    expect(mockPrisma.gatewayMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ rawPayload: { key: "value" } }),
      }),
    );
    expect(mockPrisma.gatewayThread.update).toHaveBeenCalled();
  });

  it("returns existing message id when dedupe matches", async () => {
    mockPrisma.gatewayMessage.findFirst.mockResolvedValue({ id: 55 });
    const id = await storeMessage({
      threadId: 1,
      accountId: 2,
      messageId: "msg-001",
      fromJid: "+1234567890",
      timestamp: "2026-04-27T10:00:00Z",
    });
    expect(id).toBe(55);
    expect(mockPrisma.gatewayMessage.create).not.toHaveBeenCalled();
  });

  it("maps thread messages from Prisma records", async () => {
    mockPrisma.gatewayMessage.findMany.mockResolvedValue([
      {
        id: 2,
        threadId: 1,
        accountId: 1,
        messageId: "msg-002",
        fromJid: "+1234567890",
        fromMe: false,
        text: "Second",
        mediaType: null,
        mediaUrl: null,
        timestamp: new Date("2026-04-27T11:00:00Z"),
        isHistorical: false,
        rawPayload: null,
        createdAt: new Date("2026-04-27T11:00:00Z"),
      },
    ]);

    const messages = await getThreadMessages(1);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("Second");
    expect(messages[0].pushName).toBeNull();
  });

  it("maps threads with included contacts", async () => {
    mockPrisma.gatewayThread.findMany.mockResolvedValue([
      {
        id: 1,
        accountId: 1,
        contactId: 5,
        groupJid: null,
        groupName: null,
        lastMessage: new Date("2026-04-27T10:00:00Z"),
        messageCount: 3,
        contact: {
          platformJid: "+1234567890@s.whatsapp.net",
          displayName: "Jane Doe",
          phone: "+1234567890",
        },
      },
    ]);

    const threads = await getThreads({ accountId: 1 });
    expect(threads).toHaveLength(1);
    expect(threads[0].contactName).toBe("Jane Doe");
    expect(threads[0].contactPlatformJid).toBe("+1234567890@s.whatsapp.net");
  });

  it("maps contacts and contact detail", async () => {
    const contactRecord = {
      id: 3,
      platform: "whatsapp",
      platformJid: "jid-3",
      phone: "+123",
      displayName: "Jane",
      pushName: "Janie",
      crmPersonId: "crm-1",
      createdAt: new Date("2026-04-27T10:00:00Z"),
      updatedAt: new Date("2026-04-27T10:00:00Z"),
    };
    mockPrisma.gatewayContact.findMany.mockResolvedValue([contactRecord]);
    mockPrisma.gatewayContact.findUnique.mockResolvedValue(contactRecord);

    const contacts = await getContacts({ platform: "whatsapp" });
    const detail = await getContactDetail(3);

    expect(contacts[0].lid).toBeNull();
    expect(detail?.crmPersonId).toBe("crm-1");
  });

  it("links contacts to CRM via Prisma", async () => {
    mockPrisma.gatewayContact.update.mockResolvedValue({ id: 3 });
    await linkContactToCRM(3, "crm-99");
    expect(mockPrisma.gatewayContact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 3 },
        data: expect.objectContaining({ crmPersonId: "crm-99" }),
      }),
    );
  });
});
