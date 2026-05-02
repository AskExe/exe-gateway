/**
 * Prisma-backed gateway database access.
 *
 * Core gateway data lives in exe-db's Prisma schema (`gateway.*` models).
 * Auxiliary gateway tables (analytics, API keys, usage logs, etc.) continue
 * to use raw SQL, but now run through Prisma instead of pg.Pool.
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
};

type PrismaRawExecutor = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $transaction?<T>(fn: (tx: PrismaGatewayClient) => Promise<T>): Promise<T>;
  $disconnect?(): Promise<void>;
};

export interface PrismaGatewayClient extends PrismaRawExecutor {
  gatewayAccount: PrismaDelegate;
  gatewayContact: PrismaDelegate;
  gatewayThread: PrismaDelegate;
  gatewayMessage: PrismaDelegate;
  gatewayCustomer: PrismaDelegate;
  gatewayCustomerIdentity: PrismaDelegate;
  gatewaySession: PrismaDelegate;
}

export interface DBConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface QueryResult<T = Record<string, any>> {
  rows: T[];
  rowCount: number;
}

export interface DbPool {
  query<T = Record<string, any>>(sql: string, args?: unknown[]): Promise<QueryResult<T>>;
  end(): Promise<void>;
}

let pool: DbPool | null = null;
let prismaPromise: Promise<PrismaGatewayClient> | null = null;
let databaseUrlOverride: string | null = null;

function buildDatabaseUrl(config: DBConfig): string {
  const user = encodeURIComponent(config.user);
  const password = encodeURIComponent(config.password);
  const host = config.host;
  const port = config.port;
  const database = encodeURIComponent(config.database);
  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

function isReadQuery(sql: string): boolean {
  const trimmed = sql.trimStart();
  return /^(SELECT|WITH|SHOW|EXPLAIN|VALUES)\b/iu.test(trimmed) || /\bRETURNING\b/iu.test(trimmed);
}

function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      current += ch;
      if (ch === "*" && next === "/") {
        current += next;
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (!inSingle && !inDouble && ch === "-" && next === "-") {
      current += ch + next;
      inLineComment = true;
      i += 1;
      continue;
    }

    if (!inSingle && !inDouble && ch === "/" && next === "*") {
      current += ch + next;
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (!inDouble && ch === "'" && sql[i - 1] !== "\\") {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (!inSingle && ch === "\"" && sql[i - 1] !== "\\") {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (!inSingle && !inDouble && ch === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
}

async function resolvePrismaClient(): Promise<PrismaGatewayClient> {
  if (!prismaPromise) {
    prismaPromise = (async () => {
      const explicitPath = process.env.EXE_DB_PRISMA_CLIENT_PATH ?? process.env.EXE_OS_PRISMA_CLIENT_PATH;
      let module: any;

      if (explicitPath) {
        module = await import(pathToFileURL(explicitPath).href);
      } else {
        const exeDbRoot = process.env.EXE_DB_ROOT ?? path.join(os.homedir(), "exe-db");
        try {
          const requireFromExeDb = createRequire(path.join(exeDbRoot, "package.json"));
          const prismaEntry = requireFromExeDb.resolve("@prisma/client");
          module = await import(pathToFileURL(prismaEntry).href);
        } catch {
          const requireFromHere = createRequire(import.meta.url);
          const prismaEntry = requireFromHere.resolve("@prisma/client");
          module = await import(pathToFileURL(prismaEntry).href);
        }
      }

      const PrismaClient = module.PrismaClient ?? module.default?.PrismaClient;
      if (!PrismaClient) {
        throw new Error("Unable to load PrismaClient for exe-gateway.");
      }

      const url = process.env.DATABASE_URL ?? databaseUrlOverride;
      return url
        ? new PrismaClient({ datasources: { db: { url } } })
        : new PrismaClient();
    })();
  }

  return prismaPromise;
}

async function runRaw<T = Record<string, any>>(
  executor: PrismaRawExecutor,
  sql: string,
  args: unknown[] = [],
): Promise<QueryResult<T>> {
  const statements = splitStatements(sql);
  if (statements.length > 1 && args.length > 0) {
    throw new Error("Multi-statement raw queries do not support bound parameters.");
  }

  let lastResult: QueryResult<T> = { rows: [], rowCount: 0 };
  for (const statement of statements) {
    if (isReadQuery(statement)) {
      const rows = await executor.$queryRawUnsafe<T[]>(statement, ...(statements.length > 1 ? [] : args));
      lastResult = { rows, rowCount: rows.length };
      continue;
    }

    const rowCount = await executor.$executeRawUnsafe(statement, ...(statements.length > 1 ? [] : args));
    lastResult = { rows: [], rowCount };
  }

  return lastResult;
}

function createPoolFacade(): DbPool {
  return {
    async query<T = Record<string, any>>(sql: string, args: unknown[] = []): Promise<QueryResult<T>> {
      const prisma = await resolvePrismaClient();
      return runRaw<T>(prisma, sql, args);
    },
    async end(): Promise<void> {
      const prisma = await resolvePrismaClient();
      await prisma.$disconnect?.();
      prismaPromise = null;
      pool = null;
      databaseUrlOverride = null;
    },
  };
}

export function initPool(config: DBConfig): DbPool {
  if (pool) return pool;
  databaseUrlOverride = buildDatabaseUrl(config);
  pool = createPoolFacade();
  return pool;
}

export function hasPool(): boolean {
  return pool !== null;
}

export function getPool(): DbPool {
  if (!pool) throw new Error("[db] Database client not initialized");
  return pool;
}

export async function getPrisma(): Promise<PrismaGatewayClient> {
  if (!pool && !process.env.DATABASE_URL && !databaseUrlOverride) {
    throw new Error("[db] Database client not initialized");
  }
  return resolvePrismaClient();
}

export async function withTransaction<T>(
  fn: (tx: PrismaGatewayClient) => Promise<T>,
): Promise<T> {
  const prisma = await getPrisma();
  if (!prisma.$transaction) {
    return fn(prisma);
  }
  return prisma.$transaction((tx) => fn(tx));
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
}
