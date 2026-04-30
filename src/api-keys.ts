/**
 * API key management for the LLM proxy.
 *
 * Keys are prefixed with `exe_sk_` and stored as SHA-256 hashes in Postgres.
 * Validation is per-request with an in-memory cache (5 min TTL).
 *
 * Usage:
 *   const key = await createApiKey("hygo", "Hygo Co");
 *   // → "exe_sk_a1b2c3d4e5f6..."  (shown once, never stored in plaintext)
 *
 *   const customer = await validateApiKey("exe_sk_a1b2c3d4e5f6...");
 *   // → { id: "hygo", name: "Hygo Co", rateLimitRpm: 60 }
 */

import { createHash, randomBytes } from "node:crypto";
import { getPool } from "./db.js";

export interface CustomerInfo {
  id: string;
  name: string;
  rateLimitRpm: number;
}

/** In-memory cache: key_hash → customer info (5 min TTL) */
const cache = new Map<string, { customer: CustomerInfo; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60_000;

/** Hash an API key for storage/lookup */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Generate a new API key: exe_sk_<32 random hex chars> */
export function generateApiKey(): string {
  return `exe_sk_${randomBytes(16).toString("hex")}`;
}

/** Extract the display prefix (first 12 chars) */
export function keyPrefix(key: string): string {
  return key.slice(0, 12);
}

/**
 * Validate an API key and return customer info.
 * Returns null if key is invalid or revoked.
 */
export async function validateApiKey(key: string): Promise<CustomerInfo | null> {
  const hash = hashApiKey(key);

  // Check cache first
  const cached = cache.get(hash);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.customer;
  }

  const pool = getPool();
  const result = await pool.query(
    `SELECT customer_id, customer_name, rate_limit_rpm
     FROM llm_api_keys
     WHERE key_hash = $1 AND revoked_at IS NULL`,
    [hash],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const customer: CustomerInfo = {
    id: row.customer_id,
    name: row.customer_name,
    rateLimitRpm: row.rate_limit_rpm ?? 60,
  };

  // Update last_used_at (fire-and-forget)
  pool
    .query(`UPDATE llm_api_keys SET last_used_at = NOW() WHERE key_hash = $1`, [hash])
    .catch(() => {});

  // Cache it
  cache.set(hash, { customer, expiresAt: Date.now() + CACHE_TTL_MS });

  return customer;
}

/**
 * Create a new API key for a customer. Returns the raw key (shown once).
 */
export async function createApiKey(
  customerId: string,
  customerName: string,
  rateLimitRpm = 60,
): Promise<string> {
  const key = generateApiKey();
  const hash = hashApiKey(key);
  const prefix = keyPrefix(key);

  const pool = getPool();
  await pool.query(
    `INSERT INTO llm_api_keys (key_prefix, key_hash, customer_id, customer_name, rate_limit_rpm)
     VALUES ($1, $2, $3, $4, $5)`,
    [prefix, hash, customerId, customerName, rateLimitRpm],
  );

  return key;
}

/**
 * Revoke an API key by its prefix.
 */
export async function revokeApiKey(prefix: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE llm_api_keys SET revoked_at = NOW()
     WHERE key_prefix = $1 AND revoked_at IS NULL`,
    [prefix],
  );

  // Clear cache — key is revoked
  cache.clear();

  return (result.rowCount ?? 0) > 0;
}

/** List all active API keys (prefixes only — never expose full keys) */
export async function listApiKeys(): Promise<
  Array<{
    prefix: string;
    customerId: string;
    customerName: string;
    rateLimitRpm: number;
    createdAt: string;
    lastUsedAt: string | null;
  }>
> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT key_prefix, customer_id, customer_name, rate_limit_rpm, created_at, last_used_at
     FROM llm_api_keys
     WHERE revoked_at IS NULL
     ORDER BY created_at DESC`,
  );

  return result.rows.map((row) => ({
    prefix: row.key_prefix,
    customerId: row.customer_id,
    customerName: row.customer_name,
    rateLimitRpm: row.rate_limit_rpm,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

/** Initialize the llm_api_keys table */
export async function initApiKeysTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS llm_api_keys (
      id SERIAL PRIMARY KEY,
      key_prefix VARCHAR(12) NOT NULL,
      key_hash VARCHAR(64) NOT NULL UNIQUE,
      customer_id VARCHAR(64) NOT NULL,
      customer_name VARCHAR(255) NOT NULL,
      rate_limit_rpm INTEGER DEFAULT 60,
      created_at TIMESTAMP DEFAULT NOW(),
      revoked_at TIMESTAMP,
      last_used_at TIMESTAMP
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_llm_api_keys_hash ON llm_api_keys(key_hash)`,
  );
}
