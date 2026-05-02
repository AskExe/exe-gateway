/**
 * WebSocket relay — pushes live gateway events to authenticated Tauri/TUI clients.
 *
 * Listens on a local port; nginx TLS proxy provides wss:// to remote clients.
 * Example: wss://gateway.domain/ws → nginx → ws://127.0.0.1:${port}
 *
 * Auth flow:
 *   1. Client connects to wss://gateway.domain/ws (TLS via nginx)
 *   2. Client sends { type: "auth", token: "<hex-encoded ws-auth token>" }
 *   3. Server hashes token with SHA-256, compares to authTokenHash
 *   4. Match → authenticated. No match → disconnected.
 *   5. Clients that don't auth within AUTH_TIMEOUT_MS are disconnected.
 *
 * After auth, clients can subscribe to specific platform channels.
 * Default subscription is "all".
 */

import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const AUTH_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const DEFAULT_HOST = "127.0.0.1";
const ALL_CHANNELS = "all";

export interface WsRelayConfig {
  port: number;
  host?: string;
  authTokenHash: string;
}

export type GatewayEvent = Record<string, unknown> & {
  type: string;
  platform?: string;
};

interface ClientState {
  authenticated: boolean;
  channels: Set<string>;
  authTimer: ReturnType<typeof setTimeout> | null;
  alive: boolean;
}

export class WsRelay {
  private wss: WebSocketServer | null = null;
  private clients = new Map<WebSocket, ClientState>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: WsRelayConfig) {}

  /** Start WebSocket server */
  async start(): Promise<void> {
    const host = this.config.host ?? DEFAULT_HOST;

    this.wss = new WebSocketServer({ port: this.config.port, host });

    await new Promise<void>((resolve) => {
      this.wss!.on("listening", () => {
        console.log(`[ws-relay] Listening on ${host}:${this.config.port}`);
        resolve();
      });
    });

    this.wss.on("connection", (ws) => this.handleConnection(ws));
    this.startHeartbeat();
  }

  /** Broadcast event to all authenticated clients, filtered by subscription */
  broadcast(event: GatewayEvent): void {
    const payload = JSON.stringify(event);
    const platform = typeof event.platform === "string" ? event.platform : null;

    for (const [ws, state] of this.clients) {
      if (!state.authenticated) continue;
      if (ws.readyState !== WebSocket.OPEN) continue;

      const subscribed =
        state.channels.has(ALL_CHANNELS) ||
        (platform !== null && state.channels.has(platform));

      if (subscribed) {
        ws.send(payload);
      }
    }
  }

  /** Graceful shutdown — closes all connections */
  async stop(): Promise<void> {
    this.stopHeartbeat();

    for (const [ws, state] of this.clients) {
      if (state.authTimer) clearTimeout(state.authTimer);
      ws.close();
    }
    this.clients.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }

    console.log("[ws-relay] Stopped");
  }

  /** Number of authenticated clients */
  get clientCount(): number {
    let count = 0;
    for (const state of this.clients.values()) {
      if (state.authenticated) count++;
    }
    return count;
  }

  private handleConnection(ws: WebSocket): void {
    const state: ClientState = {
      authenticated: false,
      channels: new Set([ALL_CHANNELS]),
      authTimer: null,
      alive: true,
    };

    // Auth timeout — disconnect if not authenticated within AUTH_TIMEOUT_MS
    state.authTimer = setTimeout(() => {
      if (!state.authenticated) {
        sendMessage(ws, { type: "error", message: "auth timeout" });
        ws.close();
        this.clients.delete(ws);
      }
    }, AUTH_TIMEOUT_MS);

    this.clients.set(ws, state);

    ws.on("message", (data) => {
      this.handleClientMessage(ws, state, data);
    });

    ws.on("close", () => {
      if (state.authTimer) clearTimeout(state.authTimer);
      this.clients.delete(ws);
    });

    ws.on("error", (err) => {
      console.error("[ws-relay] Client error:", err.message);
      this.clients.delete(ws);
    });

    ws.on("pong", () => {
      state.alive = true;
    });
  }

  private handleClientMessage(
    ws: WebSocket,
    state: ClientState,
    data: unknown,
  ): void {
    let msg: { type: string; token?: string; channels?: string[] };
    try {
      msg = JSON.parse(String(data));
    } catch {
      sendMessage(ws, { type: "error", message: "invalid JSON" });
      return;
    }

    if (msg.type === "auth") {
      this.handleAuth(ws, state, msg.token ?? "");
      return;
    }

    if (msg.type === "subscribe" && state.authenticated) {
      this.handleSubscribe(state, msg.channels ?? [ALL_CHANNELS]);
      return;
    }

    if (msg.type === "pong") {
      state.alive = true;
      return;
    }
  }

  private handleAuth(ws: WebSocket, state: ClientState, token: string): void {
    const tokenBuffer = Buffer.from(token, "hex");
    const hash = crypto.createHash("sha256").update(tokenBuffer).digest("hex");

    // Constant-time comparison to prevent timing side-channel attacks
    const hashBuf = Buffer.from(hash, "hex");
    const expectedBuf = Buffer.from(this.config.authTokenHash, "hex");
    const match =
      hashBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(hashBuf, expectedBuf);

    if (match) {
      state.authenticated = true;
      if (state.authTimer) {
        clearTimeout(state.authTimer);
        state.authTimer = null;
      }
      sendMessage(ws, { type: "auth", status: "ok" });
    } else {
      sendMessage(ws, { type: "error", message: "unauthorized" });
      ws.close();
      this.clients.delete(ws);
    }
  }

  private handleSubscribe(state: ClientState, channels: string[]): void {
    state.channels.clear();
    for (const ch of channels) {
      state.channels.add(ch);
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [ws, state] of this.clients) {
        if (!state.authenticated) continue;

        if (!state.alive) {
          // Didn't respond to last ping — disconnect
          ws.close();
          this.clients.delete(ws);
          continue;
        }

        state.alive = false;
        ws.ping();
        sendMessage(ws, { type: "ping" });

        // Set pong timeout
        setTimeout(() => {
          if (!state.alive && this.clients.has(ws)) {
            ws.close();
            this.clients.delete(ws);
          }
        }, PONG_TIMEOUT_MS);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

/** Send a JSON message to a WebSocket client */
function sendMessage(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
