import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadAccounts,
  getAccountByName,
  getAccountByPhoneNumberId,
  getDefaultAccount,
  _resetCache,
} from "../src/whatsapp-accounts.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from "node:fs";

const mockReadFileSync = vi.mocked(readFileSync);

const ACCOUNTS = [
  {
    name: "lenny",
    phoneNumberId: "PHONE_LENNY",
    accessToken: "TOKEN_LENNY",
    businessAccountId: "BIZ_LENNY",
    verifyToken: "VERIFY_LENNY",
    defaultAgent: "receptionist",
  },
  {
    name: "noah",
    phoneNumberId: "PHONE_NOAH",
    accessToken: "TOKEN_NOAH",
    businessAccountId: "BIZ_NOAH",
    verifyToken: "VERIFY_NOAH",
  },
];

describe("whatsapp-accounts", () => {
  beforeEach(() => {
    _resetCache();
    mockReadFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("loadAccounts", () => {
    it("loads valid JSON file", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify(ACCOUNTS));
      const result = loadAccounts();
      expect(result).toHaveLength(2);
      expect(result[0]!.name).toBe("lenny");
      expect(result[1]!.name).toBe("noah");
    });

    it("returns empty array for missing file", () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      mockReadFileSync.mockImplementation(() => { throw err; });
      const result = loadAccounts();
      expect(result).toEqual([]);
    });

    it("returns empty array for non-array JSON", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ not: "an array" }));
      const result = loadAccounts();
      expect(result).toEqual([]);
    });

    it("caches after first load", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify(ACCOUNTS));
      loadAccounts();
      loadAccounts();
      expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    });

    it("logs warning for non-ENOENT errors", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockReadFileSync.mockImplementation(() => { throw new Error("permission denied"); });
      const result = loadAccounts();
      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load"),
        expect.stringContaining("permission denied"),
      );
    });
  });

  describe("getAccountByName", () => {
    it("returns account when found", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify(ACCOUNTS));
      const account = getAccountByName("noah");
      expect(account).toBeDefined();
      expect(account!.phoneNumberId).toBe("PHONE_NOAH");
    });

    it("returns undefined when not found", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify(ACCOUNTS));
      expect(getAccountByName("nonexistent")).toBeUndefined();
    });
  });

  describe("getAccountByPhoneNumberId", () => {
    it("returns account when found", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify(ACCOUNTS));
      const account = getAccountByPhoneNumberId("PHONE_LENNY");
      expect(account).toBeDefined();
      expect(account!.name).toBe("lenny");
    });

    it("returns undefined when not found", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify(ACCOUNTS));
      expect(getAccountByPhoneNumberId("PHONE_UNKNOWN")).toBeUndefined();
    });
  });

  describe("getDefaultAccount", () => {
    it("returns first account", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify(ACCOUNTS));
      const account = getDefaultAccount();
      expect(account).toBeDefined();
      expect(account!.name).toBe("lenny");
    });

    it("returns undefined when no accounts", () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      mockReadFileSync.mockImplementation(() => { throw err; });
      expect(getDefaultAccount()).toBeUndefined();
    });
  });
});
