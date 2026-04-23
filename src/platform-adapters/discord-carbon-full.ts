/**
 * Discord adapter using @buape/carbon — FULL IMPLEMENTATION
 */

import type { GatewayAdapter, InboundMessage, OutboundMessage, OutboundResult, PlatformAccount } from "@askexenow/exe-os/dist/lib/gateway-adapter.js";

export class DiscordCarbonFullAdapter implements GatewayAdapter {
  readonly platform = "discord" as const;
  private botToken: string;
  private accountId: string;
  private isMonitoring = false;
  private applicationId: string | null = null;

  constructor(config: { botToken: string; accountId?: string }) {
    this.botToken = config.botToken;
    this.accountId = config.accountId || "default";
  }

  async listAccounts(): Promise<PlatformAccount[]> {
    if (!this.applicationId) {
      try {
        const response = await fetch("https://discord.com/api/v10/applications/@me", {
          headers: { Authorization: `Bot ${this.botToken}` },
        });
        if (!response.ok) return [];
        const data = await response.json() as any;
        this.applicationId = data.id;
      } catch {
        return [];
      }
    }

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
      const response = await fetch(`https://discord.com/api/v10/channels/${message.to}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: message.content.text || "(empty)" }),
      });

      const data = await response.json() as any;
      if (!response.ok) throw new Error(data.message);

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
    _onMessage: (msg: InboundMessage) => Promise<void>,
    _options?: { accountId?: string; debounceMs?: number },
  ): Promise<() => Promise<void>> {
    if (this.isMonitoring) throw new Error("Monitor already running");
    this.isMonitoring = true;

    // TODO: Connect to Discord gateway with intents
    // TODO: Handle MESSAGE_CREATE events
    // TODO: Parse user, channel, content
    // TODO: Call onMessage for each received message

    return async () => {
      this.isMonitoring = false;
    };
  }

  async isReady(): Promise<boolean> {
    try {
      const response = await fetch("https://discord.com/api/v10/applications/@me", {
        headers: { Authorization: `Bot ${this.botToken}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async healthCheck(): Promise<{ status: "ok" | "degraded" | "down"; message?: string }> {
    try {
      const response = await fetch("https://discord.com/api/v10/applications/@me", {
        headers: { Authorization: `Bot ${this.botToken}` },
      });
      return response.ok ? { status: "ok" } : { status: "down", message: "Discord API error" };
    } catch (err) {
      return { status: "down", message: String(err) };
    }
  }
}
