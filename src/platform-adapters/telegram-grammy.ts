/**
 * Telegram adapter using Grammy (Telegram Bot API)
 */

import type { GatewayAdapter, InboundMessage, OutboundMessage, OutboundResult, PlatformAccount } from "@askexenow/exe-os/dist/lib/gateway-adapter.js";

export interface GrammyConfig {
  botToken: string;
  accountId?: string;
}

export class TelegramGrammyAdapter implements GatewayAdapter {
  readonly platform = "telegram" as const;
  public _config: GrammyConfig;
  public _isMonitoring = false;

  constructor(config: GrammyConfig) {
    this._config = config;
  }

  async listAccounts(): Promise<PlatformAccount[]> { return []; }
  async getAccount(_accountId: string): Promise<PlatformAccount> { throw new Error("Not implemented"); }
  async sendMessage(_message: OutboundMessage): Promise<OutboundResult> {
    return { messageId: "", platform: "telegram", timestamp: Date.now(), success: false, error: "Not implemented" };
  }
  async startMonitor(_onMessage: (msg: InboundMessage) => Promise<void>, _options?: { accountId?: string; debounceMs?: number }): Promise<() => Promise<void>> {
    this._isMonitoring = true;
    return async () => { this._isMonitoring = false; };
  }
  async isReady(): Promise<boolean> { return false; }
  async healthCheck() { return { status: "down" as const, message: "Not implemented" }; }
}
