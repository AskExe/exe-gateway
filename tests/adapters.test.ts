import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WhatsAppAdapter } from "../src/adapters/whatsapp.js";
import { EmailAdapter } from "../src/adapters/email.js";
import { WebhookAdapter } from "../src/adapters/webhook.js";
import type { NormalizedMessage, AdapterPermissions } from "../src/types.js";

const DEFAULT_PERMISSIONS: AdapterPermissions = {
  canRead: true,
  canWrite: true,
  canExecute: false,
};

// ---------------------------------------------------------------------------
// WhatsApp Baileys Adapter
// ---------------------------------------------------------------------------

describe("WhatsAppAdapter (Baileys)", () => {
  let adapter: WhatsAppAdapter;

  beforeEach(() => {
    adapter = new WhatsAppAdapter();
  });

  describe("injectMessage", () => {
    it("is a no-op — Baileys uses WebSocket, not webhooks", async () => {
      const received: NormalizedMessage[] = [];
      adapter.onMessage(async (msg) => { received.push(msg); });

      await adapter.injectMessage({ anything: "here" });
      expect(received).toHaveLength(0);
    });

    it("does not throw without handler registered", async () => {
      await adapter.injectMessage({ test: true });
    });
  });

  describe("verifyWebhook", () => {
    it("returns null — no-op for Baileys", () => {
      expect(adapter.verifyWebhook("subscribe", "token", "challenge")).toBeNull();
    });
  });

  describe("healthCheck", () => {
    it("returns connected=false when not connected", async () => {
      const result = await adapter.healthCheck();
      expect(result.connected).toBe(false);
    });
  });

  describe("sendText", () => {
    it("throws when not connected", async () => {
      await expect(adapter.sendText("123", "hi")).rejects.toThrow("WhatsApp not connected");
    });
  });

  describe("platform", () => {
    it("reports whatsapp as platform", () => {
      expect(adapter.platform).toBe("whatsapp");
    });
  });
});

// ---------------------------------------------------------------------------
// Email Adapter
// ---------------------------------------------------------------------------

