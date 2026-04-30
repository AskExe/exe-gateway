/**
 * Gateway session persistence — conversation state across reconnects.
 *
 * Hybrid store: PostgreSQL for persistence, in-memory for fast access.
 * Sessions are loaded from DB on first access, flushed on every message.
 * Survives restarts — customers don't lose conversation context.
 *
 * Tables: gateway_sessions (created by initConversationStore).
 */

import { randomUUID } from "node:crypto";
import { hasPool, getPool } from "./db.js";
import type Anthropic from "@anthropic-ai/sdk";

/** Session status */
export type SessionStatus = "active" | "closed" | "summarized";

/** Conversation session */
export interface ConversationSession {
  sessionId: string;
  customerId: string;
  botId: string;
  platform: string;
  messages: Anthropic.MessageParam[];
  startedAt: string;
  lastMessageAt: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  status: SessionStatus;
}

export interface SessionStoreConfig {
  /** Idle timeout before session closes (default 30min) */
  idleTimeoutMs: number;
  /** Max messages before summarize + reset (default 100) */
  maxMessages: number;
}

const DEFAULT_CONFIG: SessionStoreConfig = {
  idleTimeoutMs: 30 * 60_000,
  maxMessages: 100,
};

/**
 * Hybrid session store — PostgreSQL backed with in-memory cache.
 * Falls back to pure in-memory when no DB is configured.
 */
export class SessionStore {
  private sessions = new Map<string, ConversationSession>();
  private config: SessionStoreConfig;
  private loadedFromDB = new Set<string>(); // Track which keys we've loaded

