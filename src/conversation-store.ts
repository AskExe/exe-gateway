/**
 * Conversation Store — Prisma storage for gateway messages, contacts, and threads.
 *
 * Core gateway tables come from exe-db's `gateway.*` Prisma schema.
 * Gateway-only helper tables (auto reply state, daily caps) still use raw SQL
 * through the shared Prisma-backed db facade.
 *
 * @module conversation-store
 */

import { getPool, getPrisma, type PrismaGatewayClient } from "./db.js";

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

export async function initConversationStore(_db?: PrismaGatewayClient): Promise<void> {
  const pool = getPool();

  await pool.query(`
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
  `);
}

// ---------------------------------------------------------------------------
// Upserts
// ---------------------------------------------------------------------------

async function prismaClient(db?: PrismaGatewayClient): Promise<PrismaGatewayClient> {
  return db ?? getPrisma();
}

export async function upsertAccount(
  platform: string,
  accountName: string,
  platformId?: string,
  db?: PrismaGatewayClient,
): Promise<number> {
  const prisma = await prismaClient(db);
  const account = await prisma.gatewayAccount.upsert({
    where: {
      platform_accountName: {
        platform,
        accountName,
      },
    },
    create: {
      platform,
      accountName,
      platformId: platformId ?? null,
    },
    update: platformId ? { platformId } : {},
  });
  return account.id;
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
  db?: PrismaGatewayClient,
): Promise<number> {
  const prisma = await prismaClient(db);
  const now = new Date();
  const contact = await prisma.gatewayContact.upsert({
    where: {
      platform_platformJid: {
        platform,
        platformJid,
      },
    },
    create: {
      platform,
      platformJid,
      phone: opts?.phone ?? null,
      displayName: opts?.displayName ?? null,
      pushName: opts?.pushName ?? null,
    },
    update: {
      ...(opts?.phone !== undefined ? { phone: opts.phone } : {}),
      ...(opts?.displayName !== undefined ? { displayName: opts.displayName } : {}),
      ...(opts?.pushName !== undefined ? { pushName: opts.pushName } : {}),
      updatedAt: now,
    },
  });
  return contact.id;
}

export async function upsertThread(
  accountId: number,
  contactId: number,
  groupJid?: string,
  db?: PrismaGatewayClient,
): Promise<number> {
  const prisma = await prismaClient(db);
  const normalizedGroupJid = groupJid ?? null;
  const existing = await prisma.gatewayThread.findFirst({
    where: {
      accountId,
      contactId,
      groupJid: normalizedGroupJid,
    },
    select: { id: true },
  });

  if (existing) {
    await prisma.gatewayThread.update({
      where: { id: existing.id },
      data: {
        lastMessage: new Date(),
        messageCount: { increment: 1 },
      },
    });
    return existing.id;
  }

  const created = await prisma.gatewayThread.create({
    data: {
      accountId,
      contactId,
      groupJid: normalizedGroupJid,
      messageCount: 1,
      lastMessage: new Date(),
    },
    select: { id: true },
  });

  return created.id;
}

// ---------------------------------------------------------------------------
// Message storage
// ---------------------------------------------------------------------------