describe("EmailAdapter", () => {
  let adapter: EmailAdapter;
  let received: NormalizedMessage[];

  beforeEach(() => {
    adapter = new EmailAdapter();
    received = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });
  });

  describe("injectMessage", () => {
    it("normalizes an inbound email payload", async () => {
      // Need to connect first (but SMTP is mocked via not actually connecting)
      // For injectMessage tests, we only need handler set — no SMTP connection needed

      const payload = {
        from: "Alice Smith <alice@example.com>",
        to: "bot@exe.ai",
        subject: "Question",
        text: "How do I use this?",
        message_id: "msg-email-001",
      };

      await adapter.injectMessage(payload);

      expect(received).toHaveLength(1);
      const msg = received[0]!;
      expect(msg.platform).toBe("email");
      expect(msg.senderId).toBe("alice@example.com");
      expect(msg.senderName).toBe("Alice Smith");
      expect(msg.text).toBe("[Question] How do I use this?");
      expect(msg.messageId).toBe("msg-email-001");
      expect(msg.channelId).toBe("alice@example.com");
      expect(msg.chatType).toBe("direct");
    });

    it("handles plain email address without name", async () => {
      await adapter.injectMessage({
        from: "bob@example.com",
        text: "Just a message",
      });

      expect(received).toHaveLength(1);
      expect(received[0]!.senderId).toBe("bob@example.com");
      expect(received[0]!.senderName).toBeUndefined();
      expect(received[0]!.text).toBe("Just a message");
    });

    it("ignores payloads without from or text", async () => {
      await adapter.injectMessage({ from: "", text: "" });
      expect(received).toHaveLength(0);

      await adapter.injectMessage({ from: "alice@test.com" });
      expect(received).toHaveLength(0);
    });

    it("extracts attachments as media", async () => {
      await adapter.injectMessage({
        from: "alice@example.com",
        text: "See attached",
        attachments: [
          { filename: "photo.jpg", content_type: "image/jpeg" },
          { filename: "report.pdf", content_type: "application/pdf" },
        ],
      });

      expect(received[0]!.media).toEqual([
        { type: "image", fileName: "photo.jpg" },
        { type: "document", fileName: "report.pdf" },
      ]);
    });

    it("uses envelope.from as fallback", async () => {
      await adapter.injectMessage({
        envelope: { from: "fallback@test.com" },
        text: "From envelope",
      });

      expect(received).toHaveLength(1);
      expect(received[0]!.senderId).toBe("fallback@test.com");
    });
  });

  describe("healthCheck", () => {
    it("returns connected=false when not connected", async () => {
      const result = await adapter.healthCheck();
      expect(result.connected).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Generic Webhook Adapter
// ---------------------------------------------------------------------------

describe("WebhookAdapter", () => {
  let adapter: WebhookAdapter;
  let received: NormalizedMessage[];

  beforeEach(async () => {
    adapter = new WebhookAdapter();
    received = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });
  });

  async function connectWithFieldMap(
    fieldMap: Record<string, string>,
    responseUrl = "",
  ): Promise<void> {
    await adapter.connect({
      platform: "webhook",
      permissions: DEFAULT_PERMISSIONS,
      credentials: {
        response_url: responseUrl,
        field_map: JSON.stringify(fieldMap),
      },
    });
  }

  describe("injectMessage", () => {
    it("normalizes via simple field mappings", async () => {
      await connectWithFieldMap({
        text: "data.message",
        senderId: "data.from",
        channelId: "data.channel",
      });

      await adapter.injectMessage({
        data: { message: "Hello webhook", from: "user-42", channel: "ch-1" },
      });

      expect(received).toHaveLength(1);
      const msg = received[0]!;
      expect(msg.platform).toBe("webhook");
      expect(msg.text).toBe("Hello webhook");
      expect(msg.senderId).toBe("user-42");
      expect(msg.channelId).toBe("ch-1");
    });

    it("normalizes via nested field mappings", async () => {
      await connectWithFieldMap({
        text: "payload.body.content",
        senderId: "payload.user.id",
        senderName: "payload.user.name",
      });

      await adapter.injectMessage({
        payload: {
          body: { content: "Deeply nested" },
          user: { id: "deep-user", name: "Deep User" },
        },
      });

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe("Deeply nested");
      expect(received[0]!.senderId).toBe("deep-user");
      expect(received[0]!.senderName).toBe("Deep User");
    });

    it("falls back senderId for channelId when channelId mapping not set", async () => {
      await connectWithFieldMap({
        text: "msg",
        senderId: "user",
      });

      await adapter.injectMessage({ msg: "test", user: "u1" });

      expect(received[0]!.channelId).toBe("u1");
    });

    it("ignores payloads where required fields resolve to empty", async () => {
      await connectWithFieldMap({
        text: "data.message",
        senderId: "data.from",
      });

      // Missing text
      await adapter.injectMessage({ data: { from: "user-1" } });
      expect(received).toHaveLength(0);

      // Missing senderId
      await adapter.injectMessage({ data: { message: "hi" } });
      expect(received).toHaveLength(0);
    });

    it("generates UUID for messageId when not mapped", async () => {
      await connectWithFieldMap({ text: "text", senderId: "from" });
      await adapter.injectMessage({ text: "hi", from: "u1" });

      expect(received[0]!.messageId).toBeTruthy();
      expect(received[0]!.messageId.length).toBeGreaterThan(10);
    });
  });

  describe("connect", () => {
    it("throws when field_map is missing", async () => {
      await expect(
        adapter.connect({
          platform: "webhook",
          permissions: DEFAULT_PERMISSIONS,
          credentials: { response_url: "" },
        }),
      ).rejects.toThrow("field_map");
    });

    it("throws when field_map is missing required fields", async () => {
      await expect(
        adapter.connect({
          platform: "webhook",
          permissions: DEFAULT_PERMISSIONS,
          credentials: {
            field_map: JSON.stringify({ text: "msg" }),
          },
        }),
      ).rejects.toThrow("senderId");
    });
  });

  describe("sendText", () => {
    it("POSTs to response_url", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("OK", { status: 200 }),
      );

      await connectWithFieldMap(
        { text: "text", senderId: "from" },
        "https://example.com/hook",
      );

      await adapter.sendText("ch-1", "Response text");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://example.com/hook");
      const body = JSON.parse(opts?.body as string);
      expect(body.channelId).toBe("ch-1");
      expect(body.text).toBe("Response text");

      vi.restoreAllMocks();
    });

    it("does nothing when response_url is empty", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      await connectWithFieldMap({ text: "text", senderId: "from" }, "");
      await adapter.sendText("ch-1", "noop");
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });
  });

  describe("healthCheck", () => {
    it("returns connected=true after connect", async () => {
      await connectWithFieldMap({ text: "text", senderId: "from" });
      const result = await adapter.healthCheck();
      expect(result.connected).toBe(true);
    });

    it("returns connected=false before connect", async () => {
      const result = await adapter.healthCheck();
      expect(result.connected).toBe(false);
    });
  });
});
