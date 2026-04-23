/**
 * WhatsApp multi-account config store.
 *
 * Loads accounts from ~/.exe-os/whatsapp-accounts.json.
 * Each account has its own credentials and optional default agent routing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface WhatsAppAccount {
  name: string;
  phoneNumberId: string;
  accessToken: string;
  businessAccountId: string;
  verifyToken: string;
  defaultAgent?: string;
}

const CONFIG_PATH = join(homedir(), ".exe-os", "whatsapp-accounts.json");

let cachedAccounts: WhatsAppAccount[] | null = null;

/**
 * Load accounts from config file. Caches after first load.
 * Returns empty array if file is missing or malformed.
 */
export function loadAccounts(): WhatsAppAccount[] {
  if (cachedAccounts !== null) return cachedAccounts;

  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn("[whatsapp] Config is not an array, ignoring");
      cachedAccounts = [];
      return cachedAccounts;
    }
    cachedAccounts = parsed as WhatsAppAccount[];
    return cachedAccounts;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[whatsapp] Failed to load accounts config:", (err as Error).message);
    }
    cachedAccounts = [];
    return cachedAccounts;
  }
}

export function getAccountByName(name: string): WhatsAppAccount | undefined {
  return loadAccounts().find((a) => a.name === name);
}

export function getAccountByPhoneNumberId(phoneNumberId: string): WhatsAppAccount | undefined {
  return loadAccounts().find((a) => a.phoneNumberId === phoneNumberId);
}

export function getDefaultAccount(): WhatsAppAccount | undefined {
  const accounts = loadAccounts();
  return accounts[0];
}

/**
 * Reset the cached accounts. Useful for testing.
 */
export function _resetCache(): void {
  cachedAccounts = null;
}
