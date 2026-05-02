/**
 * LLM usage metering — tracks tokens, cost, and margin per customer.
 *
 * Every proxy request is logged via exe-db's billing schema (Prisma).
 * Cost is calculated from a model pricing table; margin is applied on top.
 */

import { getPrisma } from "./db.js";

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

/**
 * Resolve the BillingCustomer UUID from an authUserId.
 * Returns null if customer not found.
 */
async function resolveCustomerUuid(authUserId: string): Promise<string | null> {
  const prisma = await getPrisma();
  const customer = await prisma.billingCustomer.findFirst({
    where: { authUserId } as any,
    select: { id: true },
  } as any);
  return customer?.id ?? null;
}

/** Log a usage entry via Prisma */
export async function logUsage(entry: UsageEntry): Promise<void> {
  const costUsd = calculateCost(entry.model, entry.inputTokens, entry.outputTokens);
  const marginUsd = costUsd * (entry.marginPercent / 100);

  const customerUuid = await resolveCustomerUuid(entry.customerId);
  if (!customerUuid) {
    console.warn(`[metering] Customer not found: ${entry.customerId}`);
    return;
  }

  const prisma = await getPrisma();
  await prisma.billingUsageLog.create({
    data: {
      customerId: customerUuid,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costUsd,
      marginUsd,
      provider: entry.provider,
      latencyMs: entry.latencyMs,
    },
  });
}

/** Get usage summary for a customer in a date range */
export async function getUsageSummary(
  customerId: string,
  since: Date,
  until: Date = new Date(),
): Promise<UsageSummary> {
  const customerUuid = await resolveCustomerUuid(customerId);
  if (!customerUuid) {
    return {
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      totalMarginUsd: 0,
      totalChargeUsd: 0,
      byModel: {},
    };
  }

  const prisma = await getPrisma();
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      model: string;
      requests: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      margin_usd: number;
    }>
  >(
    `SELECT model,
            COUNT(*)::int AS requests,
            SUM(input_tokens)::int AS input_tokens,
            SUM(output_tokens)::int AS output_tokens,
            SUM(cost_usd)::float AS cost_usd,
            SUM(margin_usd)::float AS margin_usd
     FROM billing.usage_logs
     WHERE customer_id = $1 AND created_at >= $2 AND created_at <= $3
     GROUP BY model`,
    customerUuid,
    since,
    until,
  );

  let totalRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let totalMarginUsd = 0;
  const byModel: UsageSummary["byModel"] = {};

  for (const row of rows) {
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
  const customerUuid = await resolveCustomerUuid(customerId);
  if (!customerUuid) return [];

  const prisma = await getPrisma();
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      date: Date | string;
      requests: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      margin_usd: number;
    }>
  >(
    `SELECT DATE(created_at) AS date,
            COUNT(*)::int AS requests,
            SUM(input_tokens)::int AS input_tokens,
            SUM(output_tokens)::int AS output_tokens,
            SUM(cost_usd)::float AS cost_usd,
            SUM(margin_usd)::float AS margin_usd
     FROM billing.usage_logs
     WHERE customer_id = $1 AND created_at >= NOW() - INTERVAL '${days} days'
     GROUP BY DATE(created_at)
     ORDER BY date DESC`,
    customerUuid,
  );

  return rows.map((row) => ({
    date: typeof row.date === "string" ? row.date : (row.date as Date)?.toISOString?.().split("T")[0] ?? String(row.date),
    requests: row.requests,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    marginUsd: row.margin_usd,
  }));
}

/** @deprecated Tables are managed by exe-db Prisma migrations. No-op. */
export async function initUsageTable(): Promise<void> {
  // No-op — schema managed by exe-db migrations
}
