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
 *   POST /v1/messages        — LLM proxy (Anthropic Messages API compatible)
 *   GET  /v1/usage/:customer — usage summary for a customer
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import crypto from "node:crypto";

const DEFAULT_HOST = "127.0.0.1";
const BODY_SIZE_LIMIT = 1_048_576; // 1 MB

export interface WebhookServerConfig {
  port: number;
  host?: string;
  authToken?: string;
  authTokenHash?: string;
  whatsappVerifyToken?: string;
  webhookSignatures?: WebhookSignatureConfig;
}

type PlatformHandler = (body: unknown) => Promise<void>;

export interface WebhookSignatureConfig {
  whatsappAppSecrets?: string[];
  telegramSecretTokens?: string[];
  discordPublicKeys?: string[];
}

import { OutboundLimiter } from "./outbound-limiter.js";
import { handleProxyRequest, type LLMProxyConfig } from "./llm-proxy.js";
import { getUsageSummary } from "./metering.js";

/** Minimal adapter interface for outbound send */
interface OutboundAdapter {
  platform: string;
  accountName?: string;
  sendText(channelId: string, text: string, options?: Record<string, unknown>): Promise<void>;
  sendTyping?(channelId: string): Promise<void>;
  /** Baileys socket for raw API access (WhatsApp only) */
  getRawSocket?(): unknown;
}

export class WebhookServer {
  private server: Server | null = null;
  private handlers = new Map<string, PlatformHandler>();
  private adapters = new Map<string, OutboundAdapter>();
  private limiters = new Map<string, OutboundLimiter>();
  private startedAt = 0;
  private _readOnly = false;
  private _dbAvailable = false;
  private proxyConfig: LLMProxyConfig | null = null;
  private readonly authTokenHash: string | null;
  private readonly webhookSignatures: Required<WebhookSignatureConfig>;

  /** Enable read-only mode — rejects all outbound sends via /api/send */
  setReadOnly(enabled: boolean): void {
    this._readOnly = enabled;
  }

  /** Mark conversation storage as available (called after successful DB init) */
  setDbAvailable(available: boolean): void {
    this._dbAvailable = available;
  }

  /** Enable LLM proxy at /v1/messages */
  setProxyConfig(config: LLMProxyConfig): void {
    this.proxyConfig = config;
    console.log(
      `[webhook-server] LLM proxy enabled at /v1/messages (margin: ${config.marginPercent}%)`,
    );
  }

  constructor(private config: WebhookServerConfig) {
    this.authTokenHash = normalizeSha256Hex(config.authTokenHash) ??
      (config.authToken ? sha256Hex(config.authToken) : null);
    this.webhookSignatures = normalizeWebhookSignatures(config.webhookSignatures);
    const host = config.host ?? DEFAULT_HOST;
    if ((process.env.NODE_ENV === "production" || isPublicBindHost(host)) && !this.authTokenHash) {
      throw new Error(
        "[webhook-server] authToken is required in production. " +
          "Set EXE_GATEWAY_AUTH_TOKEN_HASH/EXE_GATEWAY_AUTH_TOKEN, authTokenHash/authToken in the config file, or pass it in WebhookServerConfig.",
      );
    }
  }

  /** Register a handler for a platform: POST /webhook/:platform */
  onPlatform(platform: string, handler: PlatformHandler): void {
    this.handlers.set(platform, handler);
  }