  constructor(config: Partial<SessionStoreConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get or create a session for a customer+bot pair.
   * Resumes if active session exists within idle timeout.
   * Creates new if no active session or session expired.
   */
  getOrCreate(
    customerId: string,
    botId: string,
    platform: string,
  ): ConversationSession {
    const key = this.sessionKey(customerId, botId);

    // If we haven't tried loading from DB for this key, do it async
    if (hasPool() && !this.loadedFromDB.has(key)) {
      this.loadedFromDB.add(key);
      this.loadFromDB(customerId, botId).catch((err) => {
        console.error("[session-store] DB load error:", err instanceof Error ? err.message : err);
      });
    }

    const existing = this.sessions.get(key);

    if (existing && existing.status === "active") {
      const idleMs = Date.now() - new Date(existing.lastMessageAt).getTime();
      if (idleMs < this.config.idleTimeoutMs) {
        return existing;
      }
      // Expired — close and create new
      existing.status = "closed";
      this.persistSession(existing);
    }

    const session: ConversationSession = {
      sessionId: randomUUID(),
      customerId,
      botId,
      platform,
      messages: [],
      startedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      messageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      status: "active",
    };
    this.sessions.set(key, session);
    this.persistSession(session);
    return session;
  }

  /**
   * Async version — loads from DB before creating.
   * Use this when you can afford to await (e.g., API endpoints).
   */
  async getOrCreateAsync(
    customerId: string,
    botId: string,
    platform: string,
  ): Promise<ConversationSession> {
    const key = this.sessionKey(customerId, botId);

    // Try loading from DB if not in memory
    if (hasPool() && !this.sessions.has(key)) {
      await this.loadFromDB(customerId, botId);
      this.loadedFromDB.add(key);
    }

    return this.getOrCreate(customerId, botId, platform);
  }

  /** Add a message to a session */
  addMessage(
    sessionId: string,
    message: Anthropic.MessageParam,
  ): void {
    const session = this.findById(sessionId);
    if (!session) return;

    session.messages.push(message);
    session.messageCount++;
    session.lastMessageAt = new Date().toISOString();

    // Check if we need to summarize (context window management)
    if (session.messageCount >= this.config.maxMessages) {
      this.markForSummary(session);
    }

    // Persist to DB (fire-and-forget)
    this.persistSession(session);
  }

  /** Record token usage for a session */
  recordTokens(
    sessionId: string,
    inputTokens: number,
    outputTokens: number,
  ): void {
    const session = this.findById(sessionId);
    if (!session) return;
    session.totalInputTokens += inputTokens;
    session.totalOutputTokens += outputTokens;
    this.persistSession(session);
  }

  /** Close a session */
  close(sessionId: string): void {
    const session = this.findById(sessionId);
    if (session) {
      session.status = "closed";
      this.persistSession(session);
    }
  }

  /** Get a session by ID */
  findById(sessionId: string): ConversationSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.sessionId === sessionId) return session;
    }
    return undefined;
  }

  /** Get active session for a customer+bot pair */
  getActive(
    customerId: string,
    botId: string,
  ): ConversationSession | undefined {
    const key = this.sessionKey(customerId, botId);
    const session = this.sessions.get(key);
    if (session?.status === "active") return session;
    return undefined;
  }

  /** Get all sessions (for analytics) */
  getAllSessions(): ConversationSession[] {
    return [...this.sessions.values()];
  }

  /** Clean up expired sessions */
  expireIdleSessions(): number {
    const now = Date.now();
    let expired = 0;
    for (const [, session] of this.sessions) {
      if (session.status !== "active") continue;
      const idleMs = now - new Date(session.lastMessageAt).getTime();
      if (idleMs >= this.config.idleTimeoutMs) {
        session.status = "closed";
        this.persistSession(session);
        expired++;
      }
    }
    return expired;
  }

  /** Get session stats */
  stats(): {
    active: number;
    closed: number;
    totalMessages: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  } {
    let active = 0;
    let closed = 0;
    let totalMessages = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (const s of this.sessions.values()) {
      if (s.status === "active") active++;
      else closed++;
      totalMessages += s.messageCount;
      totalInputTokens += s.totalInputTokens;
      totalOutputTokens += s.totalOutputTokens;
    }
    return { active, closed, totalMessages, totalInputTokens, totalOutputTokens };
  }

  // ---------- Private ----------

  private markForSummary(session: ConversationSession): void {
    // Keep the last 10 messages for continuity, mark rest as summarized
    if (session.messages.length > 10) {
      session.messages = session.messages.slice(-10);
    }
    session.status = "active"; // Still active, just trimmed
  }

  private sessionKey(customerId: string, botId: string): string {
    return `${customerId}:${botId}`;
  }

  /** Load an active session from DB into memory cache */
  private async loadFromDB(customerId: string, botId: string): Promise<void> {
    if (!hasPool()) return;

    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT id, customer_id, bot_id, platform, messages, started_at, last_message_at,
                message_count, total_input_tokens, total_output_tokens, status
         FROM gateway_sessions
         WHERE customer_id = $1 AND bot_id = $2 AND status = 'active'
         ORDER BY last_message_at DESC
         LIMIT 1`,
        [customerId, botId],
      );

      if (result.rows.length === 0) return;

      const row = result.rows[0];
      const session: ConversationSession = {
        sessionId: row.id,
        customerId: row.customer_id,
        botId: row.bot_id,
        platform: row.platform,
        messages: typeof row.messages === "string" ? JSON.parse(row.messages) : row.messages,
        startedAt: typeof row.started_at === "string" ? row.started_at : row.started_at?.toISOString?.() ?? String(row.started_at),
        lastMessageAt: typeof row.last_message_at === "string" ? row.last_message_at : row.last_message_at?.toISOString?.() ?? String(row.last_message_at),
        messageCount: row.message_count,
        totalInputTokens: row.total_input_tokens,
        totalOutputTokens: row.total_output_tokens,
        status: row.status,
      };

      // Check if expired
      const idleMs = Date.now() - new Date(session.lastMessageAt).getTime();
      if (idleMs >= this.config.idleTimeoutMs) {
        session.status = "closed";
        this.persistSession(session);
        return;
      }

      const key = this.sessionKey(customerId, botId);
      this.sessions.set(key, session);
    } catch (err) {
      console.error("[session-store] loadFromDB error:", err instanceof Error ? err.message : err);
    }
  }

  /** Persist session to DB (fire-and-forget) */
  private persistSession(session: ConversationSession): void {
    if (!hasPool()) return;

    const pool = getPool();
    pool.query(
      `INSERT INTO gateway_sessions (id, customer_id, bot_id, platform, messages, started_at, last_message_at,
                                     message_count, total_input_tokens, total_output_tokens, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         messages = EXCLUDED.messages,
         last_message_at = EXCLUDED.last_message_at,
         message_count = EXCLUDED.message_count,
         total_input_tokens = EXCLUDED.total_input_tokens,
         total_output_tokens = EXCLUDED.total_output_tokens,
         status = EXCLUDED.status`,
      [
        session.sessionId,
        session.customerId,
        session.botId,
        session.platform,
        JSON.stringify(session.messages),
        session.startedAt,
        session.lastMessageAt,
        session.messageCount,
        session.totalInputTokens,
        session.totalOutputTokens,
        session.status,
      ],
    ).catch((err) => {
      console.error("[session-store] persist error:", err instanceof Error ? err.message : err);
    });
  }
}
