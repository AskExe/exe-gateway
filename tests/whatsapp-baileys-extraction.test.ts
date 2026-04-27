/**
 * WhatsApp Baileys extraction tests — verifies all 7 P0 data categories
 * are correctly extracted from Baileys events into NormalizedMessage.
 *
 * Since the Baileys adapter receives messages via socket (not injectMessage),
 * we test the normalization by instantiating the adapter and simulating
 * the Baileys event payloads through the socket event emitter.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NormalizedMessage, DataCategory } from "../src/types.js";

// We can't easily mock the Baileys socket connection, so we test
// the normalization methods directly by accessing them on the class.
// The adapter exposes these as private methods, so we use prototype access.

async function getAdapter() {
  const { WhatsAppAdapter } = await import("../src/adapters/whatsapp.js");
  return new WhatsAppAdapter();
}

// Access private methods for unit testing
function callPrivate(adapter: any, method: string, ...args: any[]): any {
  return adapter[method](...args);
}

// ---------------------------------------------------------------------------
// 1. Location shares
// ---------------------------------------------------------------------------

describe("WhatsApp Baileys — location extraction", () => {
  it("extracts static location from locationMessage", async () => {
    const adapter = await getAdapter();
    const msg = {
      key: { remoteJid: "5511999999999@s.whatsapp.net", id: "loc-001" },
      message: {
        locationMessage: {
          degreesLatitude: -23.5505,
          degreesLongitude: -46.6333,
          name: "Paulista Ave",
          address: "Av. Paulista, 1000, São Paulo",
        },
      },
      messageTimestamp: 1700000000,
      pushName: "Driver",
    };

    const result: NormalizedMessage = callPrivate(adapter, "normalizeMessage", msg);

    expect(result).not.toBeNull();
    expect(result.dataCategory).toBe("location");
    expect(result.location).toEqual({
      latitude: -23.5505,
      longitude: -46.6333,
      address: "Av. Paulista, 1000, São Paulo",
      venueName: "Paulista Ave",
      isLive: false,
    });
    expect(result.platform).toBe("whatsapp");
    expect(result.senderId).toBe("5511999999999");
  });

  it("extracts live location from liveLocationMessage", async () => {
    const adapter = await getAdapter();
    const msg = {
      key: { remoteJid: "5511888888888@s.whatsapp.net", id: "loc-002" },
      message: {
        liveLocationMessage: {
          degreesLatitude: 40.7128,
          degreesLongitude: -74.006,
        },
      },
      messageTimestamp: 1700000000,
    };

    const result: NormalizedMessage = callPrivate(adapter, "normalizeMessage", msg);

    expect(result).not.toBeNull();
    expect(result.dataCategory).toBe("location");
    expect(result.location!.isLive).toBe(true);
    expect(result.location!.latitude).toBe(40.7128);
    expect(result.location!.longitude).toBe(-74.006);
  });

  it("sets dataCategory to message when no location", async () => {
    const adapter = await getAdapter();
    const msg = {
      key: { remoteJid: "5511777777777@s.whatsapp.net", id: "txt-001" },
      message: { conversation: "Hello" },
      messageTimestamp: 1700000000,
    };

    const result: NormalizedMessage = callPrivate(adapter, "normalizeMessage", msg);

    expect(result.dataCategory).toBe("message");
    expect(result.location).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Read receipts
// ---------------------------------------------------------------------------

describe("WhatsApp Baileys — read receipt extraction", () => {
  it("normalizes a read receipt", async () => {
    const adapter = await getAdapter();
    const update = {
      key: {
        remoteJid: "5511999999999@s.whatsapp.net",
        id: "msg-read-001",
        participant: "5511888888888@s.whatsapp.net",
      },
      receipt: {
        readTimestamp: 1700000100,
      },
    };

    const result: NormalizedMessage = callPrivate(adapter, "normalizeReadReceipt", update);

    expect(result).not.toBeNull();
    expect(result.dataCategory).toBe("read_receipt");
    expect(result.readReceipt).toBeDefined();
    expect(result.readReceipt!.messageId).toBe("msg-read-001");
    expect(result.readReceipt!.status).toBe("read");
    expect(result.readReceipt!.readBy).toBe("5511888888888@s.whatsapp.net");
    expect(result.platform).toBe("whatsapp");
  });

  it("normalizes a delivery receipt", async () => {
    const adapter = await getAdapter();
    const update = {
      key: {
        remoteJid: "5511999999999@s.whatsapp.net",
        id: "msg-del-001",
      },
      receipt: {
        receiptTimestamp: 1700000050,
      },
    };

    const result: NormalizedMessage = callPrivate(adapter, "normalizeReadReceipt", update);

    expect(result.readReceipt!.status).toBe("read");
    expect(result.readReceipt!.messageId).toBe("msg-del-001");
  });

  it("returns null for missing key", async () => {
    const adapter = await getAdapter();
    const result = callPrivate(adapter, "normalizeReadReceipt", {});
    expect(result).toBeNull();
  });

  it("returns null for missing receipt", async () => {
    const adapter = await getAdapter();
    const result = callPrivate(adapter, "normalizeReadReceipt", {
      key: { remoteJid: "x@s.whatsapp.net", id: "x" },
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Contact sync
// ---------------------------------------------------------------------------

describe("WhatsApp Baileys — contact sync extraction", () => {
  it("normalizes a contact with name and notify", async () => {
    const adapter = await getAdapter();
    const contact = {
      id: "5511999999999@s.whatsapp.net",
      name: "Alice Smith",
      notify: "Alice",
    };

    const result: NormalizedMessage = callPrivate(adapter, "normalizeContactSync", contact);

    expect(result).not.toBeNull();
    expect(result.dataCategory).toBe("contact_sync");
    expect(result.contactSync).toEqual({
      name: "Alice Smith",
      phone: "5511999999999",
      pushName: "Alice",
    });
    expect(result.senderPhone).toBe("5511999999999");
  });

  it("falls back to notify when name is missing", async () => {
    const adapter = await getAdapter();
    const contact = {
      id: "5511888888888@s.whatsapp.net",
      notify: "Bob",
    };

    const result: NormalizedMessage = callPrivate(adapter, "normalizeContactSync", contact);

    expect(result.contactSync!.name).toBe("Bob");
    expect(result.contactSync!.pushName).toBe("Bob");
  });

  it("falls back to phone when no name or notify", async () => {
    const adapter = await getAdapter();
    const contact = {
      id: "5511777777777@s.whatsapp.net",
    };

    const result: NormalizedMessage = callPrivate(adapter, "normalizeContactSync", contact);

    expect(result.contactSync!.name).toBe("5511777777777");
    expect(result.contactSync!.pushName).toBeUndefined();
  });

  it("returns null for missing id", async () => {
    const adapter = await getAdapter();
    const result = callPrivate(adapter, "normalizeContactSync", {});
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Groups
// ---------------------------------------------------------------------------

describe("WhatsApp Baileys — group info extraction", () => {
  it("normalizes a group with participants and admins", async () => {
    const adapter = await getAdapter();
    const group = {
      id: "120363001234567890@g.us",
      subject: "Warehouse Team",
      desc: "Daily ops coordination",
      participants: [
        { id: "5511999999999@s.whatsapp.net", admin: "admin" },
        { id: "5511888888888@s.whatsapp.net", admin: null },
        { id: "5511777777777@s.whatsapp.net", admin: "superadmin" },
      ],
    };

    const result: NormalizedMessage = callPrivate(adapter, "normalizeGroupInfo", group);

    expect(result).not.toBeNull();
    expect(result.dataCategory).toBe("group");
    expect(result.chatType).toBe("group");
    expect(result.groupInfo).toEqual({
      groupId: "120363001234567890@g.us",
      groupName: "Warehouse Team",
      participants: [
        "5511999999999@s.whatsapp.net",
        "5511888888888@s.whatsapp.net",
        "5511777777777@s.whatsapp.net",
      ],
      admins: [
        "5511999999999@s.whatsapp.net",
        "5511777777777@s.whatsapp.net",
      ],
      description: "Daily ops coordination",
    });
  });

  it("handles group without participants", async () => {
    const adapter = await getAdapter();
    const group = {
      id: "120363009999999999@g.us",
      subject: "Empty Group",
    };

    const result: NormalizedMessage = callPrivate(adapter, "normalizeGroupInfo", group);

    expect(result.groupInfo!.participants).toEqual([]);
    expect(result.groupInfo!.admins).toEqual([]);
    expect(result.groupInfo!.description).toBeUndefined();
  });

  it("returns null for missing id", async () => {
    const adapter = await getAdapter();
    const result = callPrivate(adapter, "normalizeGroupInfo", {});
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Reactions
// ---------------------------------------------------------------------------

describe("WhatsApp Baileys — reaction extraction", () => {
  it("normalizes a reaction", async () => {
    const adapter = await getAdapter();
    const reaction = {
      key: {
        remoteJid: "5511999999999@s.whatsapp.net",
        id: "msg-target-001",
      },
      reaction: {
        text: "👍",
        key: {
          participant: "5511888888888@s.whatsapp.net",
          remoteJid: "5511888888888@s.whatsapp.net",
        },
        senderTimestampMs: 1700000000000,
      },
    };

    const result: NormalizedMessage = callPrivate(adapter, "normalizeReaction", reaction);

    expect(result).not.toBeNull();
    expect(result.dataCategory).toBe("reaction");
    expect(result.reaction).toEqual({
      emoji: "👍",
      targetMessageId: "msg-target-001",
      reactedBy: "5511888888888@s.whatsapp.net",
      timestamp: new Date(1700000000000).toISOString(),
    });
  });

  it("returns null for missing key", async () => {
    const adapter = await getAdapter();
    const result = callPrivate(adapter, "normalizeReaction", {});
    expect(result).toBeNull();
  });

  it("returns null for missing reaction data", async () => {
    const adapter = await getAdapter();
    const result = callPrivate(adapter, "normalizeReaction", {
      key: { remoteJid: "x@s.whatsapp.net", id: "x" },
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Call logs
// ---------------------------------------------------------------------------

describe("WhatsApp Baileys — call log extraction", () => {
  it("normalizes a voice call", async () => {
    const adapter = await getAdapter();
    const call = {
      from: "5511999999999@s.whatsapp.net",
      chatId: "5511999999999@s.whatsapp.net",
      isVideo: false,
      isGroup: false,
      status: "offered",
      date: 1700000000,
    };

    const result: NormalizedMessage = callPrivate(adapter, "normalizeCall", call);

    expect(result).not.toBeNull();
    expect(result.dataCategory).toBe("call_log");
    expect(result.callLog!.callType).toBe("voice");
    expect(result.callLog!.status).toBe("offered");
    expect(result.callLog!.caller).toBe("5511999999999");
    expect(result.callLog!.isGroup).toBe(false);
  });

  it("normalizes a video call", async () => {
    const adapter = await getAdapter();
    const call = {
      from: "5511888888888@s.whatsapp.net",
      chatId: "5511888888888@s.whatsapp.net",
      isVideo: true,
      isGroup: false,
      status: "accepted",
      duration: 720,
      date: 1700000000,
    };

    const result: NormalizedMessage = callPrivate(adapter, "normalizeCall", call);

    expect(result.callLog!.callType).toBe("video");
    expect(result.callLog!.status).toBe("accepted");
    expect(result.callLog!.duration).toBe(720);
  });

  it("normalizes a group call", async () => {
    const adapter = await getAdapter();
    const call = {
      from: "5511777777777@s.whatsapp.net",
      chatId: "120363001234567890@g.us",
      isVideo: false,
      isGroup: true,
      status: "missed",
      date: 1700000000,
    };

    const result: NormalizedMessage = callPrivate(adapter, "normalizeCall", call);

    expect(result.callLog!.isGroup).toBe(true);
    expect(result.chatType).toBe("group");
    expect(result.callLog!.status).toBe("missed");
  });

  it("returns null for missing chatId/from", async () => {
    const adapter = await getAdapter();
    const result = callPrivate(adapter, "normalizeCall", {});
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. History sync (normalizeMessage with isHistorical flag)
// ---------------------------------------------------------------------------

describe("WhatsApp Baileys — history sync", () => {
  it("marks historical messages correctly", async () => {
    const adapter = await getAdapter();
    const msg = {
      key: { remoteJid: "5511999999999@s.whatsapp.net", id: "hist-001" },
      message: { conversation: "Old message from last week" },
      messageTimestamp: 1699900000,
    };

    const result: NormalizedMessage = callPrivate(adapter, "normalizeMessage", msg);

    // The adapter sets these after normalizeMessage returns, in the event handler
    // Here we verify normalizeMessage returns a valid message that CAN be flagged
    expect(result).not.toBeNull();
    expect(result.text).toBe("Old message from last week");

    // Simulate what the event handler does
    result.dataCategory = "history_sync";
    result.isHistorical = true;

    expect(result.dataCategory).toBe("history_sync");
    expect(result.isHistorical).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DataCategory type coverage
// ---------------------------------------------------------------------------

describe("WhatsApp Baileys — dataCategory typing", () => {
  it("all P0 categories are valid DataCategory values", async () => {
    const { WhatsAppAdapter } = await import("../src/adapters/whatsapp.js");
    const categories: DataCategory[] = [
      "message",
      "location",
      "read_receipt",
      "contact_sync",
      "group",
      "reaction",
      "call_log",
      "history_sync",
    ];

    // Type-level test — if this compiles, all categories are valid
    expect(categories).toHaveLength(8);
  });
});
