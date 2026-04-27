/**
 * Shared PostgreSQL connection pool for the gateway.
 *
 * @module db
 */

import pg from "pg";

let pool: pg.Pool | null = null;

export interface DBConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function initPool(config: DBConfig): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool({
    ...config,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error("[db] Pool not initialized");
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
