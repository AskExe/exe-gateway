/**
 * Discord adapter — FULL IMPLEMENTATION
 *
 * Uses Discord REST API + Gateway WebSocket for real-time message monitoring.
 * No external Discord library dependency — pure fetch + WebSocket.
 */

import type { GatewayAdapter, InboundMessage, OutboundMessage, OutboundResult, PlatformAccount } from "../gateway-adapter-types.js";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";

export class DiscordCarbonFullAdapter implements GatewayAdapter {
  readonly platform = "discord" as const;
  private botToken: string;
  private accountId: string;
  private isMonitoring = false;
  private applicationId: string | null = null;
  private botUserId: string | null = null;
  private ws: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastSequence: number | null = null;

  constructor(config: { botToken: string; accountId?: string }) {
    this.botToken = config.botToken;
    this.accountId = config.accountId || "default";
  }

  async listAccounts(): Promise<PlatformAccount[]> {
    await this.ensureBotInfo();
    if (!this.applicationId) return [];

    return [
      {
        id: this.accountId,
        platform: "discord",
        name: `Discord Bot (${this.applicationId})`,
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
      const body: Record<string, unknown> = { content: message.content.text || "(empty)" };

      if (message.content.replyToId) {
        body.message_reference = { message_id: message.content.replyToId };
      }

      const response = await fetch(`${DISCORD_API}/channels/${message.to}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const data = await response.json() as any;
      if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);

      return {
        messageId: data.id,
        platform: "discord",
        timestamp: startTime,
        success: true,
      };
    } catch (err) {
      return {
        messageId: "",
        platform: "discord",
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

    // Connect to Discord Gateway WebSocket
    await this.connectGateway(onMessage);

    return async () => {
      this.isMonitoring = false;
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      if (this.ws) {
        this.ws.close(1000, "Monitor stopped");
        this.ws = null;
      }
    };
  }

  async isReady(): Promise<boolean> {
    try {
      const response = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bot ${this.botToken}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async healthCheck(): Promise<{ status: "ok" | "degraded" | "down"; message?: string }> {
    try {
      const response = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bot ${this.botToken}` },
      });
      if (response.ok) {
        return this.ws
          ? { status: "ok" }
          : { status: "degraded", message: "API reachable but gateway not connected" };
      }
      return { status: "down", message: "Discord API error" };
    } catch (err) {
      return { status: "down", message: String(err) };
    }
  }

  private async ensureBotInfo(): Promise<void> {
    if (this.applicationId) return;
    try {
      const response = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bot ${this.botToken}` },
      });
      if (!response.ok) return;
      const data = await response.json() as any;
      this.botUserId = data.id;
      this.applicationId = data.id;
    } catch {
      // Will retry on next call
    }
  }

  private async connectGateway(
    onMessage: (msg: InboundMessage) => Promise<void>,
  ): Promise<void> {
    return new Promise((resolve) => {
      this.ws = new WebSocket(DISCORD_GATEWAY);

      this.ws.onmessage = (event) => {
        const payload = JSON.parse(String(event.data));
        this.lastSequence = payload.s;

        switch (payload.op) {
          case 10: {
            // Hello — start heartbeating and identify
            const interval = payload.d.heartbeat_interval;
            this.heartbeatInterval = setInterval(() => {
              this.ws?.send(JSON.stringify({ op: 1, d: this.lastSequence }));
            }, interval);

            // Identify with intents for guild messages + DMs
            this.ws?.send(JSON.stringify({
              op: 2,
              d: {
                token: this.botToken,
                intents: (1 << 9) | (1 << 12), // GUILD_MESSAGES | DIRECT_MESSAGES
                properties: { os: "linux", browser: "exe-gateway", device: "exe-gateway" },
              },
            }));
            resolve();
            break;
          }
          case 0: {
            // Dispatch event
            if (payload.t === "MESSAGE_CREATE") {
              const msg = payload.d;
              // Skip own messages
              if (msg.author.id === this.botUserId) break;

              const inbound: InboundMessage = {
                id: msg.id,
                platform: "discord",
                from: msg.author.id,
                to: msg.channel_id,
                content: {
                  text: msg.content || "",
                  replyToId: msg.referenced_message?.id,
                },
                timestamp: new Date(msg.timestamp).getTime(),
                chatType: msg.guild_id ? "group" : "direct",
                senderName: msg.author.username,
              };

              onMessage(inbound).catch((err) => {
                console.error("[discord] Message handler error:", err);
              });
            }
            break;
          }
          case 11:
            // Heartbeat ACK — connection healthy
            break;
        }
      };

      this.ws.onerror = (err) => {
        console.error("[discord] WebSocket error:", err);
      };

      this.ws.onclose = () => {
        if (this.isMonitoring) {
          console.warn("[discord] Gateway disconnected, reconnecting in 5s...");
          setTimeout(() => {
            if (this.isMonitoring) {
              this.connectGateway(onMessage).catch((err) => {
                console.error("[discord] Reconnect failed:", err);
              });
            }
          }, 5000);
        }
      };
    });
  }
}
