/**
 * iMessage adapter using native macOS integration
 */

import type { GatewayAdapter, InboundMessage, OutboundMessage, OutboundResult, PlatformAccount } from "../gateway-adapter-types.js";

export interface IMessageConfig {
  accountId?: string;
}

export class IMessageNativeAdapter implements GatewayAdapter {
  readonly platform = "imessage" as const;
  public _config: IMessageConfig;
  public _isMonitoring = false;

  constructor(config: IMessageConfig) {
    this._config = config;
  }

  async listAccounts(): Promise<PlatformAccount[]> { return []; }
  async getAccount(_accountId: string): Promise<PlatformAccount> { throw new Error("Not implemented"); }
  async sendMessage(_message: OutboundMessage): Promise<OutboundResult> {
    return { messageId: "", platform: "imessage", timestamp: Date.now(), success: false, error: "Not implemented" };
  }
  async startMonitor(_onMessage: (msg: InboundMessage) => Promise<void>, _options?: { accountId?: string; debounceMs?: number }): Promise<() => Promise<void>> {
    this._isMonitoring = true;
    return async () => { this._isMonitoring = false; };
  }
  async isReady(): Promise<boolean> { return false; }
  async healthCheck() { return { status: "down" as const, message: "Not implemented" }; }
}
