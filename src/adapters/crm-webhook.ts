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

interface Condition {
  field: string;
  op: "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains" | "not_contains";
  value: string | number | boolean;
}

interface Action {
  type: string;
  params: Record<string, string>;
  requires_approval?: boolean;
}

interface Trigger {
  id: string;
  name: string;
  event: string;
  conditions: Condition[];
  actions: Action[];
  enabled: boolean;
  project?: string;
}

interface TriggerFireLog {
  triggerId: string;
  triggerName: string;
  event: string;
  firedAt: string;
  actionsExecuted: Array<{ type: string; success: boolean; error?: string }>;
}

type ActionExecutor = (
  action: Action,
  record: Record<string, unknown>,
) => Promise<{ success: boolean; error?: string }>;

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
// Standalone trigger evaluator (used when no onCRMEvent hook is injected)
// ---------------------------------------------------------------------------

function evaluateCondition(condition: Condition, record: Record<string, unknown>): boolean {
  const actual = record[condition.field];
  const expected = condition.value;
  switch (condition.op) {
    case "eq": return actual === expected;
    case "neq": return actual !== expected;
    case "gt": return (actual as number) > (expected as number);
    case "lt": return (actual as number) < (expected as number);
    case "gte": return (actual as number) >= (expected as number);
    case "lte": return (actual as number) <= (expected as number);
    case "contains": return typeof actual === "string" && actual.includes(String(expected));
    case "not_contains": return typeof actual === "string" && !actual.includes(String(expected));
    default: return false;
  }
}

async function evaluateTriggersLocally(
  event: CRMEvent,
  triggers: Trigger[],
  executor?: ActionExecutor,
): Promise<TriggerFireLog[]> {
  const eventKey = `${event.objectType}.${event.eventType}`;
  const logs: TriggerFireLog[] = [];

  for (const trigger of triggers) {
    if (!trigger.enabled || trigger.event !== eventKey) continue;

    const allMatch = trigger.conditions.every((c) => evaluateCondition(c, event.record));
    if (!allMatch) continue;

    const actionsExecuted: Array<{ type: string; success: boolean; error?: string }> = [];
    for (const action of trigger.actions) {
      if (executor) {
        const result = await executor(action, event.record);
        actionsExecuted.push({ type: action.type, ...result });
      } else {
        actionsExecuted.push({ type: action.type, success: true });
      }
    }

    logs.push({
      triggerId: trigger.id,
      triggerName: trigger.name,
      event: trigger.event,
      firedAt: new Date().toISOString(),
      actionsExecuted,
    });
  }

  return logs;
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

/**
 * Create a webhook handler function for CRM events.
 * Register this with WebhookServer.onPlatform("crm", handler).
 *
 * When an onCRMEvent hook is injected (via setHooks), it delegates to that.
 * Otherwise uses a built-in standalone trigger evaluator.
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
        : await evaluateTriggersLocally(event, options?.triggers ?? [], options?.executor);

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
