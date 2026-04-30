/**
 * Slack adapter — FULL IMPLEMENTATION
 *
 * Uses Slack Web API for sending + Socket Mode via WebSocket for receiving.
 * No @slack/bolt dependency — pure fetch + WebSocket.
 */

import type { GatewayAdapter, InboundMessage, OutboundMessage, OutboundResult, PlatformAccount } from "../gateway-adapter-types.js";

const SLACK_API = "https://slack.com/api";

export class SlackBoltFullAdapter implements GatewayAdapter {
  readonly platform = "slack" as const;
  private botToken: string;
  public _appToken: string;
  private accountId: string;
  private isMonitoring = false;
  private userId: string | null = null;
  private botName: string | null = null;
  private ws: WebSocket | null = null;

  constructor(config: { botToken: string; appToken: string; accountId?: string }) {
    this.botToken = config.botToken;
    this._appToken = config.appToken;
    this.accountId = config.accountId || "default";
  }

  async listAccounts(): Promise<PlatformAccount[]> {
    await this.ensureBotInfo();
    if (!this.userId) return [];

    return [
      {
        id: this.accountId,
        platform: "slack",
        name: this.botName || `Slack Bot (${this.userId})`,
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
    try {
      const body: Record<string, unknown> = {
        channel: message.to,
        text: message.content.text || "(empty)",
      };

      if (message.content.threadId) {
        body.thread_ts = message.content.threadId;
      }

      const response = await fetch(`${SLACK_API}/chat.postMessage`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const data = await response.json() as any;
      if (!data.ok) throw new Error(data.error);

      return {
        messageId: data.ts,
        platform: "slack",
        timestamp: startTime,
        success: true,
      };
    } catch (err) {
      return {
        messageId: "",
        platform: "slack",
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
    if (this.isMonitoring) throw new Error("Monitor already running");
    this.isMonitoring = true;

    await this.ensureBotInfo();

    // Open Socket Mode connection
    await this.connectSocketMode(onMessage);

    return async () => {
      this.isMonitoring = false;
      if (this.ws) {
        this.ws.close(1000, "Monitor stopped");
        this.ws = null;
      }
    };
  }

  async isReady(): Promise<boolean> {
    try {
      const response = await fetch(`${SLACK_API}/auth.test`, {
        headers: { Authorization: `Bearer ${this.botToken}` },
      });
      const data = await response.json() as any;
      return data.ok === true;
    } catch {
      return false;
    }
  }

  async healthCheck(): Promise<{ status: "ok" | "degraded" | "down"; message?: string }> {
    try {
      const response = await fetch(`${SLACK_API}/auth.test`, {
        headers: { Authorization: `Bearer ${this.botToken}` },
      });
      const data = await response.json() as any;
      if (data.ok) {
        return this.ws
          ? { status: "ok" }
          : { status: "degraded", message: "API reachable but Socket Mode not connected" };
      }
      return { status: "down", message: data.error || "Slack API error" };
    } catch (err) {
      return { status: "down", message: String(err) };
    }
  }

  private async ensureBotInfo(): Promise<void> {
    if (this.userId) return;
    try {
      const response = await fetch(`${SLACK_API}/auth.test`, {
        headers: { Authorization: `Bearer ${this.botToken}` },
      });
      const data = await response.json() as any;
      if (data.ok) {
        this.userId = data.user_id;
        this.botName = data.user;
      }
    } catch {
      // Will retry
    }
  }

  private async connectSocketMode(
    onMessage: (msg: InboundMessage) => Promise<void>,
  ): Promise<void> {
    // Get WebSocket URL via apps.connections.open
    const openRes = await fetch(`${SLACK_API}/apps.connections.open`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this._appToken}` },
    });
    const openData = await openRes.json() as any;
    if (!openData.ok) {
      console.error("[slack] Socket Mode connection failed:", openData.error);
      return;
    }

    const wsUrl = openData.url;

    return new Promise((resolve) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log("[slack] Socket Mode connected");
        resolve();
      };

      this.ws.onmessage = (event) => {
        const payload = JSON.parse(String(event.data));

        // Acknowledge all events immediately
        if (payload.envelope_id) {
          this.ws?.send(JSON.stringify({ envelope_id: payload.envelope_id }));
        }

        // Handle events_api dispatches
        if (payload.type === "events_api") {
          const innerEvent = payload.payload?.event;
          if (!innerEvent) return;

          // Handle message events and app_mention events
          if (innerEvent.type === "message" || innerEvent.type === "app_mention") {
            // Skip bot's own messages
            if (innerEvent.bot_id || innerEvent.user === this.userId) return;
            // Skip message subtypes (edits, deletes, etc.) — only new messages
            if (innerEvent.subtype) return;

            const chatType = innerEvent.channel_type === "im" ? "direct" : "group";

            const inbound: InboundMessage = {
              id: innerEvent.client_msg_id || innerEvent.ts,
              platform: "slack",
              from: innerEvent.user,
              to: innerEvent.channel,
              content: {
                text: innerEvent.text || "",
                threadId: innerEvent.thread_ts,
              },
              timestamp: Math.floor(Number(innerEvent.ts) * 1000),
              chatType,
            };

            onMessage(inbound).catch((err) => {
              console.error("[slack] Message handler error:", err);
            });
          }
        }
      };

      this.ws.onerror = (err) => {
        console.error("[slack] WebSocket error:", err);
      };

      this.ws.onclose = () => {
        if (this.isMonitoring) {
          console.warn("[slack] Socket Mode disconnected, reconnecting in 5s...");
          setTimeout(() => {
            if (this.isMonitoring) {
              this.connectSocketMode(onMessage).catch((err) => {
                console.error("[slack] Reconnect failed:", err);
              });
            }
          }, 5000);
        }
      };
    });
  }
}
