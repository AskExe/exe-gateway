/**
 * Discord adapter using @buape/carbon
 */

import type { GatewayAdapter, InboundMessage, OutboundMessage, OutboundResult, PlatformAccount } from "@askexenow/exe-os/dist/lib/gateway-adapter.js";

export interface CarbonConfig {
  botToken: string;
  accountId?: string;
}

export class DiscordCarbonAdapter implements GatewayAdapter {
  readonly platform = "discord" as const;
  public _config: CarbonConfig;
  public _isMonitoring = false;

  constructor(config: CarbonConfig) {
    this._config = config;
  }

  async listAccounts(): Promise<PlatformAccount[]> { return []; }
  async getAccount(_accountId: string): Promise<PlatformAccount> { throw new Error("Not implemented"); }
  async sendMessage(_message: OutboundMessage): Promise<OutboundResult> {
    return { messageId: "", platform: "discord", timestamp: Date.now(), success: false, error: "Not implemented" };
  }
  async startMonitor(_onMessage: (msg: InboundMessage) => Promise<void>, _options?: { accountId?: string; debounceMs?: number }): Promise<() => Promise<void>> {
    this._isMonitoring = true;
    return async () => { this._isMonitoring = false; };
  }
  async isReady(): Promise<boolean> { return false; }
  async healthCheck() { return { status: "down" as const, message: "Not implemented" }; }
}
