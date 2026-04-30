import { describe, it, expect, beforeEach } from "vitest";
import {
  loadAccounts,
  getAccountByName,
  getDefaultAccount,
  _resetCache,
} from "../src/whatsapp-accounts.js";

const ACCOUNTS = [
  {
    name: "lenny",
    authDir: "/tmp/.auth/whatsapp-lenny",
    defaultAgent: "receptionist",
  },
  {
    name: "noah",
    authDir: "/tmp/.auth/whatsapp-noah",
  },
];

describe("whatsapp-accounts", () => {
  beforeEach(() => {
    _resetCache();
  });

  describe("loadAccounts", () => {
    it("loads multi-account config", () => {
      const result = loadAccounts({ enabled: true, accounts: ACCOUNTS });
      expect(result).toHaveLength(2);
      expect(result[0]!.name).toBe("lenny");
      expect(result[1]!.name).toBe("noah");
    });

    it("returns empty array when no config provided", () => {
      const result = loadAccounts();
      expect(result).toEqual([]);
    });

    it("returns single default account for legacy enabled-only config", () => {
      const result = loadAccounts({ enabled: true });
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("default");
    });

    it("returns empty array when disabled", () => {
      const result = loadAccounts({ enabled: false });
      expect(result).toEqual([]);
    });

    it("caches after first load", () => {
      const result1 = loadAccounts({ enabled: true, accounts: ACCOUNTS });
      const result2 = loadAccounts({ enabled: true, accounts: [{ name: "different" }] });
      // Should return cached result, ignoring new config
      expect(result1).toBe(result2);
      expect(result2).toHaveLength(2);
    });

    it("fills in default authDir when not specified", () => {
      const result = loadAccounts({ enabled: true, accounts: [{ name: "sales" }] });
      expect(result[0]!.authDir).toContain("whatsapp-sales");
    });
  });

  describe("getAccountByName", () => {
    it("returns account when found", () => {
      loadAccounts({ enabled: true, accounts: ACCOUNTS });
      const account = getAccountByName("noah");
      expect(account).toBeDefined();
      expect(account!.name).toBe("noah");
    });

    it("returns undefined when not found", () => {
      loadAccounts({ enabled: true, accounts: ACCOUNTS });
      expect(getAccountByName("nonexistent")).toBeUndefined();
    });
  });

  describe("getDefaultAccount", () => {
    it("returns first account", () => {
      loadAccounts({ enabled: true, accounts: ACCOUNTS });
      const account = getDefaultAccount();
      expect(account).toBeDefined();
      expect(account!.name).toBe("lenny");
    });

    it("returns undefined when no accounts", () => {
      loadAccounts();
      expect(getDefaultAccount()).toBeUndefined();
    });
  });
});