  /** Register an adapter for outbound messaging: POST /api/send */
  registerAdapter(
    platform: string,
    adapter: OutboundAdapter,
    accountName = adapter.accountName ?? "default",
  ): void {
    const normalizedPlatform = platform.trim().toLowerCase();
    const key = adapterKey(normalizedPlatform, normalizeAccountName(accountName) ?? "default");
    this.adapters.set(key, adapter);
    this.limiters.set(
      key,
      new OutboundLimiter(normalizedPlatform, getOutboundLimiterTestOverrides()),
    );
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

    // ---- LLM Proxy routes (before auth — proxy has its own auth via exe_sk_*) ----

    // POST /v1/messages — Anthropic Messages API proxy
    if (method === "POST" && url === "/v1/messages") {
      if (!this.proxyConfig) {
        sendJson(res, 404, { error: "LLM proxy not configured" });
        return;
      }
      await handleProxyRequest(req, res, this.proxyConfig);
      return;
    }

    // GET /v1/usage/:customerId — usage summary (admin auth required)
    if (method === "GET" && url.startsWith("/v1/usage/")) {
      if (this.authTokenHash && !this.verifyAuth(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      await this.handleUsageSummary(req, res, url);
      return;
    }

    // ---- Standard routes ----

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
      if (this.authTokenHash && !this.verifyAuth(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      await this.handleApiSend(req, res);
      return;
    }

    // GET /api/limits — show rate limits and stats
    if (method === "GET" && url === "/api/limits") {
      if (this.authTokenHash && !this.verifyAuth(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      this.handleApiLimits(res);
      return;
    }

    // GET /api/groups — list WhatsApp groups
    if (method === "GET" && url.startsWith("/api/groups")) {
      if (this.authTokenHash && !this.verifyAuth(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      await this.handleApiGroups(req, res);
      return;
    }

    // GET /api/group/:id — group info
    if (method === "GET" && url.startsWith("/api/group/")) {
      if (this.authTokenHash && !this.verifyAuth(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const groupId = url.replace("/api/group/", "").split("?")[0];
      await this.handleApiGroupInfo(req, res, groupId);
      return;
    }

    // GET /api/threads — list threads with contact info
    if (method === "GET" && url.startsWith("/api/threads") && !url.startsWith("/api/threads/")) {
      if (this.authTokenHash && !this.verifyAuth(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      await this.handleApiThreads(req, res);
      return;
    }

    // GET /api/threads/:id/messages — paginated messages
    if (method === "GET" && /^\/api\/threads\/\d+\/messages/.test(url)) {
      if (this.authTokenHash && !this.verifyAuth(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const threadId = parseInt(url.match(/\/api\/threads\/(\d+)\/messages/)![1], 10);
      await this.handleApiThreadMessages(req, res, threadId);
      return;
    }

    // GET /api/contacts — list contacts
    if (method === "GET" && url.startsWith("/api/contacts") && !url.startsWith("/api/contacts/")) {
      if (this.authTokenHash && !this.verifyAuth(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      await this.handleApiContacts(req, res);
      return;
    }

    // GET /api/contacts/:id — contact detail
    if (method === "GET" && /^\/api\/contacts\/\d+/.test(url)) {
      if (this.authTokenHash && !this.verifyAuth(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const contactId = parseInt(url.match(/\/api\/contacts\/(\d+)/)![1], 10);
      await this.handleApiContactDetail(res, contactId);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  }

  private handleHealth(res: ServerResponse): void {
    const uptime = this.startedAt > 0 ? Date.now() - this.startedAt : 0;
    sendJson(res, 200, {
      status: "ok",
      mode: this._readOnly ? "read-only" : "normal",
      llmProxy: this.proxyConfig ? "enabled" : "disabled",
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

    let rawBody: Buffer = Buffer.alloc(0);
    let readError: Error | null = null;
    try {
      rawBody = await readRawBody(req);
    } catch (err) {
      readError = err instanceof Error ? err : new Error(String(err));
    }

    if (readError) {
      console.error(
        `[webhook-server] Malformed payload on /webhook/${platform}:`,
        readError.message,
      );
      sendJson(res, 200, { received: true, error: "Malformed payload" });
      return;
    }

    const verification = this.verifyWebhookRequest(platform, req, rawBody);
    if (!verification.ok) {
      sendJson(res, verification.status, { error: verification.error });
      return;
    }

    let body: unknown;
    try {
      body = parseJsonBody(rawBody);
    } catch (err) {
      const parseError = err instanceof Error ? err : new Error(String(err));
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
    if (!this.authTokenHash) return false;
    const token = extractBearerToken(req.headers.authorization);
    if (!token) return false;
    const actualBuffer = Buffer.from(sha256Hex(token), "hex");
    const expectedBuffer = Buffer.from(this.authTokenHash, "hex");
    return (
      actualBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    );
  }

  private verifyWebhookRequest(
    platform: string,
    req: IncomingMessage,
    rawBody: Buffer,
  ): WebhookVerificationResult {
    switch (platform) {
      case "whatsapp":
        return verifyWhatsAppWebhook(req, rawBody, this.webhookSignatures.whatsappAppSecrets);
      case "telegram":
        return verifyTelegramWebhook(req, this.webhookSignatures.telegramSecretTokens);
      case "discord":
        return verifyDiscordWebhook(req, rawBody, this.webhookSignatures.discordPublicKeys);
      default:
        if (this.authTokenHash && !this.verifyAuth(req)) {
          return { ok: false, status: 401, error: "Unauthorized" };
        }
        return { ok: true };
    }
  }

  // ---- LLM Proxy admin handlers ----

  private async handleUsageSummary(
    _req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<void> {
    if (!this._dbAvailable) {
      sendJson(res, 503, { error: "Database unavailable" });
      return;
    }
    try {
      const customerId = url.replace("/v1/usage/", "").split("?")[0];
      if (!customerId) {
        sendJson(res, 400, { error: "Missing customer_id in path" });
        return;
      }
      const params = parseQuery(url);
      const days = parseInt(params.days ?? "30", 10);
      const since = new Date(Date.now() - days * 86_400_000);
      const summary = await getUsageSummary(customerId, since);
      sendJson(res, 200, summary as unknown as Record<string, unknown>);
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---- Outbound API handlers ----

  private async handleApiSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Read-only gate — no outbound sends allowed
      if (this._readOnly) {
        sendJson(res, 403, { error: "Gateway is in read-only mode. Outbound sends are disabled." });
        return;
      }

      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const platform =
        typeof body.platform === "string"
          ? body.platform.trim().toLowerCase()
          : "whatsapp";
      const account = normalizeAccountName(
        typeof body.account === "string"
          ? body.account
          : typeof body.accountName === "string"
            ? body.accountName
            : undefined,
      );
      const to = body.to as string;
      const text = body.text as string;

      if (!to || !text) {
        sendJson(res, 400, { error: "Missing 'to' and/or 'text' fields" });
        return;
      }

      const resolved = this.resolveOutbound(platform, account);
      if (!resolved.adapter) {
        sendJson(res, 400, { error: resolved.error ?? `No adapter for platform: ${platform}.` });
        return;
      }
      const { adapter, accountName } = resolved;

      const limiter = this.limiters.get(adapterKey(platform, accountName));

      // Normalize to WhatsApp JID — preserve group (@g.us) and broadcast (@broadcast) suffixes
      const channelId = platform === "whatsapp"
        ? (to.includes("@") ? to : to.replace(/[^0-9]/g, "") + "@s.whatsapp.net")
        : to;

      if (limiter) {
        // Rate-limited send with typing simulation
        await limiter.send(
          channelId,
          text,
          (t) => adapter.sendText(channelId, t),
          adapter.sendTyping ? () => adapter.sendTyping!(channelId) : undefined,
        );
        const newStats = limiter.getStats();
        sendJson(res, 200, {
          sent: true,
          platform,
          account: accountName,
          to: channelId,
          rateLimited: true,
          stats: newStats,
        });
      } else {
        // Direct send (no rate limiting)
        await adapter.sendText(channelId, text);
        sendJson(res, 200, {
          sent: true,
          platform,
          account: accountName,
          to: channelId,
          rateLimited: false,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = msg.includes("limit reached");
      sendJson(res, isRateLimit ? 429 : 500, { error: msg });
    }
  }

  /** GET /api/limits — show current rate limits and stats for all platforms */
  private handleApiLimits(res: ServerResponse): void {
    const result: Record<string, unknown> = {};
    for (const [key, limiter] of this.limiters) {
      result[key] = {
        limits: limiter.getLimits(),
        stats: limiter.getStats(),
      };
    }
    sendJson(res, 200, result);
  }

  private async handleApiGroups(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const params = parseQuery(req.url ?? "");
      const account = normalizeAccountName(params.account ?? params.accountName);
      const resolved = this.resolveOutbound("whatsapp", account);
      if (!resolved.adapter?.getRawSocket) {
        sendJson(res, 400, {
          error: resolved.error ?? "WhatsApp adapter not available or no raw socket access",
        });
        return;
      }

      const sock = resolved.adapter.getRawSocket() as Record<string, Function>;
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

      sendJson(res, 200, {
        account: resolved.accountName,
        groups: result as unknown as Record<string, unknown>[],
      });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---- Conversation query API handlers ----

  private async handleApiThreads(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this._dbAvailable) {
      sendJson(res, 503, { error: "Conversation storage unavailable — database not configured or init failed" });
      return;
    }
    try {
      const { getThreads } = await import("./conversation-store.js");
      const params = parseQuery(req.url ?? "");
      const accountId = params.account_id ? parseInt(params.account_id, 10) : undefined;
      const limit = clampLimit(params.limit);
      const offset = parseInt(params.offset ?? "0", 10) || 0;

      const threads = await getThreads({ accountId, limit, offset });
      sendJson(res, 200, { threads: threads as unknown as Record<string, unknown>[] } as Record<string, unknown>);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleApiThreadMessages(req: IncomingMessage, res: ServerResponse, threadId: number): Promise<void> {
    if (!this._dbAvailable) {
      sendJson(res, 503, { error: "Conversation storage unavailable — database not configured or init failed" });
      return;
    }
    try {
      const { getThreadMessages } = await import("./conversation-store.js");
      const params = parseQuery(req.url ?? "");
      const limit = clampLimit(params.limit);
      const offset = parseInt(params.offset ?? "0", 10) || 0;

      const messages = await getThreadMessages(threadId, limit, offset);
      sendJson(res, 200, { messages: messages as unknown as Record<string, unknown>[] } as Record<string, unknown>);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleApiContacts(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this._dbAvailable) {
      sendJson(res, 503, { error: "Conversation storage unavailable — database not configured or init failed" });
      return;
    }
    try {
      const { getContacts } = await import("./conversation-store.js");
      const params = parseQuery(req.url ?? "");
      const limit = clampLimit(params.limit);
      const offset = parseInt(params.offset ?? "0", 10) || 0;

      let contacts = await getContacts({ limit, offset });

      // Filter by CRM link status if requested
      if (params.crm_linked === "true") {
        contacts = contacts.filter((c) => c.crmPersonId != null);
      } else if (params.crm_linked === "false") {
        contacts = contacts.filter((c) => c.crmPersonId == null);
      }

      sendJson(res, 200, { contacts: contacts as unknown as Record<string, unknown>[] } as Record<string, unknown>);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleApiContactDetail(res: ServerResponse, contactId: number): Promise<void> {
    if (!this._dbAvailable) {
      sendJson(res, 503, { error: "Conversation storage unavailable — database not configured or init failed" });
      return;
    }
    try {
      const { getContactDetail } = await import("./conversation-store.js");
      const contact = await getContactDetail(contactId);
      if (!contact) {
        sendJson(res, 404, { error: "Contact not found" });
        return;
      }
      sendJson(res, 200, contact as unknown as Record<string, unknown>);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleApiGroupInfo(
    req: IncomingMessage,
    res: ServerResponse,
    groupId: string,
  ): Promise<void> {
    try {
      const params = parseQuery(req.url ?? "");
      const account = normalizeAccountName(params.account ?? params.accountName);
      const resolved = this.resolveOutbound("whatsapp", account);
      if (!resolved.adapter?.getRawSocket) {
        sendJson(res, 400, { error: resolved.error ?? "WhatsApp adapter not available" });
        return;
      }

      const sock = resolved.adapter.getRawSocket() as Record<string, Function>;
      // Ensure group JID format
      const jid = groupId.includes("@") ? groupId : groupId + "@g.us";

      const metadata = await sock.groupMetadata(jid);
      sendJson(res, 200, {
        account: resolved.accountName,
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

  private resolveOutbound(
    platform: string,
    requestedAccount?: string,
  ): {
    adapter?: OutboundAdapter;
    accountName: string;
    error?: string;
  } {
    const normalizedPlatform = platform.trim().toLowerCase();
    const platformKeys = [...this.adapters.keys()].filter((key) =>
      key.startsWith(`${normalizedPlatform}:`),
    );
    if (platformKeys.length === 0) {
      return {
        accountName: requestedAccount ?? "default",
        error: `No adapter for platform: ${normalizedPlatform}.`,
      };
    }

    if (requestedAccount) {
      const exactKey = adapterKey(normalizedPlatform, requestedAccount);
      const adapter = this.adapters.get(exactKey);
      if (!adapter) {
        const available = platformKeys.map((key) => key.split(":")[1]).join(", ");
        return {
          accountName: requestedAccount,
          error: `Unknown ${normalizedPlatform} account "${requestedAccount}". Available: ${available}`,
        };
      }
      return { adapter, accountName: requestedAccount };
    }

    const defaultAdapter = this.adapters.get(adapterKey(normalizedPlatform, "default"));
    if (defaultAdapter) {
      return { adapter: defaultAdapter, accountName: "default" };
    }

    if (platformKeys.length === 1) {
      const key = platformKeys[0]!;
      return {
        adapter: this.adapters.get(key),
        accountName: key.split(":")[1] ?? "default",
      };
    }

    const available = platformKeys.map((key) => key.split(":")[1]).join(", ");
    return {
      accountName: "default",
      error:
        `Multiple ${normalizedPlatform} accounts are configured. ` +
        `Include "account" in the request body or query string. Available: ${available}`,
    };
  }
}

/** Parse query string from a URL into key-value pairs */
function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const qs = url.slice(idx + 1);
  const params: Record<string, string> = {};
  for (const pair of qs.split("&")) {
    const [key, val] = pair.split("=");
    if (key) params[decodeURIComponent(key)] = decodeURIComponent(val ?? "");
  }
  return params;
}

/** Clamp limit to 1-200 range, default 50 */
function clampLimit(raw?: string): number {
  const n = parseInt(raw ?? "50", 10);
  if (isNaN(n) || n < 1) return 50;
  return Math.min(n, 200);
}

function normalizeAccountName(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function adapterKey(platform: string, accountName: string): string {
  return `${platform}:${accountName}`;
}

function getOutboundLimiterTestOverrides() {
  if (process.env.NODE_ENV !== "test") return undefined;
  return {
    minDelayPerRecipientSec: 0,
    maxDelayPerRecipientSec: 0,
    minGlobalDelaySec: 0,
    maxGlobalDelaySec: 0,
    typingCps: 1_000_000,
    minTypingSec: 0,
    maxTypingSec: 0,
  };
}

function isPublicBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return !["127.0.0.1", "localhost", "::1"].includes(normalized);
}

/** Extract platform name from URL path /webhook/:platform */
function extractPlatform(url: string): string | null {
  const match = url.match(/^\/webhook\/([a-zA-Z0-9_-]+)/);
  return match?.[1]?.toLowerCase() ?? null;
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
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
      resolve(Buffer.concat(chunks));
    });

    req.on("error", (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return readRawBody(req).then((rawBody) => parseJsonBody(rawBody));
}

function parseJsonBody(rawBody: Buffer): unknown {
  if (rawBody.length === 0) {
    return {};
  }
  try {
    return JSON.parse(rawBody.toString("utf-8"));
  } catch {
    throw new Error("Invalid JSON");
  }
}

type WebhookVerificationResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

function verifyWhatsAppWebhook(
  req: IncomingMessage,
  rawBody: Buffer,
  appSecrets: string[],
): WebhookVerificationResult {
  if (appSecrets.length === 0) {
    return { ok: false, status: 503, error: "WhatsApp webhook app secret not configured" };
  }

  const signatureHeader = firstHeaderValue(req.headers["x-hub-signature-256"]);
  if (!signatureHeader?.startsWith("sha256=")) {
    return { ok: false, status: 401, error: "Missing WhatsApp webhook signature" };
  }

  const providedHex = signatureHeader.slice("sha256=".length);
  if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) {
    return { ok: false, status: 401, error: "Invalid WhatsApp webhook signature" };
  }

  const provided = Buffer.from(providedHex, "hex");
  for (const secret of appSecrets) {
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
    if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
      return { ok: true };
    }
  }

  return { ok: false, status: 401, error: "Invalid WhatsApp webhook signature" };
}

function verifyTelegramWebhook(
  req: IncomingMessage,
  secretTokens: string[],
): WebhookVerificationResult {
  if (secretTokens.length === 0) {
    return { ok: false, status: 503, error: "Telegram webhook secret_token not configured" };
  }

  const provided =
    firstHeaderValue(req.headers["x-telegram-bot-api-secret-token"]) ??
    parseQuery(req.url ?? "").secret_token;
  if (!provided) {
    return { ok: false, status: 401, error: "Missing Telegram webhook secret token" };
  }

  const providedBuffer = Buffer.from(provided);
  for (const secret of secretTokens) {
    const expectedBuffer = Buffer.from(secret);
    if (
      providedBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      return { ok: true };
    }
  }

  return { ok: false, status: 401, error: "Invalid Telegram webhook secret token" };
}

function verifyDiscordWebhook(
  req: IncomingMessage,
  rawBody: Buffer,
  publicKeys: string[],
): WebhookVerificationResult {
  if (publicKeys.length === 0) {
    return { ok: false, status: 503, error: "Discord webhook public key not configured" };
  }

  const signatureHex = firstHeaderValue(req.headers["x-signature-ed25519"]);
  const timestamp = firstHeaderValue(req.headers["x-signature-timestamp"]);
  if (!signatureHex || !timestamp) {
    return { ok: false, status: 401, error: "Missing Discord webhook signature" };
  }
  if (!/^[0-9a-fA-F]+$/.test(signatureHex) || signatureHex.length % 2 !== 0) {
    return { ok: false, status: 401, error: "Invalid Discord webhook signature" };
  }

  const signature = Buffer.from(signatureHex, "hex");
  const payload = Buffer.concat([Buffer.from(timestamp, "utf-8"), rawBody]);
  for (const publicKey of publicKeys) {
    try {
      const keyObject = createDiscordPublicKey(publicKey);
      if (crypto.verify(null, payload, keyObject, signature)) {
        return { ok: true };
      }
    } catch {
      // Ignore malformed keys so a valid fallback key can still verify the request.
    }
  }

  return { ok: false, status: 401, error: "Invalid Discord webhook signature" };
}

function createDiscordPublicKey(publicKey: string): crypto.KeyObject {
  if (publicKey.includes("BEGIN PUBLIC KEY")) {
    return crypto.createPublicKey(publicKey);
  }

  const rawKey = Buffer.from(publicKey.trim(), "hex");
  if (rawKey.length !== 32) {
    throw new Error("Discord public key must be a 32-byte Ed25519 key");
  }
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return crypto.createPublicKey({
    key: Buffer.concat([spkiPrefix, rawKey]),
    format: "der",
    type: "spki",
  });
}

function normalizeWebhookSignatures(
  config?: WebhookSignatureConfig,
): Required<WebhookSignatureConfig> {
  return {
    whatsappAppSecrets: normalizeStringArray(config?.whatsappAppSecrets),
    telegramSecretTokens: normalizeStringArray(config?.telegramSecretTokens),
    discordPublicKeys: normalizeStringArray(config?.discordPublicKeys),
  };
}

function normalizeStringArray(values?: string[]): string[] {
  if (!values) return [];
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) {
      unique.add(normalized);
    }
  }
  return [...unique];
}

function normalizeSha256Hex(value?: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function extractBearerToken(authorization?: string): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function firstHeaderValue(value?: string | string[]): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
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
