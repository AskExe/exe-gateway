/**
 * Prisma-backed gateway database access.
 *
 * All database operations go through the exe-db Prisma client.
 * Gateway models (gateway.*) use typed Prisma operations.
 * Billing models (billing.*) use typed Prisma operations.
 * Auxiliary tables (analytics) use $queryRawUnsafe.
 *
 * @module db
 */

import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

type PrismaDelegate = {
  findFirst(args?: any): Promise<any>;
  findMany(args?: any): Promise<any[]>;
  findUnique(args?: any): Promise<any>;
  create(args: any): Promise<any>;
  update(args: any): Promise<any>;
  upsert(args: any): Promise<any>;
  delete?(args: any): Promise<any>;
  count?(args?: any): Promise<number>;
};

type PrismaRawExecutor = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $transaction?<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T>;
  $disconnect?(): Promise<void>;
};

export interface PrismaClient extends PrismaRawExecutor {
  // Gateway models
  gatewayAccount: PrismaDelegate;
  gatewayContact: PrismaDelegate;
  gatewayThread: PrismaDelegate;
  gatewayMessage: PrismaDelegate;
  gatewayCustomer: PrismaDelegate;
  gatewayCustomerIdentity: PrismaDelegate;
  gatewaySession: PrismaDelegate;
  // Billing models
  billingCustomer: PrismaDelegate;
  billingApiKey: PrismaDelegate;
  billingUsageLog: PrismaDelegate;
}

export interface DBConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

let prismaPromise: Promise<PrismaClient> | null = null;
let databaseUrl: string | null = null;
let initialized = false;

function buildDatabaseUrl(config: DBConfig): string {
  const user = encodeURIComponent(config.user);
  const password = encodeURIComponent(config.password);
  const host = config.host;
  const port = config.port;
  const database = encodeURIComponent(config.database);
  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

async function resolvePrismaClient(): Promise<PrismaClient> {
  if (!prismaPromise) {
    prismaPromise = (async () => {
      const explicitPath = process.env.EXE_DB_PRISMA_CLIENT_PATH ?? process.env.EXE_OS_PRISMA_CLIENT_PATH;
      const url = process.env.DATABASE_URL ?? databaseUrl;
      const candidates: Array<{ label: string; load: () => Promise<any> }> = [];

      if (explicitPath) {
        candidates.push({
          label: `explicit path ${explicitPath}`,
          load: () => import(pathToFileURL(explicitPath).href),
        });
      } else {
        candidates.push({
          label: "bundled exe-gateway Prisma client",
          load: async () => {
            const requireFromHere = createRequire(import.meta.url);
            const prismaEntry = requireFromHere.resolve("@prisma/client");
            return import(pathToFileURL(prismaEntry).href);
          },
        });

        const exeDbRoot = process.env.EXE_DB_ROOT ?? path.join(os.homedir(), "exe-db");
        candidates.push({
          label: `exe-db Prisma client at ${exeDbRoot}`,
          load: async () => {
            const requireFromExeDb = createRequire(path.join(exeDbRoot, "package.json"));
            const prismaEntry = requireFromExeDb.resolve("@prisma/client");
            return import(pathToFileURL(prismaEntry).href);
          },
        });
      }

      const errors: string[] = [];
      for (const candidate of candidates) {
        try {
          const module = await candidate.load();
          const PrismaClientClass = module.PrismaClient ?? module.default?.PrismaClient;
          if (!PrismaClientClass) {
            throw new Error("PrismaClient export not found");
          }
          return url
            ? new PrismaClientClass({ datasources: { db: { url } } })
            : new PrismaClientClass();
        } catch (err) {
          errors.push(`${candidate.label}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      throw new Error(
        "[db] Generated Prisma client not found. " +
          "Run npm install/build in exe-gateway so the bundled Prisma client is generated, " +
          "set EXE_DB_PRISMA_CLIENT_PATH to a generated client, or install the exe-db repo on this host. " +
          `Attempts: ${errors.join(" | ")}`,
      );
    })();
  }

  return prismaPromise;
}

/**
 * Initialize the database connection. Call once at startup.
 * Accepts a DBConfig (gateway.json) or reads DATABASE_URL from env.
 */
export function initDatabase(config?: DBConfig): void {
  if (config) {
    databaseUrl = buildDatabaseUrl(config);
  }
  initialized = true;
}

/** Check if the database has been initialized */
export function isInitialized(): boolean {
  return initialized || !!process.env.DATABASE_URL || !!databaseUrl;
}

/** Get the Prisma client. Throws if not initialized. */
export async function getPrisma(): Promise<PrismaClient> {
  if (!initialized && !process.env.DATABASE_URL && !databaseUrl) {
    throw new Error("[db] Database not initialized. Call initDatabase() first.");
  }
  return resolvePrismaClient();
}

/** Run a raw SQL query and return rows. */
export async function rawQuery<T = Record<string, any>>(
  sql: string,
  args: unknown[] = [],
): Promise<T[]> {
  const prisma = await getPrisma();
  return prisma.$queryRawUnsafe<T[]>(sql, ...args);
}

/** Run a raw SQL statement (INSERT/UPDATE/DELETE) and return affected row count. */
export async function rawExecute(
  sql: string,
  args: unknown[] = [],
): Promise<number> {
  const prisma = await getPrisma();
  return prisma.$executeRawUnsafe(sql, ...args);
}

/** Run multiple statements in a transaction. */
export async function withTransaction<T>(
  fn: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  const prisma = await getPrisma();
  if (!prisma.$transaction) {
    return fn(prisma);
  }
  return prisma.$transaction((tx) => fn(tx));
}

/** Disconnect the Prisma client. Call on graceful shutdown. */
export async function disconnect(): Promise<void> {
  if (!prismaPromise) return;
  const prisma = await prismaPromise;
  await prisma.$disconnect?.();
  prismaPromise = null;
  databaseUrl = null;
  initialized = false;
}

// ---------------------------------------------------------------------------
// Backward compatibility — deprecated, will be removed
// ---------------------------------------------------------------------------

export interface QueryResult<T = Record<string, any>> {
  rows: T[];
  rowCount: number;
}

export interface DbPool {
  query<T = Record<string, any>>(sql: string, args?: unknown[]): Promise<QueryResult<T>>;
  end(): Promise<void>;
}

/** @deprecated Use initDatabase() instead */
export function initPool(config: DBConfig): DbPool {
  initDatabase(config);
  return getPool();
}

/** @deprecated Use isInitialized() instead */
export function hasPool(): boolean {
  return isInitialized();
}

/** @deprecated Use getPrisma() + rawQuery() instead */
export function getPool(): DbPool {
  return {
    async query<T = Record<string, any>>(sql: string, args: unknown[] = []): Promise<QueryResult<T>> {
      const rows = await rawQuery<T>(sql, args);
      return { rows, rowCount: rows.length };
    },
    async end(): Promise<void> {
      await disconnect();
    },
  };
}

/** @deprecated Use disconnect() instead */
export async function closePool(): Promise<void> {
  await disconnect();
}
