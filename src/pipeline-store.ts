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

/**
 * Store an inbound message (before agent response).
 * Creates/updates account, contact, and thread as needed.
 */
export async function storeInboundMessage(msg: NormalizedMessage): Promise<number> {
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

  // Auto-import contact + try CRM linking (fire-and-forget)
  importContactFromMessage(msg)
    .then((cId) => {
      if (cId) {
        const phone = msg.senderPhone ?? parsePhoneFromJid(msg.senderId);
        if (phone) {
          tryCRMLink(cId, phone).catch(() => {});
        }
      }
    })
    .catch(() => {});

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
