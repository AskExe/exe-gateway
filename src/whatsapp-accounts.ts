/**
 * WhatsApp multi-account config store (Baileys — no Business API).
 *
 * Reads accounts from gateway.json `adapters.whatsapp.accounts[]`.
 * Supports legacy single-account format (`adapters.whatsapp.enabled: true`).
 */

import { getDefaultWhatsAppAuthDir } from "./config.js";

export interface WhatsAppAccountConfig {
  /** Human-readable name for this account */
  name: string;
  /** Auth state directory for Baileys (default: ~/.exe-os/.auth/whatsapp-{name}) */
  authDir?: string;
  /** Optional: route messages from this account to a specific bot */
  defaultAgent?: string;
}

let cachedAccounts: WhatsAppAccountConfig[] | null = null;

/**
 * Load accounts from a gateway config object. Caches after first load.
 * Accepts either:
 * - New format: `{ accounts: [{ name, authDir }] }`
 * - Legacy format: `{ enabled: true }` (single account, name="default")
 */
export function loadAccounts(
  whatsappConfig?: { enabled?: boolean; accounts?: WhatsAppAccountConfig[] },
): WhatsAppAccountConfig[] {
  if (cachedAccounts !== null) return cachedAccounts;

  if (!whatsappConfig) {
    cachedAccounts = [];
    return cachedAccounts;
  }

  if (whatsappConfig.accounts && whatsappConfig.accounts.length > 0) {
    // New multi-account format — fill in default authDirs
    cachedAccounts = whatsappConfig.accounts.map((a) => ({
      ...a,
      authDir: a.authDir ?? getDefaultWhatsAppAuthDir(a.name),
    }));
  } else if (whatsappConfig.enabled) {
    // Legacy single-account format
    cachedAccounts = [
      {
        name: "default",
        authDir: getDefaultWhatsAppAuthDir("default"),
      },
    ];
  } else {
    cachedAccounts = [];
  }

  return cachedAccounts;
}

export function getAccountByName(name: string): WhatsAppAccountConfig | undefined {
  return (cachedAccounts ?? []).find((a) => a.name === name);
}

export function getDefaultAccount(): WhatsAppAccountConfig | undefined {
  return (cachedAccounts ?? [])[0];
}

/**
 * Reset the cached accounts. Useful for testing.
 */
export function _resetCache(): void {
  cachedAccounts = null;
}
