/**
 * Hook interfaces — injectable callbacks that replace exe-os imports.
 * exe-os will inject real implementations when consuming exe-gateway as a dependency.
 * Standalone users get no-op defaults.
 */

export interface GatewayEvent {
  type: string;
  platform: string;
  senderId: string;
  botId: string;
  timestamp: string;
}

export interface GatewayHooks {
  /** Called when gateway processes a message. Replaces orgBus.emit from state-bus. */
  onEvent?: (event: GatewayEvent) => void;

  /** Called to fan out inbound messages to sinks (CRM, memory, wiki). Replaces pipelineIngest. */
  onIngest?: (msg: unknown, response?: string, botId?: string) => Promise<void>;

  /** Called to process CRM events through trigger engine. Replaces processCRMEvent. */
  onCRMEvent?: (event: unknown, executor?: unknown, triggers?: unknown[]) => Promise<unknown[]>;

  /** Called on gateway CLI boot for license validation. Replaces assertVpsLicense. Default: no-op (MIT, no license needed). */
  assertLicense?: () => Promise<{ plan: string }>;
}

// Singleton hooks instance — set once at startup
let _hooks: GatewayHooks = {};

export function setHooks(hooks: GatewayHooks): void {
  _hooks = hooks;
}

export function getHooks(): GatewayHooks {
  return _hooks;
}
