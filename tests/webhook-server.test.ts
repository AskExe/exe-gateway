import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebhookServer } from "../src/webhook-server.js";

const TEST_PORT = 19876; // unlikely to collide
const TEST_HOST = "127.0.0.1"; // Bind to localhost in tests (same as the safer production default)

/** Simple helper to make HTTP requests to the test server */
async function req(
  method: string,
  path: string,
  options?: { body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; data: Record<string, unknown> }> {
  const url = `http://127.0.0.1:${TEST_PORT}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Connection: "close",
      ...(options?.headers ?? {}),
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

describe("WebhookServer", () => {
  let server: WebhookServer;

  afterEach(async () => {
    if (server?.listening) {
      await server.stop();
    }
  });

  // -----------------------------------------------------------------------
  // Health endpoint
  // -----------------------------------------------------------------------

  describe("GET /health", () => {
    it("returns status, uptime, and registered handlers", async () => {
      server = new WebhookServer({ port: TEST_PORT, host: TEST_HOST });
      server.onPlatform("whatsapp", async () => {});
      server.onPlatform("email", async () => {});
      await server.start();

      const { status, data } = await req("GET", "/health");

      expect(status).toBe(200);
      expect(data.status).toBe("ok");
      expect(data.uptime).toBeGreaterThanOrEqual(0);
      expect(data.handlers).toEqual(
        expect.arrayContaining(["whatsapp", "email"]),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Platform routing
  // -----------------------------------------------------------------------

  describe("POST /webhook/:platform", () => {
    it("routes payload to the correct platform handler", async () => {
      const received: unknown[] = [];
      server = new WebhookServer({ port: TEST_PORT, host: TEST_HOST });
      server.onPlatform("whatsapp", async (body) => {
        received.push(body);
      });
      await server.start();

      const payload = { object: "whatsapp_business_account", entry: [] };
      const { status, data } = await req("POST", "/webhook/whatsapp", {
        body: payload,
      });

      expect(status).toBe(200);
      expect(data.received).toBe(true);

      // Give async handler time to process
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(payload);
    });

    it("returns 200 for unknown platform (prevents retries)", async () => {
      server = new WebhookServer({ port: TEST_PORT, host: TEST_HOST });
      await server.start();

      const { status, data } = await req("POST", "/webhook/unknown", {
        body: { test: true },
      });

      expect(status).toBe(200);
      expect(data.error).toContain("No handler");
    });

    it("returns 200 with no platform in path", async () => {
      server = new WebhookServer({ port: TEST_PORT, host: TEST_HOST });
      await server.start();

      const { status } = await req("POST", "/webhook/", {
        body: { test: true },
      });

      expect(status).toBe(200);
    });

    it("routes to correct handler when multiple registered", async () => {
      const waReceived: unknown[] = [];
      const emailReceived: unknown[] = [];

      server = new WebhookServer({ port: TEST_PORT, host: TEST_HOST });
      server.onPlatform("whatsapp", async (body) => waReceived.push(body));
      server.onPlatform("email", async (body) => emailReceived.push(body));
      await server.start();

      await req("POST", "/webhook/email", { body: { from: "alice@test.com" } });
      await req("POST", "/webhook/whatsapp", { body: { object: "wa" } });

      await new Promise((r) => setTimeout(r, 50));

      expect(waReceived).toHaveLength(1);
      expect(emailReceived).toHaveLength(1);
      expect((emailReceived[0] as Record<string, unknown>).from).toBe("alice@test.com");
      expect((waReceived[0] as Record<string, unknown>).object).toBe("wa");
    });
  });

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  describe("Bearer token auth", () => {
    it("rejects POST without auth when token is configured", async () => {
      server = new WebhookServer({
        port: TEST_PORT,
        host: TEST_HOST,
        authToken: "secret-123",
      });
      server.onPlatform("whatsapp", async () => {});
      await server.start();

      const { status, data } = await req("POST", "/webhook/whatsapp", {
        body: { test: true },
      });

      expect(status).toBe(401);
      expect(data.error).toBe("Unauthorized");
    });

    it("rejects POST with wrong token", async () => {
      server = new WebhookServer({
        port: TEST_PORT,
        host: TEST_HOST,
        authToken: "secret-123",
      });
      server.onPlatform("whatsapp", async () => {});
      await server.start();

      const { status } = await req("POST", "/webhook/whatsapp", {
        body: { test: true },
        headers: { Authorization: "Bearer wrong-token" },
      });

      expect(status).toBe(401);
    });

    it("accepts POST with correct token", async () => {
      const received: unknown[] = [];
      server = new WebhookServer({
        port: TEST_PORT,
        host: TEST_HOST,
        authToken: "secret-123",
      });
      server.onPlatform("whatsapp", async (body) => received.push(body));
      await server.start();

      const { status, data } = await req("POST", "/webhook/whatsapp", {
        body: { test: true },
        headers: { Authorization: "Bearer secret-123" },
      });

      expect(status).toBe(200);
      expect(data.received).toBe(true);

      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(1);
    });

    it("does not require auth when no token configured", async () => {
      const received: unknown[] = [];
      server = new WebhookServer({ port: TEST_PORT, host: TEST_HOST });
      server.onPlatform("whatsapp", async (body) => received.push(body));
      await server.start();

      const { status } = await req("POST", "/webhook/whatsapp", {
        body: { ok: true },
      });

      expect(status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Malformed payloads
  // -----------------------------------------------------------------------

  describe("malformed payloads", () => {
    it("returns 200 on invalid JSON (prevents retries)", async () => {
      server = new WebhookServer({ port: TEST_PORT, host: TEST_HOST });
      server.onPlatform("whatsapp", async () => {});
      await server.start();

      const res = await fetch(
        `http://127.0.0.1:${TEST_PORT}/webhook/whatsapp`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Connection: "close" },
          body: "not valid json {{{",
        },
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.error).toBe("Malformed payload");
    });

    it("returns 200 on empty body", async () => {
      server = new WebhookServer({ port: TEST_PORT, host: TEST_HOST });
      server.onPlatform("whatsapp", async () => {});
      await server.start();

      const res = await fetch(
        `http://127.0.0.1:${TEST_PORT}/webhook/whatsapp`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );

      expect(res.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // WhatsApp verification challenge
  // -----------------------------------------------------------------------

  describe("WhatsApp verification", () => {
    it("responds with challenge when token matches", async () => {
      server = new WebhookServer({
        port: TEST_PORT,
        host: TEST_HOST,
        whatsappVerifyToken: "my_verify_token",
      });
      await server.start();

      const params = new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.verify_token": "my_verify_token",
        "hub.challenge": "challenge_abc123",
      });

      const res = await fetch(
        `http://127.0.0.1:${TEST_PORT}/webhook/whatsapp?${params}`,
      );

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("challenge_abc123");
    });

    it("returns 403 when token does not match", async () => {
      server = new WebhookServer({
        port: TEST_PORT,
        host: TEST_HOST,
        whatsappVerifyToken: "my_verify_token",
      });
      await server.start();

      const params = new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong_token",
        "hub.challenge": "challenge_abc123",
      });

      const res = await fetch(
        `http://127.0.0.1:${TEST_PORT}/webhook/whatsapp?${params}`,
      );

      expect(res.status).toBe(403);
    });

    it("returns 403 when no verify token configured", async () => {
      server = new WebhookServer({ port: TEST_PORT, host: TEST_HOST });
      await server.start();

      const params = new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.verify_token": "any_token",
        "hub.challenge": "challenge_abc123",
      });

      const res = await fetch(
        `http://127.0.0.1:${TEST_PORT}/webhook/whatsapp?${params}`,
      );

      expect(res.status).toBe(403);
    });
  });

  // -----------------------------------------------------------------------
  // 404
  // -----------------------------------------------------------------------

  describe("unknown routes", () => {
    it("returns 404 for unknown paths", async () => {
      server = new WebhookServer({ port: TEST_PORT, host: TEST_HOST });
      await server.start();

      const { status, data } = await req("GET", "/unknown");
      expect(status).toBe(404);
      expect(data.error).toBe("Not found");
    });
  });

  // -----------------------------------------------------------------------
  // Handler errors
  // -----------------------------------------------------------------------

  describe("handler errors", () => {
    it("does not crash when handler throws", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      server = new WebhookServer({ port: TEST_PORT, host: TEST_HOST });
      server.onPlatform("test", async () => {
        throw new Error("Handler boom");
      });
      await server.start();

      const { status } = await req("POST", "/webhook/test", {
        body: { trigger: "error" },
      });

      // Returns 200 immediately before handler runs
      expect(status).toBe(200);

      // Wait for async handler
      await new Promise((r) => setTimeout(r, 50));

      // Server should still be running
      expect(server.listening).toBe(true);

      // Error was logged
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[webhook-server]"),
        expect.stringContaining("Handler boom"),
      );

      consoleSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  describe("lifecycle", () => {
    it("start and stop cleanly", async () => {
      server = new WebhookServer({ port: TEST_PORT, host: TEST_HOST });
      await server.start();
      expect(server.listening).toBe(true);

      await server.stop();
      expect(server.listening).toBe(false);
    });

    it("stop is idempotent", async () => {
      server = new WebhookServer({ port: TEST_PORT, host: TEST_HOST });
      await server.start();
      await server.stop();
      await server.stop(); // should not throw
    });
  });
});
