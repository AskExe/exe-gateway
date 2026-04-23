/**
 * Web chat adapter — server-side for Deep Chat widget.
 *
 * Implements PlatformAdapter with HTTP POST + WebSocket endpoints.
 * Deep Chat (github.com/OvidijusParsiunas/deep-chat) handles the frontend.
 *
 * Endpoints:
 *   POST /gateway/chat    — message exchange (Deep Chat `connect` config)
 *   GET  /gateway/health   — health check
 *
 * Phase 1: HTTP-only (no WebSocket streaming yet — add in Phase 3).
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  NormalizedMessage,
  PlatformAdapter,
  PlatformConfig,
  SendOptions,
} from "../types.js";

interface DeepChatRequest {
  messages: Array<{ role: string; text: string }>;
  sessionId?: string;
}

interface DeepChatResponse {
  text: string;
}

/** Pending response resolvers keyed by request ID */
type ResponseResolver = (text: string) => void;

export class WebChatAdapter implements PlatformAdapter {
  readonly platform = "webchat" as const;

  private server: Server | null = null;
  private messageHandler: ((msg: NormalizedMessage) => Promise<void>) | null = null;
  private pendingResponses = new Map<string, ResponseResolver>();
  private port = 3001;
  private corsOrigin = "*";

  async connect(config: PlatformConfig): Promise<void> {
    if (config.credentials.port) {
      this.port = parseInt(config.credentials.port, 10);
    }
    if (config.credentials.corsOrigin) {
      this.corsOrigin = config.credentials.corsOrigin;
    }

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, () => {
        console.log(`[webchat] Listening on port ${this.port}`);
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async sendText(
    channelId: string,
    text: string,
    _options?: SendOptions,
  ): Promise<void> {
    const resolver = this.pendingResponses.get(channelId);
    if (resolver) {
      resolver(text);
      this.pendingResponses.delete(channelId);
    }
  }

  async sendTyping(_channelId: string): Promise<void> {
    // HTTP mode — no typing indicators (add with WebSocket in Phase 3)
  }

  async healthCheck(): Promise<{ connected: boolean; latencyMs?: number }> {
    return { connected: this.server !== null && this.server.listening };
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", this.corsOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/gateway/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", adapter: "webchat" }));
      return;
    }

    if (req.method === "POST" && req.url === "/gateway/chat") {
      await this.handleChatRequest(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private async handleChatRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const MAX_BODY_SIZE = 1_048_576; // 1 MB
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
        return;
      }
    }

    let parsed: DeepChatRequest;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const lastMessage = parsed.messages?.at(-1);
    if (!lastMessage?.text) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No message text" }));
      return;
    }

    const requestId = randomUUID();
    const sessionId = parsed.sessionId ?? this.extractSessionId(req);

    const normalized: NormalizedMessage = {
      messageId: requestId,
      platform: "webchat",
      senderId: sessionId,
      channelId: requestId, // Used as response correlation key
      chatType: "direct",
      text: lastMessage.text,
      timestamp: new Date().toISOString(),
      raw: parsed,
    };

    if (!this.messageHandler) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No message handler configured" }));
      return;
    }

    // Create a promise that resolves when sendText is called for this request
    const responsePromise = new Promise<string>((resolve) => {
      this.pendingResponses.set(requestId, resolve);
      // Timeout after 30s
      setTimeout(() => {
        if (this.pendingResponses.has(requestId)) {
          this.pendingResponses.delete(requestId);
          resolve("Sorry, the request timed out. Please try again.");
        }
      }, 30_000);
    });

    // Trigger the message handler (gateway will route → bot → sendText)
    try {
      await this.messageHandler(normalized);
    } catch (err) {
      this.pendingResponses.delete(requestId);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
      return;
    }

    // Wait for the response
    const responseText = await responsePromise;
    const deepChatResponse: DeepChatResponse = { text: responseText };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(deepChatResponse));
  }

  private extractSessionId(req: IncomingMessage): string {
    // Try to extract session from cookie or generate new
    const cookies = req.headers.cookie ?? "";
    const match = cookies.match(/exe_session=([^;]+)/);
    return match?.[1] ?? `anon-${randomUUID().slice(0, 8)}`;
  }
}
