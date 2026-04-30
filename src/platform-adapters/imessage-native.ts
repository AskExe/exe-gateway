/**
 * iMessage adapter using native macOS integration.
 *
 * Uses AppleScript for sending and watches the Messages SQLite database
 * for incoming messages. macOS-only — requires Full Disk Access permission.
 *
 * Note: iMessage is macOS-only. This adapter returns "down" on non-macOS systems.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { GatewayAdapter, InboundMessage, OutboundMessage, OutboundResult, PlatformAccount } from "../gateway-adapter-types.js";

const execFileAsync = promisify(execFile);
const CHAT_DB = join(homedir(), "Library/Messages/chat.db");
const IS_MACOS = platform() === "darwin";

export interface IMessageConfig {
  accountId?: string;
  /** Poll interval in ms for checking new messages (default: 3000) */
  pollIntervalMs?: number;
}

export class IMessageNativeAdapter implements GatewayAdapter {
  readonly platform = "imessage" as const;
  public _config: IMessageConfig;
  public _isMonitoring = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastRowId = 0;

  constructor(config: IMessageConfig) {
    this._config = config;
  }

  async listAccounts(): Promise<PlatformAccount[]> {
    if (!IS_MACOS) return [];
    if (!existsSync(CHAT_DB)) return [];

    return [
      {
        id: this._config.accountId || "default",
        platform: "imessage",
        name: "iMessage (macOS)",
        isConfigured: true,
        lastActivity: Date.now(),
      },
    ];
  }

  async getAccount(accountId: string): Promise<PlatformAccount> {
    const accounts = await this.listAccounts();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    return account;
  }

  async sendMessage(message: OutboundMessage): Promise<OutboundResult> {
    const startTime = Date.now();

    if (!IS_MACOS) {
      return {
        messageId: "",
        platform: "imessage",
        timestamp: startTime,
        success: false,
        error: "iMessage is only available on macOS",
      };
    }

    try {
      const text = (message.content.text || "").replace(/"/g, '\\"');
      const to = message.to;

      // Use AppleScript to send via Messages app
      const script = `
        tell application "Messages"
          set targetService to 1st account whose service type = iMessage
          set targetBuddy to participant "${to}" of targetService
          send "${text}" to targetBuddy
        end tell
      `;

      await execFileAsync("osascript", ["-e", script], { timeout: 10_000 });

      return {
        messageId: `imsg_${Date.now()}`,
        platform: "imessage",
        timestamp: startTime,
        success: true,
      };
    } catch (err) {
      return {
        messageId: "",
        platform: "imessage",
        timestamp: Date.now(),
        success: false,
        error: String(err),
      };
    }
  }

  async startMonitor(
    onMessage: (msg: InboundMessage) => Promise<void>,
    _options?: { accountId?: string; debounceMs?: number },
  ): Promise<() => Promise<void>> {
    if (this._isMonitoring) throw new Error("Monitor already running");
    if (!IS_MACOS || !existsSync(CHAT_DB)) {
      throw new Error("iMessage monitoring requires macOS with Full Disk Access");
    }

    this._isMonitoring = true;

    // Get current max ROWID to only process new messages
    try {
      const { stdout } = await execFileAsync("sqlite3", [
        CHAT_DB,
        "SELECT MAX(ROWID) FROM message;",
      ]);
      this.lastRowId = parseInt(stdout.trim(), 10) || 0;
    } catch {
      this.lastRowId = 0;
    }

    const pollMs = this._config.pollIntervalMs ?? 3000;

    this.pollTimer = setInterval(async () => {
      try {
        // Query new messages since lastRowId
        const { stdout } = await execFileAsync("sqlite3", [
          CHAT_DB,
          "-json",
          `SELECT
            m.ROWID, m.text, m.is_from_me, m.date,
            h.id AS handle_id, h.service,
            c.chat_identifier
          FROM message m
          LEFT JOIN handle h ON m.handle_id = h.ROWID
          LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
          LEFT JOIN chat c ON c.ROWID = cmj.chat_id
          WHERE m.ROWID > ${this.lastRowId} AND m.is_from_me = 0
          ORDER BY m.ROWID ASC
          LIMIT 50;`,
        ]);

        if (!stdout.trim()) return;
        const rows = JSON.parse(stdout) as any[];

        for (const row of rows) {
          this.lastRowId = Math.max(this.lastRowId, row.ROWID);

          if (!row.text) continue;

          const chatType = row.chat_identifier?.includes(";+;") ? "group" : "direct";

          const inbound: InboundMessage = {
            id: String(row.ROWID),
            platform: "imessage",
            from: row.handle_id || "unknown",
            to: "me",
            content: { text: row.text },
            // iMessage dates are seconds since 2001-01-01
            timestamp: (row.date / 1_000_000_000 + 978307200) * 1000,
            chatType,
          };

          await onMessage(inbound).catch((err) => {
            console.error("[imessage] Message handler error:", err);
          });
        }
      } catch (err) {
        // sqlite3 command may fail if DB is locked — retry next interval
        console.error("[imessage] Poll error:", err instanceof Error ? err.message : err);
      }
    }, pollMs);

    return async () => {
      this._isMonitoring = false;
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    };
  }

  async isReady(): Promise<boolean> {
    return IS_MACOS && existsSync(CHAT_DB);
  }

  async healthCheck(): Promise<{ status: "ok" | "degraded" | "down"; message?: string }> {
    if (!IS_MACOS) return { status: "down", message: "Not macOS" };
    if (!existsSync(CHAT_DB)) return { status: "down", message: "Messages database not found (Full Disk Access required)" };
    return { status: "ok" };
  }
}
