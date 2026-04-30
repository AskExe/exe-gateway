/**
 * Conversation Store — PostgreSQL storage for gateway messages, contacts, and threads.
 *
 * All tables use CREATE TABLE IF NOT EXISTS and ON CONFLICT upserts for idempotency.
 *
 * @module conversation-store
 */

import type pg from "pg";
import { getPool } from "./db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GatewayMessage {
  id: number;
  threadId: number;
  accountId: number;
  messageId: string;
  fromJid: string;
  fromMe: boolean;
  text: string | null;
  pushName: string | null;
  mediaType: string | null;
  mediaUrl: string | null;
  timestamp: string;
  isHistorical: boolean;
  rawPayload: unknown;
  createdAt: string;
}

export interface GatewayContact {
  id: number;
  platform: string;
  platformJid: string;
  phone: string | null;
  displayName: string | null;
  pushName: string | null;
  lid: string | null;
  crmPersonId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadWithContact {
  id: number;
  accountId: number;
  contactId: number;
  groupJid: string | null;
  groupName: string | null;
  lastMessage: string | null;
  messageCount: number;
  contactName: string | null;
  contactPhone: string | null;
  contactPlatformJid: string;
}

export interface StoreMessageParams {
  threadId: number;
  accountId: number;
  messageId: string;
  fromJid: string;
  fromMe?: boolean;
  text?: string | null;
  pushName?: string | null;
  mediaType?: string | null;
  mediaUrl?: string | null;
  timestamp: string;
  isHistorical?: boolean;
  rawPayload?: unknown;
}

// ---------------------------------------------------------------------------
// Schema initialization
// ---------------------------------------------------------------------------

export async function initConversationStore(pool?: pg.Pool): Promise<void> {
  const p = pool ?? getPool();

  await p.query(`
    CREATE TABLE IF NOT EXISTS gateway_accounts (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      account_name TEXT NOT NULL,
      platform_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(platform, account_name)
    );

    CREATE TABLE IF NOT EXISTS gateway_contacts (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      platform_jid TEXT NOT NULL,
      phone TEXT,
      display_name TEXT,
      push_name TEXT,
      lid TEXT,
      crm_person_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(platform, platform_jid)
    );

    CREATE TABLE IF NOT EXISTS gateway_threads (
      id SERIAL PRIMARY KEY,
      account_id INTEGER REFERENCES gateway_accounts(id),
      contact_id INTEGER REFERENCES gateway_contacts(id),
      group_jid TEXT,
      group_name TEXT,
      last_message TIMESTAMPTZ,
      message_count INTEGER DEFAULT 0,
      UNIQUE(account_id, contact_id, group_jid)
    );

    CREATE TABLE IF NOT EXISTS gateway_messages (
      id SERIAL PRIMARY KEY,
      thread_id INTEGER REFERENCES gateway_threads(id),
      account_id INTEGER REFERENCES gateway_accounts(id),
      message_id TEXT NOT NULL,
      from_jid TEXT NOT NULL,
      from_me BOOLEAN DEFAULT false,
      text TEXT,
      push_name TEXT,
      media_type TEXT,
      media_url TEXT,
      timestamp TIMESTAMPTZ NOT NULL,
      is_historical BOOLEAN DEFAULT false,
      raw_payload JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    -- Customer identity resolution (persisted across restarts)
    CREATE TABLE IF NOT EXISTS gateway_customers (
      id UUID PRIMARY KEY,
      name TEXT,
      assigned_employee TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      interaction_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS gateway_customer_identities (
      id SERIAL PRIMARY KEY,
      customer_id UUID NOT NULL REFERENCES gateway_customers(id),
      platform TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      UNIQUE(platform, sender_id)
    );

    -- Session persistence (conversation state across restarts)
    CREATE TABLE IF NOT EXISTS gateway_sessions (
      id UUID PRIMARY KEY,
      customer_id UUID REFERENCES gateway_customers(id),
      bot_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      messages JSONB NOT NULL DEFAULT '[]',
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      message_count INTEGER DEFAULT 0,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active'
    );

    -- Auto-reply state (persisted daily cap across restarts)
    CREATE TABLE IF NOT EXISTS gateway_auto_reply_state (
      id SERIAL PRIMARY KEY,
      sender_id TEXT NOT NULL,
      last_reply_at TIMESTAMPTZ NOT NULL,
      reply_date DATE NOT NULL DEFAULT CURRENT_DATE,
      UNIQUE(sender_id)
    );

    CREATE TABLE IF NOT EXISTS gateway_daily_caps (
      id SERIAL PRIMARY KEY,
      cap_date DATE NOT NULL DEFAULT CURRENT_DATE,
      auto_reply_count INTEGER DEFAULT 0,
      UNIQUE(cap_date)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_thread ON gateway_messages(thread_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_account ON gateway_messages(account_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_dedup ON gateway_messages(account_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON gateway_contacts(phone);
    CREATE INDEX IF NOT EXISTS idx_contacts_crm ON gateway_contacts(crm_person_id);
    CREATE INDEX IF NOT EXISTS idx_threads_account ON gateway_threads(account_id);
    CREATE INDEX IF NOT EXISTS idx_customer_identities_lookup ON gateway_customer_identities(platform, sender_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_customer ON gateway_sessions(customer_id, bot_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON gateway_sessions(status);
  `);
}

// ---------------------------------------------------------------------------
// Upserts
// ---------------------------------------------------------------------------

export async function upsertAccount(
  platform: string,
  accountName: string,
  platformId?: string,
  pool?: pg.Pool,
): Promise<number> {
  const p = pool ?? getPool();
  const result = await p.query(
    `INSERT INTO gateway_accounts (platform, account_name, platform_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (platform, account_name)
     DO UPDATE SET platform_id = COALESCE(EXCLUDED.platform_id, gateway_accounts.platform_id)
     RETURNING id`,
    [platform, accountName, platformId ?? null],
  );
  return result.rows[0].id;
}

export async function upsertContact(
  platform: string,
  platformJid: string,
  opts?: {
    phone?: string;
    displayName?: string;
    pushName?: string;
    lid?: string;
  },
  pool?: pg.Pool,
): Promise<number> {
  const p = pool ?? getPool();
  const result = await p.query(
    `INSERT INTO gateway_contacts (platform, platform_jid, phone, display_name, push_name, lid)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (platform, platform_jid)
     DO UPDATE SET
       phone = COALESCE(EXCLUDED.phone, gateway_contacts.phone),
       display_name = COALESCE(EXCLUDED.display_name, gateway_contacts.display_name),
       push_name = COALESCE(EXCLUDED.push_name, gateway_contacts.push_name),
       lid = COALESCE(EXCLUDED.lid, gateway_contacts.lid),
       updated_at = now()
     RETURNING id`,
    [
      platform,
      platformJid,
      opts?.phone ?? null,
      opts?.displayName ?? null,
      opts?.pushName ?? null,
      opts?.lid ?? null,
    ],
  );
  return result.rows[0].id;
}

export async function upsertThread(
  accountId: number,
  contactId: number,
  groupJid?: string,
  pool?: pg.Pool,
): Promise<number> {
  const p = pool ?? getPool();
  const gj = groupJid ?? null;

  // For DMs (group_jid IS NULL), PostgreSQL's UNIQUE constraint doesn't match
  // NULL != NULL, so we need to check explicitly first
  if (gj === null) {
    const existing = await p.query(
      `SELECT id FROM gateway_threads
       WHERE account_id = $1 AND contact_id = $2 AND group_jid IS NULL
       LIMIT 1`,
      [accountId, contactId],
    );
    if (existing.rows.length > 0) {
      // Update last_message + increment count
      await p.query(
        `UPDATE gateway_threads SET last_message = now(), message_count = message_count + 1
         WHERE id = $1`,
        [existing.rows[0].id],
      );
      return existing.rows[0].id;
    }
    // Create new DM thread
    const result = await p.query(
      `INSERT INTO gateway_threads (account_id, contact_id, group_jid, message_count, last_message)
       VALUES ($1, $2, NULL, 1, now())
       RETURNING id`,
      [accountId, contactId],
    );
    return result.rows[0].id;
  }

  // Group threads — ON CONFLICT works fine (group_jid is NOT NULL)
  const result = await p.query(
    `INSERT INTO gateway_threads (account_id, contact_id, group_jid, message_count, last_message)
     VALUES ($1, $2, $3, 1, now())
     ON CONFLICT (account_id, contact_id, group_jid)
     DO UPDATE SET last_message = now(), message_count = gateway_threads.message_count + 1
     RETURNING id`,
    [accountId, contactId, gj],
  );
  return result.rows[0].id;
}

// ---------------------------------------------------------------------------
// Message storage
// ---------------------------------------------------------------------------

export async function storeMessage(
  params: StoreMessageParams,
  pool?: pg.Pool,
): Promise<number> {
  const p = pool ?? getPool();

  // Deduplication: skip if this exact message was already stored for this account.
  // Baileys can emit the same message multiple times on reconnect.
  const existing = await p.query(
    `SELECT id FROM gateway_messages WHERE account_id = $1 AND message_id = $2 LIMIT 1`,
    [params.accountId, params.messageId],
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id; // Already stored — return existing ID
  }

  const result = await p.query(
    `INSERT INTO gateway_messages
       (thread_id, account_id, message_id, from_jid, from_me, text, push_name,
        media_type, media_url, timestamp, is_historical, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      params.threadId,
      params.accountId,
      params.messageId,
      params.fromJid,
      params.fromMe ?? false,
      params.text ?? null,
      params.pushName ?? null,
      params.mediaType ?? null,
      params.mediaUrl ?? null,
      params.timestamp,
      params.isHistorical ?? false,
      params.rawPayload ? JSON.stringify(params.rawPayload) : null,
    ],
  );

  // Update thread stats
  await p.query(
    `UPDATE gateway_threads
     SET last_message = $1, message_count = message_count + 1
     WHERE id = $2`,
    [params.timestamp, params.threadId],
  );

  return result.rows[0].id;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getThreadMessages(
  threadId: number,
  limit: number = 50,
  offset: number = 0,
  pool?: pg.Pool,
): Promise<GatewayMessage[]> {
  const p = pool ?? getPool();
  const result = await p.query(
    `SELECT id, thread_id, account_id, message_id, from_jid, from_me,
            text, push_name, media_type, media_url, timestamp,
            is_historical, raw_payload, created_at
     FROM gateway_messages
     WHERE thread_id = $1
     ORDER BY timestamp DESC
     LIMIT $2 OFFSET $3`,
    [threadId, limit, offset],
  );

  return result.rows.map(rowToMessage);
}

export async function getThreads(
  opts?: { accountId?: number; limit?: number; offset?: number },
  pool?: pg.Pool,
): Promise<ThreadWithContact[]> {
  const p = pool ?? getPool();
  const conditions: string[] = [];
  const args: unknown[] = [];
  let paramIdx = 1;

  if (opts?.accountId) {
    conditions.push(`t.account_id = $${paramIdx++}`);
    args.push(opts.accountId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  const result = await p.query(
    `SELECT t.id, t.account_id, t.contact_id, t.group_jid, t.group_name,
            t.last_message, t.message_count,
            c.display_name AS contact_name, c.phone AS contact_phone,
            c.platform_jid AS contact_platform_jid
     FROM gateway_threads t
     JOIN gateway_contacts c ON c.id = t.contact_id
     ${where}
     ORDER BY t.last_message DESC NULLS LAST
     LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
    [...args, limit, offset],
  );

  return result.rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    contactId: r.contact_id,
    groupJid: r.group_jid,
    groupName: r.group_name,
    lastMessage: r.last_message?.toISOString?.() ?? r.last_message,
    messageCount: r.message_count,
    contactName: r.contact_name,
    contactPhone: r.contact_phone,
    contactPlatformJid: r.contact_platform_jid,
  }));
}

