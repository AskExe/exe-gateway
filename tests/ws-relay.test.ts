import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import WebSocket from "ws";
import { WsRelay, type GatewayEvent } from "../src/ws-relay.js";

const TEST_PORT = 19877;
const VALID_TOKEN = crypto.randomBytes(32);
const VALID_TOKEN_HEX = VALID_TOKEN.toString("hex");
const VALID_TOKEN_HASH = crypto.createHash("sha256").update(VALID_TOKEN).digest("hex");

/** Connect a WebSocket client to the test server */
function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** Send JSON and wait for a response */
function sendAndReceive(
  ws: WebSocket,
  msg: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => {
      resolve(JSON.parse(String(data)));
    });
    ws.send(JSON.stringify(msg));
  });
}

/** Wait for next message on a WebSocket */
function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => {
      resolve(JSON.parse(String(data)));
    });
  });
}

/** Authenticate a client */
async function authenticate(ws: WebSocket): Promise<Record<string, unknown>> {
  return sendAndReceive(ws, { type: "auth", token: VALID_TOKEN_HEX });
}

describe("WsRelay", () => {
  let relay: WsRelay;

  afterEach(async () => {
    if (relay) {
      await relay.stop();
    }
  });

  async function startRelay(): Promise<void> {
    relay = new WsRelay({
      port: TEST_PORT,
      authTokenHash: VALID_TOKEN_HASH,
    });
    await relay.start();
  }

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  describe("authentication", () => {
    it("accepts valid token", async () => {
      await startRelay();
      const ws = await connect();

      const response = await authenticate(ws);

      expect(response.type).toBe("auth");
      expect(response.status).toBe("ok");
      expect(relay.clientCount).toBe(1);

      ws.close();
    });

    it("rejects invalid token", async () => {
      await startRelay();
      const ws = await connect();

      const badToken = crypto.randomBytes(32).toString("hex");
      const response = await sendAndReceive(ws, { type: "auth", token: badToken });

      expect(response.type).toBe("error");
      expect(response.message).toBe("unauthorized");

      // Wait for close
      await new Promise<void>((resolve) => ws.on("close", resolve));
      expect(relay.clientCount).toBe(0);
    });

    it("disconnects if no auth within timeout", async () => {
      // This test uses a short timeout by testing the actual behavior
      await startRelay();
      const ws = await connect();

      // Wait for error message (auth timeout is 5s)
      const response = await new Promise<Record<string, unknown>>((resolve) => {
        ws.on("message", (data) => {
          resolve(JSON.parse(String(data)));
        });
      });

      expect(response.type).toBe("error");
      expect(response.message).toBe("auth timeout");

      await new Promise<void>((resolve) => ws.on("close", resolve));
    }, 10_000);

    it("handles invalid JSON gracefully", async () => {
      await startRelay();
      const ws = await connect();

      const response = await new Promise<Record<string, unknown>>((resolve) => {
        ws.once("message", (data) => resolve(JSON.parse(String(data))));
        ws.send("not json {{{");
      });

      expect(response.type).toBe("error");
      expect(response.message).toBe("invalid JSON");

      ws.close();
    });
  });

  // -----------------------------------------------------------------------
  // Broadcast
  // -----------------------------------------------------------------------

  describe("broadcast", () => {
    it("sends events to authenticated clients", async () => {
      await startRelay();
      const ws = await connect();
      await authenticate(ws);

      const msgPromise = nextMessage(ws);
      const event: GatewayEvent = {
        type: "message_received",
        platform: "whatsapp",
        senderId: "+15551234",
        text: "Hello",
        timestamp: new Date().toISOString(),
      };
      relay.broadcast(event);

      const received = await msgPromise;
      expect(received.type).toBe("message_received");
      expect(received.platform).toBe("whatsapp");
      expect(received.text).toBe("Hello");

      ws.close();
    });

    it("does not send to unauthenticated clients", async () => {
      await startRelay();
      const ws = await connect();
      // Don't authenticate

      const received: unknown[] = [];
      ws.on("message", (data) => received.push(JSON.parse(String(data))));

      relay.broadcast({
        type: "message_received",
        platform: "whatsapp",
        senderId: "+15551234",
        text: "Secret",
        timestamp: new Date().toISOString(),
      });

      // Small delay to confirm no message arrives
      await new Promise((r) => setTimeout(r, 100));
      // Filter out any auth-timeout messages
      const broadcasts = received.filter(
        (m) => (m as Record<string, unknown>).type === "message_received",
      );
      expect(broadcasts).toHaveLength(0);

      ws.close();
    });

    it("sends to multiple clients", async () => {
      await startRelay();
      const ws1 = await connect();
      const ws2 = await connect();
      await authenticate(ws1);
      await authenticate(ws2);

      expect(relay.clientCount).toBe(2);

      const p1 = nextMessage(ws1);
      const p2 = nextMessage(ws2);

      relay.broadcast({
        type: "agent_status",
        agentId: "yoshi",
        status: "online",
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.type).toBe("agent_status");
      expect(r2.type).toBe("agent_status");

      ws1.close();
      ws2.close();
    });
  });

  // -----------------------------------------------------------------------
  // Subscription filtering
  // -----------------------------------------------------------------------

  describe("subscription filtering", () => {
    it("default subscription receives all events", async () => {
      await startRelay();
      const ws = await connect();
      await authenticate(ws);

      const p = nextMessage(ws);
      relay.broadcast({
        type: "message_received",
        platform: "email",
        senderId: "alice@test.com",
        text: "Hi",
        timestamp: new Date().toISOString(),
      });

      const r = await p;
      expect(r.type).toBe("message_received");

      ws.close();
    });

    it("filters events by subscribed channels", async () => {
      await startRelay();
      const ws = await connect();
      await authenticate(ws);

      // Subscribe to whatsapp only
      ws.send(JSON.stringify({ type: "subscribe", channels: ["whatsapp"] }));
      await new Promise((r) => setTimeout(r, 50));

      const received: unknown[] = [];
      ws.on("message", (data) => received.push(JSON.parse(String(data))));

      // Send email event (should be filtered)
      relay.broadcast({
        type: "message_received",
        platform: "email",
        senderId: "bob@test.com",
        text: "Filtered",
        timestamp: new Date().toISOString(),
      });

      // Send whatsapp event (should be received)
      relay.broadcast({
        type: "message_received",
        platform: "whatsapp",
        senderId: "+1555",
        text: "Delivered",
        timestamp: new Date().toISOString(),
      });

      await new Promise((r) => setTimeout(r, 100));

      const broadcasts = received.filter(
        (m) => (m as Record<string, unknown>).type === "message_received",
      );
      expect(broadcasts).toHaveLength(1);
      expect((broadcasts[0] as Record<string, unknown>).platform).toBe("whatsapp");

      ws.close();
    });

    it("non-platform events go to all-channel subscribers only", async () => {
      await startRelay();
      const ws = await connect();
      await authenticate(ws);

      // Subscribe to whatsapp only (not "all")
      ws.send(JSON.stringify({ type: "subscribe", channels: ["whatsapp"] }));
      await new Promise((r) => setTimeout(r, 50));

      const received: unknown[] = [];
      ws.on("message", (data) => received.push(JSON.parse(String(data))));

      // agent_status has no platform field
      relay.broadcast({
        type: "agent_status",
        agentId: "yoshi",
        status: "online",
      });

      await new Promise((r) => setTimeout(r, 100));

      const statusEvents = received.filter(
        (m) => (m as Record<string, unknown>).type === "agent_status",
      );
      expect(statusEvents).toHaveLength(0);

      ws.close();
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  describe("lifecycle", () => {
    it("starts and stops cleanly", async () => {
      await startRelay();
      expect(relay.clientCount).toBe(0);
      await relay.stop();
    });

    it("disconnects all clients on stop", async () => {
      await startRelay();
      const ws1 = await connect();
      const ws2 = await connect();
      await authenticate(ws1);
      await authenticate(ws2);

      expect(relay.clientCount).toBe(2);

      const closePromises = [
        new Promise<void>((r) => ws1.on("close", r)),
        new Promise<void>((r) => ws2.on("close", r)),
      ];

      await relay.stop();
      await Promise.all(closePromises);
    });

    it("clientCount reflects authenticated clients only", async () => {
      await startRelay();
      expect(relay.clientCount).toBe(0);

      const ws = await connect();
      // Connected but not authenticated
      expect(relay.clientCount).toBe(0);

      await authenticate(ws);
      expect(relay.clientCount).toBe(1);

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(relay.clientCount).toBe(0);
    });
  });
});
