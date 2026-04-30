/**
 * Gateway analytics — operational metrics for the founder.
 *
 * Tracks conversations, latency, costs, and escalation rates.
 * Hybrid: in-memory for fast access + PostgreSQL for persistence across restarts.
 * Falls back to pure in-memory when no DB is configured.
 */

import { hasPool, getPool } from "./db.js";

export interface AnalyticsEvent {
  timestamp: string;
  platform: string;
  botId: string;
  eventType: "conversation_start" | "message" | "response" | "escalation" | "error";
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  provider?: string;
  success: boolean;
}

export interface DailyStats {
  date: string;
  platform: string;
  botId: string;
  conversations: number;
  messages: number;
  avgLatencyMs: number;
  avgMessagesPerConversation: number;
  escalationCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  errorCount: number;
}

const RAW_EVENT_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days

/**
 * Initialize the analytics table in PostgreSQL.
 * Called from initConversationStore or standalone.
 */
export async function initAnalyticsStore(): Promise<void> {
  if (!hasPool()) return;
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gateway_analytics_events (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      platform TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      latency_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      provider TEXT,
      success BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS gateway_analytics_daily (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      platform TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      conversations INTEGER DEFAULT 0,
      messages INTEGER DEFAULT 0,
      avg_latency_ms REAL DEFAULT 0,
      avg_messages_per_conversation REAL DEFAULT 0,
      escalation_count INTEGER DEFAULT 0,
      total_input_tokens BIGINT DEFAULT 0,
      total_output_tokens BIGINT DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(date, platform, bot_id)
    );

    CREATE INDEX IF NOT EXISTS idx_analytics_events_ts ON gateway_analytics_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON gateway_analytics_events(event_type, platform);
    CREATE INDEX IF NOT EXISTS idx_analytics_daily_date ON gateway_analytics_daily(date);
  `);
}

export class AnalyticsCollector {
  private events: AnalyticsEvent[] = [];

  /** Record an analytics event */
  record(event: AnalyticsEvent): void {
    this.events.push(event);
    this.persistEvent(event);
  }

  /** Record a conversation start */
  conversationStarted(platform: string, botId: string): void {
    this.record({
      timestamp: new Date().toISOString(),
      platform,
      botId,
      eventType: "conversation_start",
      success: true,
    });
  }

  /** Record a message response */
  responseRecorded(
    platform: string,
    botId: string,
    latencyMs: number,
    inputTokens: number,
    outputTokens: number,
    provider: string,
    success: boolean,
  ): void {
    this.record({
      timestamp: new Date().toISOString(),
      platform,
      botId,
      eventType: "response",
      latencyMs,
      inputTokens,
      outputTokens,
      provider,
      success,
    });
  }

  /** Record an escalation to human */
  escalationRecorded(platform: string, botId: string): void {
    this.record({
      timestamp: new Date().toISOString(),
      platform,
      botId,
      eventType: "escalation",
      success: true,
    });
  }

  /** Get daily aggregated stats (in-memory for current session) */
  getDailyStats(date?: string): DailyStats[] {
    const targetDate = date ?? new Date().toISOString().split("T")[0]!;
    const dayEvents = this.events.filter(
      (e) => e.timestamp.startsWith(targetDate),
    );

    // Group by platform+botId
    const groups = new Map<string, AnalyticsEvent[]>();
    for (const event of dayEvents) {
      const key = `${event.platform}:${event.botId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(event);
    }

    const stats: DailyStats[] = [];
    for (const [key, events] of groups) {
      const [platform, botId] = key.split(":");
      const responses = events.filter((e) => e.eventType === "response");
      const successes = responses.filter((e) => e.success);
      const latencies = successes
        .map((e) => e.latencyMs ?? 0)
        .filter((l) => l > 0);
      const convStarts = events.filter(
        (e) => e.eventType === "conversation_start",
      ).length;
      const escalations = events.filter(
        (e) => e.eventType === "escalation",
      ).length;
      const errors = events.filter((e) => !e.success).length;

      stats.push({
        date: targetDate,
        platform: platform!,
        botId: botId!,
        conversations: convStarts,
        messages: responses.length,
        avgLatencyMs:
          latencies.length > 0
            ? latencies.reduce((a, b) => a + b, 0) / latencies.length
            : 0,
        avgMessagesPerConversation:
          convStarts > 0 ? responses.length / convStarts : 0,
        escalationCount: escalations,
        totalInputTokens: responses.reduce(
          (sum, e) => sum + (e.inputTokens ?? 0),
          0,
        ),
        totalOutputTokens: responses.reduce(
          (sum, e) => sum + (e.outputTokens ?? 0),
          0,
        ),
        errorCount: errors,
      });
    }

    return stats;
  }

  /**
   * Get daily stats from PostgreSQL — includes data from previous sessions.
   * Falls back to in-memory if no DB configured.
   */
  async getDailyStatsAsync(date?: string): Promise<DailyStats[]> {
    if (!hasPool()) return this.getDailyStats(date);

    const targetDate = date ?? new Date().toISOString().split("T")[0]!;
    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT date, platform, bot_id, conversations, messages,
                avg_latency_ms, avg_messages_per_conversation,
                escalation_count, total_input_tokens, total_output_tokens,
                error_count
         FROM gateway_analytics_daily
         WHERE date = $1
         ORDER BY platform, bot_id`,
        [targetDate],
      );

      if (result.rows.length > 0) {
        return result.rows.map(rowToDailyStats);
      }
    } catch (err) {
      console.error("[analytics] DB query error:", err instanceof Error ? err.message : err);
    }

    // Fall back to in-memory
    return this.getDailyStats(date);
  }

  /** Get summary across all bots for a date */
  getSummary(date?: string): {
    totalConversations: number;
    totalMessages: number;
    avgLatencyMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    escalationRate: number;
    errorRate: number;
  } {
    const daily = this.getDailyStats(date);
    if (daily.length === 0) {
      return {
        totalConversations: 0,
        totalMessages: 0,
        avgLatencyMs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        escalationRate: 0,
        errorRate: 0,
      };
    }

    const totalConversations = daily.reduce((s, d) => s + d.conversations, 0);
    const totalMessages = daily.reduce((s, d) => s + d.messages, 0);
    const totalEscalations = daily.reduce(
      (s, d) => s + d.escalationCount,
      0,
    );
    const totalErrors = daily.reduce((s, d) => s + d.errorCount, 0);
    const totalInputTokens = daily.reduce(
      (s, d) => s + d.totalInputTokens,
      0,
    );
    const totalOutputTokens = daily.reduce(
      (s, d) => s + d.totalOutputTokens,
      0,
    );

    // Weighted average latency
    const totalLatency = daily.reduce(
      (s, d) => s + d.avgLatencyMs * d.messages,
      0,
    );
    const avgLatencyMs = totalMessages > 0 ? totalLatency / totalMessages : 0;

    return {
      totalConversations,
      totalMessages,
      avgLatencyMs,
      totalInputTokens,
      totalOutputTokens,
      escalationRate:
        totalConversations > 0 ? totalEscalations / totalConversations : 0,
      errorRate:
        totalMessages > 0 ? totalErrors / totalMessages : 0,
    };
  }

  /** Prune events older than 30 days */
  prune(): number {
    const cutoff = Date.now() - RAW_EVENT_TTL_MS;
    const before = this.events.length;
    this.events = this.events.filter(
      (e) => new Date(e.timestamp).getTime() >= cutoff,
    );
    return before - this.events.length;
  }

  /**
   * Flush current in-memory daily stats to PostgreSQL.
   * Call periodically (e.g., every 5 minutes) or on graceful shutdown.
   */
  async flushDailyStats(): Promise<void> {
    if (!hasPool()) return;

    const today = new Date().toISOString().split("T")[0]!;
    const stats = this.getDailyStats(today);
    if (stats.length === 0) return;

    try {
      const pool = getPool();
      for (const s of stats) {
        await pool.query(
          `INSERT INTO gateway_analytics_daily
             (date, platform, bot_id, conversations, messages, avg_latency_ms,
              avg_messages_per_conversation, escalation_count,
              total_input_tokens, total_output_tokens, error_count, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
           ON CONFLICT (date, platform, bot_id)
           DO UPDATE SET
             conversations = EXCLUDED.conversations,
             messages = EXCLUDED.messages,
             avg_latency_ms = EXCLUDED.avg_latency_ms,
             avg_messages_per_conversation = EXCLUDED.avg_messages_per_conversation,
             escalation_count = EXCLUDED.escalation_count,
             total_input_tokens = EXCLUDED.total_input_tokens,
             total_output_tokens = EXCLUDED.total_output_tokens,
             error_count = EXCLUDED.error_count,
             updated_at = now()`,
          [
            s.date, s.platform, s.botId, s.conversations, s.messages,
            s.avgLatencyMs, s.avgMessagesPerConversation, s.escalationCount,
            s.totalInputTokens, s.totalOutputTokens, s.errorCount,
          ],
        );
      }
    } catch (err) {
      console.error("[analytics] Flush daily stats error:", err instanceof Error ? err.message : err);
    }
  }

  /** Get raw event count */
  eventCount(): number {
    return this.events.length;
  }

  /**
   * Persist a single event to PostgreSQL (fire-and-forget).
   */
  private persistEvent(event: AnalyticsEvent): void {
    if (!hasPool()) return;

    getPool()
      .query(
        `INSERT INTO gateway_analytics_events
           (timestamp, platform, bot_id, event_type, latency_ms,
            input_tokens, output_tokens, provider, success)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          event.timestamp,
          event.platform,
          event.botId,
          event.eventType,
          event.latencyMs ?? null,
          event.inputTokens ?? null,
          event.outputTokens ?? null,
          event.provider ?? null,
          event.success,
        ],
      )
      .catch((err) => {
        console.error("[analytics] DB persist error:", err instanceof Error ? err.message : err);
      });
  }
}

function rowToDailyStats(r: Record<string, unknown>): DailyStats {
  return {
    date: typeof r.date === "string" ? r.date : (r.date as Date)?.toISOString?.().split("T")[0] ?? String(r.date),
    platform: r.platform as string,
    botId: r.bot_id as string,
    conversations: r.conversations as number,
    messages: r.messages as number,
    avgLatencyMs: Number(r.avg_latency_ms) || 0,
    avgMessagesPerConversation: Number(r.avg_messages_per_conversation) || 0,
    escalationCount: r.escalation_count as number,
    totalInputTokens: Number(r.total_input_tokens) || 0,
    totalOutputTokens: Number(r.total_output_tokens) || 0,
    errorCount: r.error_count as number,
  };
}
