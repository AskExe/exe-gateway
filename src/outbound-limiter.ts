/**
 * Outbound message limiter — human-like sending behavior to prevent platform bans.
 *
 * Features:
 *   1. Random delay between messages (configurable min/max per platform)
 *   2. Typing simulation — sends "composing" presence before message delivery
 *   3. Per-recipient rate limiting — don't spam one person
 *   4. Global rate limiting — hourly + daily caps
 *   5. Queue system — messages are queued and sent at human pace
 *
 * Default limits tuned for WhatsApp (strictest platform).
 * Other platforms use relaxed defaults.
 */

export interface PlatformLimits {
  /** Min seconds between messages to SAME recipient */
  minDelayPerRecipientSec: number;
  /** Max seconds between messages to SAME recipient (random between min-max) */
  maxDelayPerRecipientSec: number;
  /** Min seconds between ANY outbound message (global) */
  minGlobalDelaySec: number;
  /** Max seconds between ANY outbound message (global) */
  maxGlobalDelaySec: number;
  /** Simulate typing: characters per second (message.length / cps = typing duration) */
  typingCps: number;
  /** Min typing simulation seconds (floor) */
  minTypingSec: number;
  /** Max typing simulation seconds (cap) */
  maxTypingSec: number;
  /** Max messages per hour (0 = unlimited) */
  maxPerHour: number;
  /** Max messages per day (0 = unlimited) */
  maxPerDay: number;
  /** Max reconnect attempts before stopping */
  maxReconnectAttempts: number;
  /** Initial reconnect delay in seconds */
  initialReconnectDelaySec: number;
  /** Max reconnect delay in seconds (backoff cap) */
  maxReconnectDelaySec: number;
}

/** Conservative defaults — tuned to not get banned */
export const PLATFORM_LIMITS: Record<string, PlatformLimits> = {
  whatsapp: {
    minDelayPerRecipientSec: 5,
    maxDelayPerRecipientSec: 15,
    minGlobalDelaySec: 2,
    maxGlobalDelaySec: 5,
    typingCps: 25,         // ~25 chars/sec = realistic phone typing
    minTypingSec: 1.5,
    maxTypingSec: 8,
    maxPerHour: 30,        // Conservative for new numbers
    maxPerDay: 200,
    maxReconnectAttempts: 10,
    initialReconnectDelaySec: 10,
    maxReconnectDelaySec: 300,
  },
  telegram: {
    minDelayPerRecipientSec: 2,
    maxDelayPerRecipientSec: 8,
    minGlobalDelaySec: 1,
    maxGlobalDelaySec: 3,
    typingCps: 40,
    minTypingSec: 1,
    maxTypingSec: 5,
    maxPerHour: 60,
    maxPerDay: 500,
    maxReconnectAttempts: 15,
    initialReconnectDelaySec: 5,
    maxReconnectDelaySec: 120,
  },
  discord: {
    minDelayPerRecipientSec: 1,
    maxDelayPerRecipientSec: 5,
    minGlobalDelaySec: 0.5,
    maxGlobalDelaySec: 2,
    typingCps: 50,
    minTypingSec: 0.5,
    maxTypingSec: 4,
    maxPerHour: 120,
    maxPerDay: 1000,
    maxReconnectAttempts: 20,
    initialReconnectDelaySec: 3,
    maxReconnectDelaySec: 60,
  },
  slack: {
    minDelayPerRecipientSec: 1,
    maxDelayPerRecipientSec: 5,
    minGlobalDelaySec: 0.5,
    maxGlobalDelaySec: 2,
    typingCps: 50,
    minTypingSec: 0.5,
    maxTypingSec: 4,
    maxPerHour: 120,
    maxPerDay: 1000,
    maxReconnectAttempts: 20,
    initialReconnectDelaySec: 3,
    maxReconnectDelaySec: 60,
  },
  email: {
    minDelayPerRecipientSec: 10,
    maxDelayPerRecipientSec: 30,
    minGlobalDelaySec: 5,
    maxGlobalDelaySec: 15,
    typingCps: 0,          // No typing simulation for email
    minTypingSec: 0,
    maxTypingSec: 0,
    maxPerHour: 20,
    maxPerDay: 100,
    maxReconnectAttempts: 5,
    initialReconnectDelaySec: 30,
    maxReconnectDelaySec: 600,
  },
};

/** Fallback for unknown platforms */
const DEFAULT_LIMITS: PlatformLimits = {
  minDelayPerRecipientSec: 3,
  maxDelayPerRecipientSec: 10,
  minGlobalDelaySec: 1,
  maxGlobalDelaySec: 3,
  typingCps: 30,
  minTypingSec: 1,
  maxTypingSec: 6,
  maxPerHour: 50,
  maxPerDay: 300,
  maxReconnectAttempts: 10,
  initialReconnectDelaySec: 10,
  maxReconnectDelaySec: 300,
};

// ---------------------------------------------------------------------------
// Rate tracking
// ---------------------------------------------------------------------------

interface SendRecord {
  timestamp: number;
  recipientId: string;
}

