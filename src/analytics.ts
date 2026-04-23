/**
 * Gateway analytics — operational metrics for the founder.
 *
 * Tracks conversations, latency, costs, and escalation rates.
 * In-memory aggregation; production: persist to SQLCipher gateway_analytics table.
 */

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

export class AnalyticsCollector {
  private events: AnalyticsEvent[] = [];

  /** Record an analytics event */
  record(event: AnalyticsEvent): void {
    this.events.push(event);
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

  /** Get daily aggregated stats */
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

  /** Get raw event count */
  eventCount(): number {
    return this.events.length;
  }
}
