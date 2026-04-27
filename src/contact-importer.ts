/**
 * Contact Importer — parses phone numbers from JIDs and auto-imports
 * contacts into PostgreSQL, with optional CRM linking.
 *
 * WhatsApp names are SOURCE OF TRUTH — CRM enriches, doesn't replace.
 *
 * @module contact-importer
 */

import type { NormalizedMessage } from "./types.js";
import { getPool } from "./db.js";
import { upsertContact, linkContactToCRM } from "./conversation-store.js";

// ---------------------------------------------------------------------------
// Phone parsing
// ---------------------------------------------------------------------------

/**
 * Parse a phone number from a WhatsApp JID.
 *
 * "5511999990000@s.whatsapp.net" → "+5511999990000"
 * "5511999990000:42@s.whatsapp.net" → "+5511999990000" (strip device suffix)
 * "120363123456789@g.us" → null (group JID)
 * Non-WhatsApp senderId → returns as-is if it looks like a phone, null otherwise
 */
export function parsePhoneFromJid(jid: string): string | null {
  // Group JIDs — no phone
  if (jid.includes("@g.us") || jid.includes("@broadcast")) {
    return null;
  }

  // Strip WhatsApp domain
  let num = jid.replace(/@s\.whatsapp\.net$/, "").replace(/@.*$/, "");

  // Strip device suffix (:42, :0, etc.)
  num = num.replace(/:\d+$/, "");

  // Must be digits only at this point to be a valid phone
  if (!/^\d{7,15}$/.test(num)) {
    return null;
  }

  return `+${num}`;
}

// ---------------------------------------------------------------------------
// Contact import
// ---------------------------------------------------------------------------

/**
 * Import a contact from an inbound message.
 * Parses the phone from the senderId (JID), upserts into gateway_contacts.
 * Returns the contact ID, or null if phone couldn't be parsed.
 */
export async function importContactFromMessage(
  msg: NormalizedMessage,
): Promise<number | null> {
  const phone = msg.senderPhone ?? parsePhoneFromJid(msg.senderId);

  const pool = getPool();
  const contactId = await upsertContact(
    msg.platform,
    msg.senderId,
    {
      phone: phone ?? undefined,
      displayName: msg.senderName,
      pushName: msg.senderName,
    },
    pool,
  );

  return contactId;
}

/**
 * Bulk import contacts in a single transaction.
 * Returns the number of contacts upserted.
 */
export async function bulkImportContacts(
  platform: string,
  contacts: Array<{
    platformJid: string;
    phone?: string;
    displayName?: string;
    pushName?: string;
  }>,
): Promise<number> {
  if (contacts.length === 0) return 0;

  const pool = getPool();
  const client = await pool.connect();
  let count = 0;

  try {
    await client.query("BEGIN");

    for (const c of contacts) {
      const phone = c.phone ?? parsePhoneFromJid(c.platformJid);
      await client.query(
        `INSERT INTO gateway_contacts (platform, platform_jid, phone, display_name, push_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (platform, platform_jid)
         DO UPDATE SET
           phone = COALESCE(EXCLUDED.phone, gateway_contacts.phone),
           display_name = COALESCE(EXCLUDED.display_name, gateway_contacts.display_name),
           push_name = COALESCE(EXCLUDED.push_name, gateway_contacts.push_name),
           updated_at = now()`,
        [platform, c.platformJid, phone, c.displayName ?? null, c.pushName ?? null],
      );
      count++;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return count;
}

// ---------------------------------------------------------------------------
// CRM linking
// ---------------------------------------------------------------------------

/**
 * Try to link a gateway contact to an existing CRM person.
 * Fails silently — CRM linking is best-effort.
 */
export async function tryCRMLink(
  contactId: number,
  phone: string,
): Promise<boolean> {
  try {
    const { findPersonByContact, isCRMBridgeEnabled } = await import("./crm-bridge.js");

    if (!isCRMBridgeEnabled()) return false;

    // findPersonByContact takes (platform, senderId) — use phone as senderId
    const personId = await findPersonByContact("whatsapp", phone);
    if (!personId) return false;

    const pool = getPool();
    await linkContactToCRM(contactId, personId, pool);
    return true;
  } catch {
    // CRM linking is best-effort — never fail
    return false;
  }
}
