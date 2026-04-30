/**
 * Pipeline Store — bridges NormalizedMessage to the PostgreSQL conversation store.
 *
 * Handles the upsert chain: account → contact → thread → message.
 *
 * @module pipeline-store
 */

import type { NormalizedMessage } from "./types.js";
import { getPool } from "./db.js";
import {
  upsertAccount,
  upsertContact,
  upsertThread,
  storeMessage,
} from "./conversation-store.js";
import { importContactFromMessage, tryCRMLink, parsePhoneFromJid } from "./contact-importer.js";

// Storage filter — set via setStorageFilter() at boot from gateway.json config
let _storageFilter: StorageFilter | null = null;

export interface StorageFilter {
  /** Only store messages from these group JIDs. Empty = no group filter. */
  allowGroups?: string[];
  /** Only store messages from these contact JIDs. Empty = no contact filter. */
  allowContacts?: string[];
  /** If true, only allowlisted sources are stored. If false/unset, everything is stored. */
  enabled: boolean;
}

export function setStorageFilter(filter: StorageFilter): void {
  _storageFilter = filter;
  console.log(`[pipeline-store] Storage filter active: ${JSON.stringify(filter)}`);
}

function shouldStore(msg: NormalizedMessage): boolean {
  if (!_storageFilter?.enabled) return true; // No filter = store everything

  const groupJid = msg.chatType === "group" ? msg.channelId : null;

  // If allowGroups is set, only store matching groups
  if (_storageFilter.allowGroups?.length) {
    if (groupJid && _storageFilter.allowGroups.includes(groupJid)) return true;
  }

  // If allowContacts is set, only store matching DM contacts
  if (_storageFilter.allowContacts?.length) {
    if (!groupJid && _storageFilter.allowContacts.includes(msg.senderId)) return true;
  }

  // If both lists exist and nothing matched, don't store
  return false;
}

/**
 * Store an inbound message (before agent response).
 * Creates/updates account, contact, and thread as needed.
 */
export async function storeInboundMessage(msg: NormalizedMessage): Promise<number> {
  // Apply storage filter (for selective import — e.g., only specific groups)
  if (!shouldStore(msg)) {
    return -1; // Filtered out
  }

  const pool = getPool();

  const accountId = await upsertAccount(
    msg.platform,
    msg.accountId ?? `${msg.platform}-default`,
    undefined,
    pool,
  );

  const contactId = await upsertContact(
    msg.platform,
    msg.senderId,
    {
      phone: msg.senderPhone,
      displayName: msg.senderName,
      pushName: msg.senderName,
    },
    pool,
  );

  const groupJid = msg.chatType === "group" ? msg.channelId : undefined;
  const threadId = await upsertThread(accountId, contactId, groupJid, pool);

  const messageId = await storeMessage(
    {
      threadId,
      accountId,
      messageId: msg.messageId,
      fromJid: msg.senderId,
      fromMe: false,
      text: msg.text ?? null,
      pushName: msg.senderName ?? null,
      mediaType: msg.media?.[0]?.type ?? null,
      mediaUrl: msg.media?.[0]?.url ?? msg.media?.[0]?.localPath ?? null,
      timestamp: msg.timestamp,
      isHistorical: msg.isHistorical ?? false,
      rawPayload: msg.raw,
    },
    pool,
  );

  // Auto-import contact + try CRM linking (fire-and-forget, but log errors)
  importContactFromMessage(msg)
    .then((cId) => {
      if (cId) {
        const phone = msg.senderPhone ?? parsePhoneFromJid(msg.senderId);
        if (phone) {
          tryCRMLink(cId, phone).catch((err) => {
            console.error("[pipeline-store] CRM link failed:", err instanceof Error ? err.message : err);
          });
        }
      }
    })
    .catch((err) => {
      console.error("[pipeline-store] Contact import failed:", err instanceof Error ? err.message : err);
    });

  return messageId;
}

/**
 * Store a full conversation turn (inbound + agent response).
 * Stores two messages: the inbound and the agent reply.
 */
export async function storeConversation(
  msg: NormalizedMessage,
  response: string,
  botId: string,
): Promise<{ inboundId: number; responseId: number }> {
  const pool = getPool();

  const accountId = await upsertAccount(
    msg.platform,
    msg.accountId ?? `${msg.platform}-default`,
    undefined,
    pool,
  );

  const contactId = await upsertContact(
    msg.platform,
    msg.senderId,
    {
      phone: msg.senderPhone,
      displayName: msg.senderName,
      pushName: msg.senderName,
    },
    pool,
  );

  const groupJid = msg.chatType === "group" ? msg.channelId : undefined;
  const threadId = await upsertThread(accountId, contactId, groupJid, pool);

  const inboundId = await storeMessage(
    {
      threadId,
      accountId,
      messageId: msg.messageId,
      fromJid: msg.senderId,
      fromMe: false,
      text: msg.text ?? null,
      pushName: msg.senderName ?? null,
      mediaType: msg.media?.[0]?.type ?? null,
      mediaUrl: msg.media?.[0]?.url ?? msg.media?.[0]?.localPath ?? null,
      timestamp: msg.timestamp,
      isHistorical: msg.isHistorical ?? false,
      rawPayload: msg.raw,
    },
    pool,
  );

  const responseId = await storeMessage(
    {
      threadId,
      accountId,
      messageId: `${msg.messageId}-response`,
      fromJid: botId,
      fromMe: true,
      text: response,
      pushName: botId,
      timestamp: new Date().toISOString(),
    },
    pool,
  );

  return { inboundId, responseId };
}