export async function storeMessage(
  params: StoreMessageParams,
  db?: PrismaGatewayClient,
): Promise<number> {
  const prisma = await prismaClient(db);

  const existing = await prisma.gatewayMessage.findFirst({
    where: {
      accountId: params.accountId,
      messageId: params.messageId,
    },
    select: { id: true },
  });
  if (existing) {
    return existing.id;
  }

  const created = await prisma.gatewayMessage.create({
    data: {
      threadId: params.threadId,
      accountId: params.accountId,
      messageId: params.messageId,
      fromJid: params.fromJid,
      fromMe: params.fromMe ?? false,
      text: params.text ?? null,
      mediaType: params.mediaType ?? null,
      mediaUrl: params.mediaUrl ?? null,
      timestamp: new Date(params.timestamp),
      isHistorical: params.isHistorical ?? false,
      ...(params.rawPayload !== undefined ? { rawPayload: params.rawPayload as any } : {}),
    },
    select: { id: true },
  });

  await prisma.gatewayThread.update({
    where: { id: params.threadId },
    data: {
      lastMessage: new Date(params.timestamp),
      messageCount: { increment: 1 },
    },
  });

  return created.id;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getThreadMessages(
  threadId: number,
  limit: number = 50,
  offset: number = 0,
  db?: PrismaGatewayClient,
): Promise<GatewayMessage[]> {
  const prisma = await prismaClient(db);
  const messages = await prisma.gatewayMessage.findMany({
    where: { threadId },
    orderBy: { timestamp: "desc" },
    take: limit,
    skip: offset,
  });

  return messages.map((message) => ({
    id: message.id,
    threadId: message.threadId,
    accountId: message.accountId,
    messageId: message.messageId,
    fromJid: message.fromJid,
    fromMe: message.fromMe,
    text: message.text ?? null,
    pushName: null,
    mediaType: message.mediaType ?? null,
    mediaUrl: message.mediaUrl ?? null,
    timestamp: message.timestamp.toISOString(),
    isHistorical: message.isHistorical,
    rawPayload: message.rawPayload ?? null,
    createdAt: message.createdAt.toISOString(),
  }));
}

export async function getThreads(
  opts?: { accountId?: number; limit?: number; offset?: number },
  db?: PrismaGatewayClient,
): Promise<ThreadWithContact[]> {
  const prisma = await prismaClient(db);
  const threads = await prisma.gatewayThread.findMany({
    where: opts?.accountId ? { accountId: opts.accountId } : undefined,
    include: { contact: true },
    orderBy: { lastMessage: "desc" as const },
    take: opts?.limit ?? 50,
    skip: opts?.offset ?? 0,
  });

  const sorted = [...threads].sort((a, b) => {
    if (a.lastMessage && b.lastMessage) return b.lastMessage.getTime() - a.lastMessage.getTime();
    if (a.lastMessage) return -1;
    if (b.lastMessage) return 1;
    return b.id - a.id;
  });

  return sorted.map((thread) => ({
    id: thread.id,
    accountId: thread.accountId,
    contactId: thread.contactId,
    groupJid: thread.groupJid ?? null,
    groupName: thread.groupName ?? null,
    lastMessage: thread.lastMessage?.toISOString() ?? null,
    messageCount: thread.messageCount,
    contactName: thread.contact?.displayName ?? null,
    contactPhone: thread.contact?.phone ?? null,
    contactPlatformJid: thread.contact.platformJid,
  }));
}

export async function getContacts(
  opts?: { platform?: string; limit?: number; offset?: number },
  db?: PrismaGatewayClient,
): Promise<GatewayContact[]> {
  const prisma = await prismaClient(db);
  const contacts = await prisma.gatewayContact.findMany({
    where: opts?.platform ? { platform: opts.platform } : undefined,
    orderBy: { updatedAt: "desc" },
    take: opts?.limit ?? 100,
    skip: opts?.offset ?? 0,
  });

  return contacts.map(mapContact);
}

export async function getContactDetail(
  contactId: number,
  db?: PrismaGatewayClient,
): Promise<GatewayContact | null> {
  const prisma = await prismaClient(db);
  const contact = await prisma.gatewayContact.findUnique({
    where: { id: contactId },
  });

  return contact ? mapContact(contact) : null;
}

export async function linkContactToCRM(
  contactId: number,
  crmPersonId: string,
  db?: PrismaGatewayClient,
): Promise<void> {
  const prisma = await prismaClient(db);
  await prisma.gatewayContact.update({
    where: { id: contactId },
    data: {
      crmPersonId,
      updatedAt: new Date(),
    },
  });
}

function mapContact(contact: any): GatewayContact {
  return {
    id: contact.id,
    platform: contact.platform,
    platformJid: contact.platformJid,
    phone: contact.phone ?? null,
    displayName: contact.displayName ?? null,
    pushName: contact.pushName ?? null,
    lid: null,
    crmPersonId: contact.crmPersonId ?? null,
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
  };
}