export class OutboundLimiter {
  private limits: PlatformLimits;
  private platform: string;
  private sendLog: SendRecord[] = [];
  private lastSendByRecipient = new Map<string, number>();
  private lastGlobalSend = 0;
  private processing = false;
  private queue: Array<{
    recipientId: string;
    text: string;
    sendFn: (text: string) => Promise<void>;
    typingFn?: () => Promise<void>;
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(platform: string, overrides?: Partial<PlatformLimits>) {
    this.platform = platform;
    this.limits = { ...(PLATFORM_LIMITS[platform] ?? DEFAULT_LIMITS), ...overrides };
  }

  /** Get current limits (for health/status endpoints) */
  getLimits(): PlatformLimits { return { ...this.limits }; }

  /** Get send stats for the current hour/day */
  getStats(): { sentLastHour: number; sentToday: number; queueLength: number } {
    const now = Date.now();
    const hourAgo = now - 3_600_000;
    const dayAgo = now - 86_400_000;
    this.pruneLog();
    return {
      sentLastHour: this.sendLog.filter(r => r.timestamp > hourAgo).length,
      sentToday: this.sendLog.filter(r => r.timestamp > dayAgo).length,
      queueLength: this.queue.length,
    };
  }

  /**
   * Queue a message for rate-limited sending.
   * Returns a promise that resolves when the message is actually sent.
   */
  async send(
    recipientId: string,
    text: string,
    sendFn: (text: string) => Promise<void>,
    typingFn?: () => Promise<void>,
  ): Promise<void> {
    // Check hourly/daily limits BEFORE queueing
    this.pruneLog();
    const now = Date.now();
    const hourAgo = now - 3_600_000;
    const dayAgo = now - 86_400_000;
    const sentLastHour = this.sendLog.filter(r => r.timestamp > hourAgo).length;
    const sentToday = this.sendLog.filter(r => r.timestamp > dayAgo).length;

    if (this.limits.maxPerHour > 0 && sentLastHour >= this.limits.maxPerHour) {
      throw new Error(
        `[${this.platform}] Hourly limit reached (${sentLastHour}/${this.limits.maxPerHour}). ` +
        `Next message allowed in ~${Math.ceil((this.sendLog.find(r => r.timestamp > hourAgo)!.timestamp + 3_600_000 - now) / 60_000)} min.`
      );
    }

    if (this.limits.maxPerDay > 0 && sentToday >= this.limits.maxPerDay) {
      throw new Error(
        `[${this.platform}] Daily limit reached (${sentToday}/${this.limits.maxPerDay}). Try again tomorrow.`
      );
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ recipientId, text, sendFn, typingFn, resolve, reject });
      void this.processQueue();
    });
  }

  // ---------------------------------------------------------------------------
  // Queue processor
  // ---------------------------------------------------------------------------

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        await this.waitForSlot(item.recipientId);
        await this.simulateTyping(item.text, item.typingFn);
        await item.sendFn(item.text);
        this.recordSend(item.recipientId);
        item.resolve();
      } catch (err) {
        item.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    this.processing = false;
  }

  /**
   * Wait until we're allowed to send to this recipient.
   * Respects both per-recipient and global delays.
   */
  private async waitForSlot(recipientId: string): Promise<void> {
    const now = Date.now();

    // Per-recipient delay
    const lastToRecipient = this.lastSendByRecipient.get(recipientId) ?? 0;
    const recipientDelay = randomBetween(
      this.limits.minDelayPerRecipientSec,
      this.limits.maxDelayPerRecipientSec,
    ) * 1000;
    const recipientWait = Math.max(0, lastToRecipient + recipientDelay - now);

    // Global delay
    const globalDelay = randomBetween(
      this.limits.minGlobalDelaySec,
      this.limits.maxGlobalDelaySec,
    ) * 1000;
    const globalWait = Math.max(0, this.lastGlobalSend + globalDelay - now);

    const waitMs = Math.max(recipientWait, globalWait);
    if (waitMs > 0) {
      console.log(
        `[outbound-limiter] [${this.platform}] Waiting ${(waitMs / 1000).toFixed(1)}s before sending to ${recipientId.slice(0, 8)}...`,
      );
      await sleep(waitMs);
    }
  }

  /**
   * Simulate typing before sending — sends "composing" presence and waits.
   * Duration based on message length + randomization.
   */
  private async simulateTyping(
    text: string,
    typingFn?: () => Promise<void>,
  ): Promise<void> {
    if (this.limits.typingCps <= 0 || !typingFn) return;

    // Calculate typing duration from message length
    const baseDuration = text.length / this.limits.typingCps;
    const jitter = randomBetween(0.8, 1.3); // ±20-30% variation
    const duration = Math.max(
      this.limits.minTypingSec,
      Math.min(this.limits.maxTypingSec, baseDuration * jitter),
    );

    try {
      await typingFn();
      console.log(
        `[outbound-limiter] [${this.platform}] Typing simulation: ${duration.toFixed(1)}s for ${text.length} chars`,
      );
      await sleep(duration * 1000);
    } catch {
      // Typing indicator failed — send anyway
    }
  }

  private recordSend(recipientId: string): void {
    const now = Date.now();
    this.lastSendByRecipient.set(recipientId, now);
    this.lastGlobalSend = now;
    this.sendLog.push({ timestamp: now, recipientId });
  }

  /** Remove records older than 24h */
  private pruneLog(): void {
    const cutoff = Date.now() - 86_400_000;
    this.sendLog = this.sendLog.filter(r => r.timestamp > cutoff);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
