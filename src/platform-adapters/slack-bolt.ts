/**
 * Slack adapter using @slack/bolt
 */

import type { GatewayAdapter, InboundMessage, OutboundMessage, OutboundResult, PlatformAccount } from "@askexenow/exe-os/dist/lib/gateway-adapter.js";

export interface BoltConfig {
  botToken: string;
  appToken: string;
  accountId?: string;
}

export class SlackBoltAdapter implements GatewayAdapter {
  readonly platform = "slack" as const;
  public _config: BoltConfig;
  public _isMonitoring = false;

  constructor(config: BoltConfig) {
    this._config = config;
  }

  async listAccounts(): Promise<PlatformAccount[]> { return []; }
  async getAccount(_accountId: string): Promise<PlatformAccount> { throw new Error("Not implemented"); }
  async sendMessage(_message: OutboundMessage): Promise<OutboundResult> {
    return { messageId: "", platform: "slack", timestamp: Date.now(), success: false, error: "Not implemented" };
  }
  async startMonitor(_onMessage: (msg: InboundMessage) => Promise<void>, _options?: { accountId?: string; debounceMs?: number }): Promise<() => Promise<void>> {
    this._isMonitoring = true;
    return async () => { this._isMonitoring = false; };
  }
  async isReady(): Promise<boolean> { return false; }
  async healthCheck() { return { status: "down" as const, message: "Not implemented" }; }
}
