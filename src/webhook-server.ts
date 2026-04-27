/**
 * Webhook HTTP server — accepts incoming webhooks from external platforms
 * and routes them to registered platform handlers.
 *
 * Routes:
 *   GET  /health             — server health + uptime + registered platforms
 *   POST /webhook/:platform  — incoming webhook payload for a platform
 *   GET  /webhook/whatsapp   — WhatsApp verification challenge
 *   POST /api/send           — send outbound message via adapter
 *   GET  /api/groups         — list WhatsApp groups
 *   GET  /api/group/:id      — group info + recent messages
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

const DEFAULT_HOST = "127.0.0.1";
const BODY_SIZE_LIMIT = 1_048_576; // 1 MB

export interface WebhookServerConfig {
  port: number;
  host?: string;
  authToken?: string;
  whatsappVerifyToken?: string;
}

type PlatformHandler = (body: unknown) => Promise<void>;

/** Minimal adapter interface for outbound send */
interface OutboundAdapter {
  platform: string;
  sendText(channelId: string, text: string, options?: Record<string, unknown>): Promise<void>;
  /** Baileys socket for raw API access (WhatsApp only) */
  getRawSocket?(): unknown;
}

export class WebhookServer {
  private server: Server | null = null;
  private handlers = new Map<string, PlatformHandler>();
  private adapters = new Map<string, OutboundAdapter>();
  private startedAt = 0;

  constructor(private config: WebhookServerConfig) {
    if (process.env.NODE_ENV === "production" && !config.authToken) {
      throw new Error(
        "[webhook-server] authToken is required in production. " +
          "Set it in ~/.exe-os/gateway.json or pass it in WebhookServerConfig.",
      );
    }
  }

  /** Register a handler for a platform: POST /webhook/:platform */
  onPlatform(platform: string, handler: PlatformHandler): void {
    this.handlers.set(platform, handler);
  }

  /** Register an adapter for outbound messaging: POST /api/send */
  registerAdapter(platform: string, adapter: OutboundAdapter): void {
    this.adapters.set(platform, adapter);
  }

