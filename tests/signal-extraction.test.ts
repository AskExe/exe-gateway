/**
 * Signal extraction tests — verifies reactions, read receipts, contacts sync,
 * groups, and message edits are correctly extracted via SSE event handling.
 *
 * The Signal adapter uses SSE + JSON-RPC. We test by calling the private
 * handleSseEvent method directly with crafted payloads.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NormalizedMessage } from "../src/types.js";

async function getAdapter() {
  const { SignalAdapter } = await import("../src/adapters/signal.js");
  return new SignalAdapter();
}

function callPrivate(adapter: any, method: string, ...args: any[]): any {
  return adapter[method](...args);
}

function makeEnvelopeEvent(envelope: Record<string, unknown>) {
  return { data: JSON.stringify({ envelope }) };
}

// ---------------------------------------------------------------------------
// 1. Reactions
// ---------------------------------------------------------------------------

describe("SignalAdapter — reaction extraction", () => {
  it("normalizes a reaction event", async () => {
    const adapter = await getAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await callPrivate(adapter, "handleSseEvent", makeEnvelopeEvent({
      sourceNumber: "+15551234567",
      sourceName: "Alice",
      timestamp: 1700000000000,
      reactionMessage: {
        emoji: "👍",
        targetAuthor: "+15559876543",
        targetTimestamp: 1699999999000,
        isRemove: false,
      },
    }));

    expect(received).toHaveLength(1);
    expect(received[0].dataCategory).toBe("reaction");
    expect(received[0].platform).toBe("signal");
    expect(received[0].reaction).toEqual({
      emoji: "👍",
      targetMessageId: "1699999999000",
      reactedBy: "+15551234567",
      timestamp: new Date(1700000000000).toISOString(),
    });
    expect(received[0].senderId).toBe("+15551234567");
  });

  it("ignores reaction removal (still emits event)", async () => {
    const adapter = await getAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await callPrivate(adapter, "handleSseEvent", makeEnvelopeEvent({
      sourceNumber: "+15551111111",
      timestamp: 1700000100000,
      reactionMessage: {
        emoji: "❤️",
        targetAuthor: "+15552222222",
        targetTimestamp: 1700000000000,
        isRemove: true,
      },
    }));

    expect(received).toHaveLength(1);
    expect(received[0].dataCategory).toBe("reaction");
    expect(received[0].reaction!.emoji).toBe("❤️");
  });
});

// ---------------------------------------------------------------------------
// 2. Read receipts
// ---------------------------------------------------------------------------

describe("SignalAdapter — read receipt extraction", () => {
  it("normalizes a read receipt with multiple timestamps", async () => {
    const adapter = await getAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await callPrivate(adapter, "handleSseEvent", makeEnvelopeEvent({
      sourceNumber: "+15551234567",
      sourceName: "Bob",
      timestamp: 1700000200000,
      receiptMessage: {
        type: "read",
        timestamps: [1700000100000, 1700000150000],
      },
    }));

    expect(received).toHaveLength(2);
    expect(received[0].dataCategory).toBe("read_receipt");
    expect(received[0].readReceipt!.messageId).toBe("1700000100000");
    expect(received[0].readReceipt!.status).toBe("read");
    expect(received[0].readReceipt!.readBy).toBe("+15551234567");

    expect(received[1].readReceipt!.messageId).toBe("1700000150000");
    expect(received[1].readReceipt!.status).toBe("read");
  });

  it("normalizes a delivery receipt", async () => {
    const adapter = await getAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await callPrivate(adapter, "handleSseEvent", makeEnvelopeEvent({
      sourceNumber: "+15559999999",
      timestamp: 1700000300000,
      receiptMessage: {
        type: "delivery",
        timestamps: [1700000250000],
      },
    }));

    expect(received).toHaveLength(1);
    expect(received[0].readReceipt!.status).toBe("delivered");
  });
});

// ---------------------------------------------------------------------------
// 3. Message edits
// ---------------------------------------------------------------------------

describe("SignalAdapter — edit extraction", () => {
  it("normalizes an edit event with target reference", async () => {
    const adapter = await getAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await callPrivate(adapter, "handleSseEvent", makeEnvelopeEvent({
      sourceNumber: "+15551234567",
      sourceName: "Charlie",
      timestamp: 1700000400000,
      editMessage: {
        targetTimestamp: 1700000300000,
        dataMessage: {
          timestamp: 1700000400000,
          message: "Corrected message text",
        },
      },
    }));

    expect(received).toHaveLength(1);
    expect(received[0].dataCategory).toBe("edit");
    expect(received[0].text).toBe("Corrected message text");
    expect(received[0].replyTo).toEqual({
      messageId: "1700000300000",
      text: "",
      senderId: "+15551234567",
    });
  });

  it("handles edit in a group", async () => {
    const adapter = await getAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await callPrivate(adapter, "handleSseEvent", makeEnvelopeEvent({
      sourceNumber: "+15551234567",
      timestamp: 1700000500000,
      editMessage: {
        targetTimestamp: 1700000400000,
        dataMessage: {
          timestamp: 1700000500000,
          message: "Edited group message",
          groupInfo: { groupId: "abc123", groupName: "Team Chat" },
        },
      },
    }));

    expect(received[0].chatType).toBe("group");
    expect(received[0].channelId).toBe("group:abc123");
    expect(received[0].dataCategory).toBe("edit");
  });
});

// ---------------------------------------------------------------------------
// 4. Contacts sync
// ---------------------------------------------------------------------------

describe("SignalAdapter — contact sync", () => {
  it("imports contacts via syncContacts", async () => {
    const adapter = await getAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    // Mock the rpcRequest to return contacts
    (adapter as any).rpcRequest = vi.fn().mockResolvedValue([
      { number: "+15551111111", name: "Alice Smith", profileName: "Alice" },
      { number: "+15552222222", name: "Bob Jones" },
      { number: "+15553333333", profileName: "Charlie" },
    ]);

    await callPrivate(adapter, "syncContacts");

    expect(received).toHaveLength(3);

    expect(received[0].dataCategory).toBe("contact_sync");
    expect(received[0].contactSync).toEqual({
      name: "Alice Smith",
      phone: "+15551111111",
      pushName: "Alice",
    });

    expect(received[1].contactSync!.name).toBe("Bob Jones");
    expect(received[1].contactSync!.pushName).toBeUndefined();

    expect(received[2].contactSync!.name).toBe("Charlie");
    expect(received[2].contactSync!.pushName).toBe("Charlie");
  });

  it("skips contacts without phone number", async () => {
    const adapter = await getAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    (adapter as any).rpcRequest = vi.fn().mockResolvedValue([
      { name: "No Phone" },
      { number: "+15554444444", name: "Has Phone" },
    ]);

    await callPrivate(adapter, "syncContacts");

    expect(received).toHaveLength(1);
    expect(received[0].contactSync!.phone).toBe("+15554444444");
  });

  it("handles empty contact list", async () => {
    const adapter = await getAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    (adapter as any).rpcRequest = vi.fn().mockResolvedValue([]);

    await callPrivate(adapter, "syncContacts");

    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Groups
// ---------------------------------------------------------------------------

describe("SignalAdapter — group sync", () => {
  it("imports groups via syncGroups", async () => {
    const adapter = await getAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    (adapter as any).rpcRequest = vi.fn().mockResolvedValue([
      {
        id: "group-abc",
        name: "Warehouse Team",
        description: "Daily ops",
        members: ["+15551111111", "+15552222222"],
        admins: ["+15551111111"],
      },
      {
        id: "group-def",
        name: "Management",
        members: ["+15553333333"],
        admins: [],
      },
    ]);

    await callPrivate(adapter, "syncGroups");

    expect(received).toHaveLength(2);

    expect(received[0].dataCategory).toBe("group");
    expect(received[0].chatType).toBe("group");
    expect(received[0].groupInfo).toEqual({
      groupId: "group-abc",
      groupName: "Warehouse Team",
      participants: ["+15551111111", "+15552222222"],
      admins: ["+15551111111"],
      description: "Daily ops",
    });

    expect(received[1].groupInfo!.groupName).toBe("Management");
    expect(received[1].groupInfo!.description).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Regular messages still work with dataCategory
// ---------------------------------------------------------------------------

describe("SignalAdapter — regular messages", () => {
  it("sets dataCategory to message for text messages", async () => {
    const adapter = await getAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await callPrivate(adapter, "handleSseEvent", makeEnvelopeEvent({
      sourceNumber: "+15551234567",
      sourceName: "Dave",
      timestamp: 1700000600000,
      dataMessage: {
        timestamp: 1700000600000,
        message: "Hello Signal",
      },
    }));

    expect(received).toHaveLength(1);
    expect(received[0].dataCategory).toBe("message");
    expect(received[0].text).toBe("Hello Signal");
    expect(received[0].platform).toBe("signal");
  });

  it("still handles group messages", async () => {
    const adapter = await getAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await callPrivate(adapter, "handleSseEvent", makeEnvelopeEvent({
      sourceNumber: "+15551234567",
      timestamp: 1700000700000,
      dataMessage: {
        timestamp: 1700000700000,
        message: "Group hello",
        groupInfo: { groupId: "grp-1", groupName: "Team" },
      },
    }));

    expect(received[0].chatType).toBe("group");
    expect(received[0].channelId).toBe("group:grp-1");
    expect(received[0].dataCategory).toBe("message");
  });

  it("skips envelopes with no recognized event type", async () => {
    const adapter = await getAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await callPrivate(adapter, "handleSseEvent", makeEnvelopeEvent({
      sourceNumber: "+15551234567",
      timestamp: 1700000800000,
      typingMessage: { action: "STARTED" },
    }));

    expect(received).toHaveLength(0);
  });
});
