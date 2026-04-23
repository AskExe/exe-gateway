/**
 * Contact Sync — auto-create CRM Person records from inbound messages.
 *
 * Fails silently — contact sync should never block message delivery.
 */

import type { GatewayPlatform } from "./types.js";
import { findPersonByContact, createPerson } from "./crm-bridge.js";

interface ContactInfo {
  platform: GatewayPlatform;
  senderId: string;
  senderName?: string;
  accountId?: string;
}

/**
 * Ensure a CRM Person record exists for this contact.
 * Creates one if not found. Returns the person ID or null on failure.
 */
export async function ensureCRMContact(info: ContactInfo): Promise<string | null> {
  try {
    const existing = await findPersonByContact(info.platform, info.senderId);
    if (existing) return existing;

    const name = info.senderName || `Unknown (${info.senderId})`;
    const personId = await createPerson(info.platform, info.senderId, name);
    return personId;
  } catch {
    return null;
  }
}
