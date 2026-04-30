/**
 * LLM usage metering — tracks tokens, cost, and margin per customer.
 *
 * Every proxy request is logged to Postgres for billing and analytics.
 * Cost is calculated from a model pricing table; margin is applied on top.
 *
 * Usage:
 *   await logUsage({ customerId: "hygo", model: "claude-sonnet-4-20250514", ... });
 *   const summary = await getUsageSummary("hygo", thirtyDaysAgo);
 */

import { getPool } from "./db.js";

/**
 * Per-million-token pricing (USD).
 * Source: https://docs.anthropic.com/en/docs/about-claude/pricing
 * Updated: 2026-04
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Claude 4 family
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  // Claude 3.5 family
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-20241022": { input: 1.0, output: 5.0 },
  // Claude 3 family
  "claude-3-opus-20240229": { input: 15.0, output: 75.0 },
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
};

/** Fallback pricing for unknown models (Sonnet-tier) */
const FALLBACK_PRICING = { input: 3.0, output: 15.0 };

export interface UsageEntry {
  customerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  provider: string;
  latencyMs: number;
  marginPercent: number;
}

export interface UsageSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalMarginUsd: number;
  totalChargeUsd: number;
  byModel: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    }
  >;
}

/** Calculate raw cost in USD for a given model and token count */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model] ?? FALLBACK_PRICING;
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

/** Log a usage entry to Postgres */
export async function logUsage(entry: UsageEntry): Promise<void> {
  const costUsd = calculateCost(
    entry.model,
    entry.inputTokens,
    entry.outputTokens,
  );
  const marginUsd = costUsd * (entry.marginPercent / 100);

  const pool = getPool();
  await pool.query(
    `INSERT INTO llm_usage_logs
     (customer_id, model, input_tokens, output_tokens, cost_usd, margin_usd, provider, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.customerId,
      entry.model,
      entry.inputTokens,
      entry.outputTokens,
      costUsd,
      marginUsd,
      entry.provider,
      entry.latencyMs,
    ],
  );
}

/** Get usage summary for a customer in a date range */
export async function getUsageSummary(
  customerId: string,
  since: Date,
  until: Date = new Date(),
): Promise<UsageSummary> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT model,
            COUNT(*)::int AS requests,
            SUM(input_tokens)::int AS input_tokens,
            SUM(output_tokens)::int AS output_tokens,
            SUM(cost_usd)::float AS cost_usd,
            SUM(margin_usd)::float AS margin_usd
     FROM llm_usage_logs
     WHERE customer_id = $1 AND created_at >= $2 AND created_at <= $3
     GROUP BY model`,
    [customerId, since, until],
  );

  let totalRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let totalMarginUsd = 0;
  const byModel: UsageSummary["byModel"] = {};

  for (const row of result.rows) {
    totalRequests += row.requests;
    totalInputTokens += row.input_tokens;
    totalOutputTokens += row.output_tokens;
    totalCostUsd += row.cost_usd;
    totalMarginUsd += row.margin_usd;
    byModel[row.model] = {
      requests: row.requests,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costUsd: row.cost_usd,
    };
  }

  return {
    totalRequests,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    totalMarginUsd,
    totalChargeUsd: totalCostUsd + totalMarginUsd,
    byModel,
  };
}

/** Get daily usage for a customer (for charts/dashboards) */
export async function getDailyUsage(
  customerId: string,
  days = 30,
): Promise<
  Array<{
    date: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    marginUsd: number;
  }>
> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT DATE(created_at) AS date,
            COUNT(*)::int AS requests,
            SUM(input_tokens)::int AS input_tokens,
            SUM(output_tokens)::int AS output_tokens,
            SUM(cost_usd)::float AS cost_usd,
            SUM(margin_usd)::float AS margin_usd
     FROM llm_usage_logs
     WHERE customer_id = $1 AND created_at >= NOW() - INTERVAL '${days} days'
     GROUP BY DATE(created_at)
     ORDER BY date DESC`,
    [customerId],
  );

  return result.rows.map((row) => ({
    date: row.date,
    requests: row.requests,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    marginUsd: row.margin_usd,
  }));
}

/** Initialize the llm_usage_logs table */
export async function initUsageTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS llm_usage_logs (
      id SERIAL PRIMARY KEY,
      customer_id VARCHAR(64) NOT NULL,
      model VARCHAR(64) NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd NUMERIC(10, 6) NOT NULL,
      margin_usd NUMERIC(10, 6) NOT NULL,
      provider VARCHAR(32) NOT NULL,
      latency_ms INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_llm_usage_customer ON llm_usage_logs(customer_id, created_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage_logs(created_at)`,
  );
}
