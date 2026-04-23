/**
 * iMessage gateway adapter — macOS only.
 *
 * Requires: macOS with Messages.app, Full Disk Access for reading chat.db.
 * On non-macOS platforms, connect() throws immediately (platform guard at line 38).
 * This adapter is automatically skipped by the gateway on Linux/Windows.
 *
 * Sends messages via osascript → Messages.app.
 * Receives messages by polling the Messages SQLite database.
 *
 * Reference: ~/openclaw/extensions/imessage/
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import type {
  NormalizedMessage,
  PlatformAdapter,
  PlatformConfig,
  SendOptions,
} from "../types.js";

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 5_000;
const MESSAGES_DB_PATH = path.join(
  process.env.HOME ?? os.homedir(),
  "Library/Messages/chat.db",
);

export class IMessageAdapter implements PlatformAdapter {
  readonly platform = "imessage" as const;

  private messageHandler: ((msg: NormalizedMessage) => Promise<void>) | null = null;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageRowId = 0;

  async connect(_config: PlatformConfig): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("iMessage adapter is macOS only");
    }

    // Test AppleScript access
    try {
      await execFileAsync("osascript", [
        "-e",
        'tell application "Messages" to get name',
      ]);
    } catch (err) {
      throw new Error(
        `iMessage: cannot access Messages.app — grant Full Disk Access. ${err instanceof Error ? err.message : ""}`,
      );
    }

    // Get latest message row ID to avoid processing history
    try {
      const { createClient } = await import("@libsql/client");
      const db = createClient({ url: `file:${MESSAGES_DB_PATH}` });
      const result = await db.execute("SELECT MAX(ROWID) as max_id FROM message");
      this.lastMessageRowId = Number(result.rows[0]?.max_id) || 0;
      db.close();
    } catch {
      // If we can't read the DB, start from 0
    }

    this.connected = true;
    console.log("[imessage] Connected via AppleScript bridge");

    // Start polling for new messages
    this.pollTimer = setInterval(() => {
      void this.pollMessages();
    }, POLL_INTERVAL_MS);
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
  }

  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async sendText(
    channelId: string,
    text: string,
    _options?: SendOptions,
  ): Promise<void> {
    if (!this.connected) throw new Error("iMessage not connected");

    const escapedText = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const escapedId = channelId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    const script = `
      tell application "Messages"
        set targetService to 1st service whose service type = iMessage
        set targetBuddy to buddy "${escapedId}" of targetService
        send "${escapedText}" to targetBuddy
      end tell
    `;

    try {
      await execFileAsync("osascript", ["-e", script]);
    } catch (err) {
      throw new Error(
        `iMessage send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async sendTyping(_channelId: string): Promise<void> {
    // iMessage doesn't support programmatic typing indicators
  }

  async healthCheck(): Promise<{ connected: boolean; latencyMs?: number }> {
    if (process.platform !== "darwin") return { connected: false };

    const start = Date.now();
    try {
      await execFileAsync("osascript", [
        "-e",
        'tell application "Messages" to get name',
      ]);
      return { connected: true, latencyMs: Date.now() - start };
    } catch {
      return { connected: false };
    }
  }

  /** Inject a message payload from webhook server */
  async injectMessage(rawPayload: unknown): Promise<void> {
    if (!this.messageHandler) return;

    const msg = rawPayload as {
      guid?: string; id?: string;
      sender?: string; from?: string; handle_id?: string;
      chat_id?: string | number; is_group?: boolean; group_name?: string;
      is_from_me?: boolean;
      text?: string; timestamp?: string; date?: number;
    };

    // Skip self-sent messages
    if (msg.is_from_me) return;

    const senderId = msg.handle_id ?? msg.sender ?? msg.from ?? "";
    const isGroup = msg.is_group ?? !!msg.group_name;
    const channelId = msg.chat_id != null ? String(msg.chat_id) : senderId;

    const normalized: NormalizedMessage = {
      messageId: msg.guid ?? msg.id ?? String(Date.now()),
      platform: "imessage",
      senderId,
      senderPhone: senderId.startsWith("+") ? senderId : undefined,
      senderEmail: senderId.includes("@") ? senderId : undefined,
      channelId,
      chatType: isGroup ? "group" : "direct",
      text: msg.text ?? "",
      timestamp: msg.timestamp
        ? new Date(msg.timestamp).toISOString()
        : new Date().toISOString(),
      raw: rawPayload,
    };

    try {
      await this.messageHandler(normalized);
    } catch (err) {
      console.error("[imessage] injectMessage handler error:", err);
    }
  }

  private async pollMessages(): Promise<void> {
    if (!this.messageHandler) return;

    try {
      const { createClient } = await import("@libsql/client");
      const db = createClient({ url: `file:${MESSAGES_DB_PATH}` });

      const result = await db.execute({
        sql: `SELECT
                m.ROWID, m.text, m.date, m.is_from_me,
                h.id as handle_id, h.uncanonicalized_id,
                c.chat_identifier, c.display_name
              FROM message m
              LEFT JOIN handle h ON m.handle_id = h.ROWID
              LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
              LEFT JOIN chat c ON cmj.chat_id = c.ROWID
              WHERE m.ROWID > ? AND m.is_from_me = 0 AND m.text IS NOT NULL
              ORDER BY m.ROWID ASC
              LIMIT 50`,
        args: [this.lastMessageRowId],
      });

      db.close();

      for (const row of result.rows) {
        const rowId = Number(row.ROWID);
        if (rowId > this.lastMessageRowId) {
          this.lastMessageRowId = rowId;
        }

        // macOS Messages date is nanoseconds since 2001-01-01
        const macEpoch = new Date("2001-01-01T00:00:00Z").getTime();
        const timestamp = new Date(
          macEpoch + Number(row.date) / 1_000_000,
        ).toISOString();

        const senderId = (row.handle_id as string) ?? (row.uncanonicalized_id as string) ?? "";
        const isGroup = ((row.chat_identifier as string) ?? "").includes(";");

        const normalized: NormalizedMessage = {
          messageId: String(rowId),
          platform: "imessage",
          senderId,
          senderPhone: senderId.startsWith("+") ? senderId : undefined,
          senderEmail: senderId.includes("@") ? senderId : undefined,
          channelId: (row.chat_identifier as string) ?? senderId,
          chatType: isGroup ? "group" : "direct",
          text: (row.text as string) ?? "",
          timestamp,
          raw: row,
        };

        try {
          await this.messageHandler(normalized);
        } catch (err) {
          console.error("[imessage] Message handler error:", err);
        }
      }
    } catch (err) {
      console.error("[imessage] Poll error:", err instanceof Error ? err.message : err);
    }
  }
}
