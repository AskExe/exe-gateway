/**
 * WhatsApp adapter using Baileys (WhatsApp Web)
 * 
 * Implements GatewayAdapter interface for WhatsApp messaging via QR code auth
 *
 * @module adapters/whatsapp-baileys
 */

import type {
  GatewayAdapter,
  InboundMessage,
  OutboundMessage,
  OutboundResult,
  PlatformAccount,
} from "../gateway-adapter-types.js";

export interface BaileysConfig {
  authDir: string;
  accountId?: string;
  mediaMaxMb?: number;
  debounceMs?: number;
}

export class WhatsAppBaileysAdapter implements GatewayAdapter {
  readonly platform = "whatsapp" as const;
  public _config: BaileysConfig;
  private isMonitoring = false;

  constructor(config: BaileysConfig) {
    this._config = config;
  }

  async listAccounts(): Promise<PlatformAccount[]> {
    // TODO: Implement account enumeration from config/authDir
    return [];
  }

  async getAccount(_accountId: string): Promise<PlatformAccount> {
    // TODO: Implement account retrieval
    throw new Error("Not implemented");
  }

  async sendMessage(_message: OutboundMessage): Promise<OutboundResult> {
    const startTime = Date.now();
    try {
      // TODO: Use Baileys socket to send message
      return {
        messageId: "placeholder",
        platform: "whatsapp",
        timestamp: startTime,
        success: false,
        error: "Not implemented",
      };
    } catch (err) {
      return {
        messageId: "",
        platform: "whatsapp",
        timestamp: Date.now(),
        success: false,
        error: String(err),
      };
    }
  }

  async startMonitor(
    _onMessage: (msg: InboundMessage) => Promise<void>,
    _options?: {
      accountId?: string;
      debounceMs?: number;
    },
  ): Promise<() => Promise<void>> {
    if (this.isMonitoring) {
      throw new Error("Monitor already running");
    }

    this.isMonitoring = true;

    return async () => {
      this.isMonitoring = false;
    };
  }

  async isReady(): Promise<boolean> {
    return false;
  }

  async healthCheck(): Promise<{
    status: "ok" | "degraded" | "down";
    message?: string;
  }> {
    return {
      status: "down",
      message: "Not implemented",
    };
  }
}