export async function getContacts(
  opts?: { platform?: string; limit?: number; offset?: number },
  pool?: pg.Pool,
): Promise<GatewayContact[]> {
  const p = pool ?? getPool();
  const conditions: string[] = [];
  const args: unknown[] = [];
  let paramIdx = 1;

  if (opts?.platform) {
    conditions.push(`platform = $${paramIdx++}`);
    args.push(opts.platform);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts?.limit ?? 100;
  const offset = opts?.offset ?? 0;

  const result = await p.query(
    `SELECT id, platform, platform_jid, phone, display_name, push_name,
            lid, crm_person_id, created_at, updated_at
     FROM gateway_contacts
     ${where}
     ORDER BY updated_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
    [...args, limit, offset],
  );

  return result.rows.map(rowToContact);
}

export async function getContactDetail(
  contactId: number,
  pool?: pg.Pool,
): Promise<GatewayContact | null> {
  const p = pool ?? getPool();
  const result = await p.query(
    `SELECT id, platform, platform_jid, phone, display_name, push_name,
            lid, crm_person_id, created_at, updated_at
     FROM gateway_contacts WHERE id = $1`,
    [contactId],
  );

  if (result.rows.length === 0) return null;
  return rowToContact(result.rows[0]);
}

export async function linkContactToCRM(
  contactId: number,
  crmPersonId: string,
  pool?: pg.Pool,
): Promise<void> {
  const p = pool ?? getPool();
  await p.query(
    `UPDATE gateway_contacts SET crm_person_id = $1, updated_at = now() WHERE id = $2`,
    [crmPersonId, contactId],
  );
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToMessage(r: Record<string, unknown>): GatewayMessage {
  return {
    id: r.id as number,
    threadId: r.thread_id as number,
    accountId: r.account_id as number,
    messageId: r.message_id as string,
    fromJid: r.from_jid as string,
    fromMe: r.from_me as boolean,
    text: r.text as string | null,
    pushName: r.push_name as string | null,
    mediaType: r.media_type as string | null,
    mediaUrl: r.media_url as string | null,
    timestamp: typeof r.timestamp === "string" ? r.timestamp : (r.timestamp as Date)?.toISOString?.() ?? String(r.timestamp),
    isHistorical: r.is_historical as boolean,
    rawPayload: r.raw_payload,
    createdAt: typeof r.created_at === "string" ? r.created_at : (r.created_at as Date)?.toISOString?.() ?? String(r.created_at),
  };
}

function rowToContact(r: Record<string, unknown>): GatewayContact {
  return {
    id: r.id as number,
    platform: r.platform as string,
    platformJid: r.platform_jid as string,
    phone: r.phone as string | null,
    displayName: r.display_name as string | null,
    pushName: r.push_name as string | null,
    lid: r.lid as string | null,
    crmPersonId: r.crm_person_id as string | null,
    createdAt: typeof r.created_at === "string" ? r.created_at : (r.created_at as Date)?.toISOString?.() ?? String(r.created_at),
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : (r.updated_at as Date)?.toISOString?.() ?? String(r.updated_at),
  };
}
