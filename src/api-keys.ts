/**
 * API key management for the LLM proxy.
 *
 * Keys are prefixed with `exe_sk_` and stored as SHA-256 hashes.
 * Validation is per-request with an in-memory cache (5 min TTL).
 * Storage uses exe-db's billing schema via Prisma.
 */

import { createHash, randomBytes } from "node:crypto";
import { getPrisma } from "./db.js";

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

  const prisma = await getPrisma();
  const apiKey = await prisma.billingApiKey.findFirst({
    where: { keyHash: hash, revokedAt: null },
    include: { customer: true },
  } as any);

  if (!apiKey) return null;

  const customer: CustomerInfo = {
    id: apiKey.customer.authUserId,
    name: apiKey.customer.name,
    rateLimitRpm: apiKey.rateLimitRpm ?? 60,
  };

  // Update last_used_at (fire-and-forget)
  prisma.billingApiKey
    .update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {});

  // Cache it
  cache.set(hash, { customer, expiresAt: Date.now() + CACHE_TTL_MS });

  return customer;
}

/**
 * Create a new API key for a customer. Returns the raw key (shown once).
 * Auto-provisions a BillingCustomer if one doesn't exist for this authUserId.
 */
export async function createApiKey(
  customerId: string,
  customerName: string,
  rateLimitRpm = 60,
): Promise<string> {
  const key = generateApiKey();
  const hash = hashApiKey(key);
  const prefix = keyPrefix(key);

  const prisma = await getPrisma();

  // Ensure customer exists
  const customer = await prisma.billingCustomer.upsert({
    where: { authUserId: customerId } as any,
    create: {
      authUserId: customerId,
      name: customerName,
      email: "",
    },
    update: {},
  } as any);

  await prisma.billingApiKey.create({
    data: {
      keyPrefix: prefix,
      keyHash: hash,
      customerId: customer.id,
      rateLimitRpm,
    },
  });

  return key;
}

/**
 * Revoke an API key by its prefix.
 */
export async function revokeApiKey(prefix: string): Promise<boolean> {
  const prisma = await getPrisma();

  const apiKey = await prisma.billingApiKey.findFirst({
    where: { keyPrefix: prefix, revokedAt: null },
  } as any);

  if (!apiKey) {
    cache.clear();
    return false;
  }

  await prisma.billingApiKey.update({
    where: { id: apiKey.id },
    data: { revokedAt: new Date() },
  });

  cache.clear();
  return true;
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
  const prisma = await getPrisma();
  const keys = await prisma.billingApiKey.findMany({
    where: { revokedAt: null },
    include: { customer: true },
    orderBy: { createdAt: "desc" },
  } as any);

  return keys.map((key: any) => ({
    prefix: key.keyPrefix,
    customerId: key.customer.authUserId,
    customerName: key.customer.name,
    rateLimitRpm: key.rateLimitRpm,
    createdAt: key.createdAt instanceof Date ? key.createdAt.toISOString() : String(key.createdAt),
    lastUsedAt: key.lastUsedAt
      ? key.lastUsedAt instanceof Date ? key.lastUsedAt.toISOString() : String(key.lastUsedAt)
      : null,
  }));
}

/** @deprecated Tables are managed by exe-db Prisma migrations. No-op. */
export async function initApiKeysTable(): Promise<void> {
  // No-op — schema managed by exe-db migrations
}
