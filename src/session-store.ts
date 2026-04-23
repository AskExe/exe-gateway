/**
 * Gateway session persistence — conversation state across reconnects.
 *
 * Stores conversation history in SQLCipher (encrypted at rest).
 * Manages session lifecycle: create, resume, expire, summarize.
 */

import { randomUUID } from "node:crypto";
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
 * In-memory session store.
 * Production: back with SQLCipher gateway_sessions table.
 * Phase 3 ships with in-memory; DB persistence is a follow-up.
 */
export class SessionStore {
  private sessions = new Map<string, ConversationSession>();
  private config: SessionStoreConfig;

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
    const existing = this.sessions.get(key);

    if (existing && existing.status === "active") {
      const idleMs = Date.now() - new Date(existing.lastMessageAt).getTime();
      if (idleMs < this.config.idleTimeoutMs) {
        return existing;
      }
      // Expired — close and create new
      existing.status = "closed";
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
    return session;
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
  }

  /** Close a session */
  close(sessionId: string): void {
    const session = this.findById(sessionId);
    if (session) {
      session.status = "closed";
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
}
