import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock conversation-store (must be before WebhookServer import)
// ---------------------------------------------------------------------------

const mockGetThreads = vi.fn();
const mockGetThreadMessages = vi.fn();
const mockGetContacts = vi.fn();
const mockGetContactDetail = vi.fn();

vi.mock("../src/conversation-store.js", () => ({
  getThreads: (...args: unknown[]) => mockGetThreads(...args),
  getThreadMessages: (...args: unknown[]) => mockGetThreadMessages(...args),
  getContacts: (...args: unknown[]) => mockGetContacts(...args),
  getContactDetail: (...args: unknown[]) => mockGetContactDetail(...args),
}));

import { WebhookServer } from "../src/webhook-server.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const PORT = 19878; // Different from webhook-server + ws-relay tests to avoid EADDRINUSE
const AUTH_TOKEN = "test-token-secret";
let server: WebhookServer;

async function apiGet(path: string, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers });
  const body = await res.json();
  return { status: res.status, body: body as Record<string, unknown> };
}

beforeAll(async () => {
  server = new WebhookServer({ port: PORT, host: "127.0.0.1", authToken: AUTH_TOKEN });
  server.setDbAvailable(true);
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

beforeEach(() => {
  mockGetThreads.mockReset();
  mockGetThreadMessages.mockReset();
  mockGetContacts.mockReset();
  mockGetContactDetail.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/threads", () => {
  it("returns threads with contact info", async () => {
    mockGetThreads.mockResolvedValueOnce([
      { id: 1, accountId: 1, contactId: 5, contactName: "Jane", messageCount: 3 },
    ]);

    const { status, body } = await apiGet("/api/threads", AUTH_TOKEN);

    expect(status).toBe(200);
    const threads = body.threads as unknown[];
    expect(threads).toHaveLength(1);
    expect(mockGetThreads).toHaveBeenCalledWith({ accountId: undefined, limit: 50, offset: 0 });
  });

  it("returns 401 without auth token", async () => {
    const { status, body } = await apiGet("/api/threads");
    expect(status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("passes account_id filter", async () => {
    mockGetThreads.mockResolvedValueOnce([]);
    await apiGet("/api/threads?account_id=7", AUTH_TOKEN);
    expect(mockGetThreads).toHaveBeenCalledWith({ accountId: 7, limit: 50, offset: 0 });
  });

  it("caps limit at 200", async () => {
    mockGetThreads.mockResolvedValueOnce([]);
    await apiGet("/api/threads?limit=500", AUTH_TOKEN);
    expect(mockGetThreads).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
  });
});

describe("GET /api/threads/:id/messages", () => {
  it("returns messages for thread", async () => {
    mockGetThreadMessages.mockResolvedValueOnce([
      { id: 1, text: "Hello", timestamp: "2026-04-27T10:00:00Z" },
      { id: 2, text: "World", timestamp: "2026-04-27T10:01:00Z" },
    ]);

    const { status, body } = await apiGet("/api/threads/1/messages", AUTH_TOKEN);

    expect(status).toBe(200);
    const messages = body.messages as unknown[];
    expect(messages).toHaveLength(2);
    expect(mockGetThreadMessages).toHaveBeenCalledWith(1, 50, 0);
  });

  it("returns 401 without auth token", async () => {
    const { status } = await apiGet("/api/threads/1/messages");
    expect(status).toBe(401);
  });

  it("respects limit and offset", async () => {
    mockGetThreadMessages.mockResolvedValueOnce([]);
    await apiGet("/api/threads/5/messages?limit=10&offset=20", AUTH_TOKEN);
    expect(mockGetThreadMessages).toHaveBeenCalledWith(5, 10, 20);
  });
});

describe("GET /api/contacts", () => {
  it("returns contacts list", async () => {
    mockGetContacts.mockResolvedValueOnce([
      { id: 1, platform: "whatsapp", platformJid: "+123", crmPersonId: null },
      { id: 2, platform: "whatsapp", platformJid: "+456", crmPersonId: "crm-1" },
    ]);

    const { status, body } = await apiGet("/api/contacts", AUTH_TOKEN);

    expect(status).toBe(200);
    const contacts = body.contacts as unknown[];
    expect(contacts).toHaveLength(2);
  });

  it("returns 401 without auth token", async () => {
    const { status } = await apiGet("/api/contacts");
    expect(status).toBe(401);
  });

  it("filters crm_linked=true", async () => {
    mockGetContacts.mockResolvedValueOnce([
      { id: 1, crmPersonId: null },
      { id: 2, crmPersonId: "crm-1" },
    ]);

    const { status, body } = await apiGet("/api/contacts?crm_linked=true", AUTH_TOKEN);

    expect(status).toBe(200);
    const contacts = body.contacts as Array<{ crmPersonId: string | null }>;
    expect(contacts).toHaveLength(1);
    expect(contacts[0].crmPersonId).toBe("crm-1");
  });

  it("filters crm_linked=false", async () => {
    mockGetContacts.mockResolvedValueOnce([
      { id: 1, crmPersonId: null },
      { id: 2, crmPersonId: "crm-1" },
    ]);

    const { status, body } = await apiGet("/api/contacts?crm_linked=false", AUTH_TOKEN);

    expect(status).toBe(200);
    const contacts = body.contacts as Array<{ crmPersonId: string | null }>;
    expect(contacts).toHaveLength(1);
    expect(contacts[0].crmPersonId).toBeNull();
  });

  it("caps limit at 200", async () => {
    mockGetContacts.mockResolvedValueOnce([]);
    await apiGet("/api/contacts?limit=999", AUTH_TOKEN);
    expect(mockGetContacts).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
  });
});

describe("GET /api/contacts/:id", () => {
  it("returns contact detail", async () => {
    mockGetContactDetail.mockResolvedValueOnce({
      id: 42,
      platform: "whatsapp",
      platformJid: "+5511999990000",
      displayName: "Jane Doe",
    });

    const { status, body } = await apiGet("/api/contacts/42", AUTH_TOKEN);

    expect(status).toBe(200);
    expect(body.id).toBe(42);
    expect(body.displayName).toBe("Jane Doe");
    expect(mockGetContactDetail).toHaveBeenCalledWith(42);
  });

  it("returns 401 without auth token", async () => {
    const { status } = await apiGet("/api/contacts/42");
    expect(status).toBe(401);
  });

  it("returns 404 for unknown contact", async () => {
    mockGetContactDetail.mockResolvedValueOnce(null);
    const { status, body } = await apiGet("/api/contacts/999", AUTH_TOKEN);
    expect(status).toBe(404);
    expect(body.error).toBe("Contact not found");
  });
});
