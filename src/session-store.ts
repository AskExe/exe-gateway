/**
 * Gateway session persistence — conversation state across reconnects.
 *
 * Hybrid store: Prisma for persistence, in-memory for fast access.
 * Sessions are loaded from DB on first access, flushed on every message.
 */

import { randomUUID } from "node:crypto";
import { hasPool, getPrisma } from "./db.js";
import type Anthropic from "@anthropic-ai/sdk";

export type SessionStatus = "active" | "closed" | "summarized";

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
  idleTimeoutMs: number;
  maxMessages: number;
}

const DEFAULT_CONFIG: SessionStoreConfig = {
  idleTimeoutMs: 30 * 60_000,
  maxMessages: 100,
};

export class SessionStore {
  private sessions = new Map<string, ConversationSession>();
  private config: SessionStoreConfig;
  private loadedFromDB = new Set<string>();

  constructor(config: Partial<SessionStoreConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getOrCreate(customerId: string, botId: string, platform: string): ConversationSession {
    const key = this.sessionKey(customerId, botId);

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

  async getOrCreateAsync(customerId: string, botId: string, platform: string): Promise<ConversationSession> {
    const key = this.sessionKey(customerId, botId);
    if (hasPool() && !this.sessions.has(key)) {
      await this.loadFromDB(customerId, botId);
      this.loadedFromDB.add(key);
    }
    return this.getOrCreate(customerId, botId, platform);
  }

  addMessage(sessionId: string, message: Anthropic.MessageParam): void {
    const session = this.findById(sessionId);
    if (!session) return;

    session.messages.push(message);
    session.messageCount++;
    session.lastMessageAt = new Date().toISOString();

    if (session.messageCount >= this.config.maxMessages) {
      this.markForSummary(session);
    }

    this.persistSession(session);
  }

  recordTokens(sessionId: string, inputTokens: number, outputTokens: number): void {
    const session = this.findById(sessionId);
    if (!session) return;
    session.totalInputTokens += inputTokens;
    session.totalOutputTokens += outputTokens;
    this.persistSession(session);
  }

  close(sessionId: string): void {
    const session = this.findById(sessionId);
    if (session) {
      session.status = "closed";
      this.persistSession(session);
    }
  }

  findById(sessionId: string): ConversationSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.sessionId === sessionId) return session;
    }
    return undefined;
  }

  getActive(customerId: string, botId: string): ConversationSession | undefined {
    const key = this.sessionKey(customerId, botId);
    const session = this.sessions.get(key);
    if (session?.status === "active") return session;
    return undefined;
  }

  getAllSessions(): ConversationSession[] {
    return [...this.sessions.values()];
  }

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

  stats(): { active: number; closed: number; totalMessages: number; totalInputTokens: number; totalOutputTokens: number } {
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
    if (session.messages.length > 10) {
      session.messages = session.messages.slice(-10);
    }
    session.status = "active";
  }

  private sessionKey(customerId: string, botId: string): string {
    return `${customerId}:${botId}`;
  }

  private async loadFromDB(customerId: string, botId: string): Promise<void> {
    if (!hasPool()) return;

    try {
      const prisma = await getPrisma();
      const record = await prisma.gatewaySession.findFirst({
        where: {
          customerId,
          botId,
          status: "active",
        },
        orderBy: { lastMessageAt: "desc" },
      });

      if (!record) return;

      const session: ConversationSession = {
        sessionId: record.id,
        customerId: record.customerId,
        botId: record.botId,
        platform: record.platform,
        messages: Array.isArray(record.messages) ? record.messages as Anthropic.MessageParam[] : JSON.parse(String(record.messages ?? "[]")),
        startedAt: record.startedAt.toISOString(),
        lastMessageAt: record.lastMessageAt.toISOString(),
        messageCount: record.messageCount,
        totalInputTokens: record.totalInputTokens,
        totalOutputTokens: record.totalOutputTokens,
        status: record.status,
      };

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

  private persistSession(session: ConversationSession): void {
    if (!hasPool()) return;

    void getPrisma()
      .then((prisma) => prisma.gatewaySession.upsert({
        where: { id: session.sessionId },
        create: {
          id: session.sessionId,
          customerId: session.customerId,
          botId: session.botId,
          platform: session.platform,
          messages: session.messages as any,
          startedAt: new Date(session.startedAt),
          lastMessageAt: new Date(session.lastMessageAt),
          messageCount: session.messageCount,
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          status: session.status,
        },
        update: {
          customerId: session.customerId,
          botId: session.botId,
          platform: session.platform,
          messages: session.messages as any,
          lastMessageAt: new Date(session.lastMessageAt),
          messageCount: session.messageCount,
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          status: session.status,
        },
      }))
      .catch((err) => {
        console.error("[session-store] persist error:", err instanceof Error ? err.message : err);
      });
  }
}
