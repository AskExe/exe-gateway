/**
 * CRM webhook adapter — parses Twenty CRM outbound webhook payloads
 * and routes events to the trigger engine.
 *
 * Twenty fires webhooks on object lifecycle events:
 *   *.created, *.updated, *.deleted
 *
 * This adapter is NOT a PlatformAdapter (it doesn't handle messaging).
 * It's a webhook handler registered on `/webhook/crm` that converts
 * CRM payloads into CRMEvents for the trigger engine.
 *
 * @module crm-webhook
 */

import { getHooks } from "../hooks.js";

// Local types — match exe-os trigger-engine shapes for standalone use
interface CRMEvent {
  eventType: string;
  objectType: string;
  record: Record<string, unknown>;
}

interface Trigger {
  id: string;
  name: string;
  eventType: string;
  objectType: string;
  conditions?: Record<string, unknown>;
  actions: Array<{ type: string; config: Record<string, unknown> }>;
}

interface TriggerFireLog {
  triggerId: string;
  triggerName: string;
  eventType: string;
  objectType: string;
  firedAt: string;
  actionsExecuted: number;
  success: boolean;
  error?: string;
}

type ActionExecutor = (action: { type: string; config: Record<string, unknown> }, event: CRMEvent) => Promise<void>;

// ---------------------------------------------------------------------------
// Twenty webhook payload structure
// ---------------------------------------------------------------------------

/**
 * Twenty CRM webhook payload format.
 *
 * Twenty sends webhooks with this structure:
 * {
 *   "targetUrl": "https://...",
 *   "eventName": "company.created",
 *   "objectMetadata": { "id": "...", "nameSingular": "company", ... },
 *   "workspaceId": "...",
 *   "record": { ... the actual record data ... }
 * }
 */
interface TwentyWebhookPayload {
  targetUrl?: string;
  eventName?: string;
  objectMetadata?: {
    id?: string;
    nameSingular?: string;
    namePlural?: string;
  };
  workspaceId?: string;
  record?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Twenty CRM webhook payload into a CRMEvent.
 * Returns null if the payload is malformed or missing required fields.
 */
export function parseTwentyWebhook(
  payload: unknown,
): CRMEvent | null {
  if (!payload || typeof payload !== "object") return null;

  const p = payload as TwentyWebhookPayload;

  // eventName format: "objectType.eventType" (e.g., "company.created")
  const eventName = p.eventName;
  if (!eventName || typeof eventName !== "string") return null;

  const dotIndex = eventName.indexOf(".");
  if (dotIndex === -1) return null;

  const objectType = eventName.slice(0, dotIndex);
  const eventType = eventName.slice(dotIndex + 1);

  if (!objectType || !eventType) return null;

  // Capitalize object type to match trigger conventions (Deal, Order, Person)
  const normalizedObjectType =
    objectType.charAt(0).toUpperCase() + objectType.slice(1);

  const record = p.record ?? {};
  if (typeof record !== "object") return null;

  return {
    eventType,
    objectType: normalizedObjectType,
    record: record as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

/**
 * Create a webhook handler function for CRM events.
 * Register this with WebhookServer.onPlatform("crm", handler).
 *
 * @param executor Optional custom action executor (for testing).
 * @param onFired Optional callback when triggers fire (for audit logging).
 */
export function createCRMWebhookHandler(options?: {
  executor?: ActionExecutor;
  onFired?: (logs: TriggerFireLog[]) => void;
  triggers?: Trigger[];
}): (body: unknown) => Promise<void> {
  return async (body: unknown): Promise<void> => {
    const event = parseTwentyWebhook(body);

    if (!event) {
      console.warn(
        "[crm-webhook] Malformed CRM webhook payload — skipping",
      );
      return;
    }

    console.log(
      `[crm-webhook] ${event.objectType}.${event.eventType} received`,
    );

    try {
      const onCRM = getHooks().onCRMEvent;
      const logs = onCRM
        ? (await onCRM(event, options?.executor, options?.triggers)) as TriggerFireLog[]
        : [];

      if (logs.length > 0 && options?.onFired) {
        options.onFired(logs);
      }
    } catch (err) {
      console.error(
        "[crm-webhook] Error processing CRM event:",
        err instanceof Error ? err.message : err,
      );
    }
  };
}