  /** Start listening */
  async start(): Promise<void> {
    const host = this.config.host ?? DEFAULT_HOST;

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, host, () => {
        this.startedAt = Date.now();
        console.log(
          `[webhook-server] Listening on ${host}:${this.config.port}`,
        );
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  /** Graceful shutdown — closes all open connections */
  async stop(): Promise<void> {
    if (!this.server) return;
    // Force-close idle connections so close() doesn't hang
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
    console.log("[webhook-server] Stopped");
  }

  /** Whether the server is currently listening */
  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // Health endpoint
    if (method === "GET" && url === "/health") {
      this.handleHealth(res);
      return;
    }

    // WhatsApp verification challenge
    if (method === "GET" && url.startsWith("/webhook/whatsapp")) {
      this.handleWhatsAppVerification(req, res);
      return;
    }

    // Webhook POST routes
    if (method === "POST" && url.startsWith("/webhook/")) {
      await this.handleWebhookPost(req, res, url);
      return;
    }

    // --- Outbound API ---

    // POST /api/send — send message via adapter
    if (method === "POST" && url === "/api/send") {
      if (this.config.authToken && !this.verifyAuth(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      await this.handleApiSend(req, res);
      return;
    }

    // GET /api/groups — list WhatsApp groups
    if (method === "GET" && url === "/api/groups") {
      if (this.config.authToken && !this.verifyAuth(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      await this.handleApiGroups(res);
      return;
    }

    // GET /api/group/:id — group info
    if (method === "GET" && url.startsWith("/api/group/")) {
      if (this.config.authToken && !this.verifyAuth(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const groupId = url.replace("/api/group/", "").split("?")[0];
      await this.handleApiGroupInfo(res, groupId);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  }

  private handleHealth(res: ServerResponse): void {
    const uptime = this.startedAt > 0 ? Date.now() - this.startedAt : 0;
    sendJson(res, 200, {
      status: "ok",
      uptime,
      handlers: [...this.handlers.keys()],
    });
  }

  private handleWhatsAppVerification(
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (
      mode === "subscribe" &&
      token &&
      challenge &&
      this.config.whatsappVerifyToken &&
      token === this.config.whatsappVerifyToken
    ) {
      res.writeHead(200, { "Content-Type": "text/plain", "Connection": "close" });
      res.end(challenge);
      return;
    }

    sendJson(res, 403, { error: "Verification failed" });
  }

  private async handleWebhookPost(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<void> {
    // Always consume body first to prevent connection resets
    let body: unknown;
    let parseError: Error | null = null;
    try {
      body = await readBody(req);
    } catch (err) {
      parseError = err instanceof Error ? err : new Error(String(err));
    }

    // Auth check (after body is drained)
    if (this.config.authToken && !this.verifyAuth(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    // Extract platform from path: /webhook/:platform
    const platform = extractPlatform(url);
    if (!platform) {
      sendJson(res, 200, { error: "No platform specified" });
      return;
    }

    const handler = this.handlers.get(platform);
    if (!handler) {
      // Return 200 to prevent webhook retries
      sendJson(res, 200, { error: `No handler for platform: ${platform}` });
      return;
    }

    // Handle parse errors
    if (parseError) {
      console.error(
        `[webhook-server] Malformed payload on /webhook/${platform}:`,
        parseError.message,
      );
      sendJson(res, 200, { received: true, error: "Malformed payload" });
      return;
    }

    // Process asynchronously — return 200 immediately
    sendJson(res, 200, { received: true });

    try {
      await handler(body);
    } catch (err) {
      console.error(
        `[webhook-server] Handler error for ${platform}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private verifyAuth(req: IncomingMessage): boolean {
    const authHeader = req.headers.authorization ?? "";
    return authHeader === `Bearer ${this.config.authToken}`;
  }

  // ---- Outbound API handlers ----

  private async handleApiSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = (await readBody(req)) as Record<string, unknown>;
      const platform = (body.platform as string) ?? "whatsapp";
      const to = body.to as string;
      const text = body.text as string;

      if (!to || !text) {
        sendJson(res, 400, { error: "Missing 'to' and/or 'text' fields" });
        return;
      }

      const adapter = this.adapters.get(platform);
      if (!adapter) {
        sendJson(res, 400, { error: `No adapter for platform: ${platform}. Available: ${[...this.adapters.keys()].join(", ")}` });
        return;
      }

      // Normalize phone number for WhatsApp JID
      const channelId = platform === "whatsapp"
        ? to.replace(/[^0-9]/g, "") + "@s.whatsapp.net"
        : to;

      await adapter.sendText(channelId, text);
      sendJson(res, 200, { sent: true, platform, to: channelId });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleApiGroups(res: ServerResponse): Promise<void> {
    try {
      const adapter = this.adapters.get("whatsapp");
      if (!adapter?.getRawSocket) {
        sendJson(res, 400, { error: "WhatsApp adapter not available or no raw socket access" });
        return;
      }

      const sock = adapter.getRawSocket() as Record<string, Function>;
      if (!sock?.groupFetchAllParticipating) {
        sendJson(res, 500, { error: "Baileys socket missing groupFetchAllParticipating" });
        return;
      }

      const groups = await sock.groupFetchAllParticipating();
      const result = Object.values(groups).map((g: any) => ({
        id: g.id,
        subject: g.subject,
        owner: g.owner,
        participants: g.participants?.length ?? 0,
        creation: g.creation,
      }));

      sendJson(res, 200, { groups: result as unknown as Record<string, unknown>[] });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleApiGroupInfo(res: ServerResponse, groupId: string): Promise<void> {
    try {
      const adapter = this.adapters.get("whatsapp");
      if (!adapter?.getRawSocket) {
        sendJson(res, 400, { error: "WhatsApp adapter not available" });
        return;
      }

      const sock = adapter.getRawSocket() as Record<string, Function>;
      // Ensure group JID format
      const jid = groupId.includes("@") ? groupId : groupId + "@g.us";

      const metadata = await sock.groupMetadata(jid);
      sendJson(res, 200, {
        id: (metadata as any).id,
        subject: (metadata as any).subject,
        owner: (metadata as any).owner,
        creation: (metadata as any).creation,
        participants: (metadata as any).participants?.map((p: any) => ({
          id: p.id,
          admin: p.admin ?? null,
        })),
      } as unknown as Record<string, unknown>);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Extract platform name from URL path /webhook/:platform */
function extractPlatform(url: string): string | null {
  const match = url.match(/^\/webhook\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

/** Read and parse JSON body from an incoming request */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_SIZE_LIMIT) {
        if (!done) {
          done = true;
          req.resume();
          reject(new Error("Body too large"));
        }
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

/** Send a JSON response. Webhook servers don't need keep-alive. */
function sendJson(
  res: ServerResponse,
  status: number,
  data: Record<string, unknown>,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Connection": "close",
  });
  res.end(JSON.stringify(data));
}
