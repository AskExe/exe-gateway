import { describe, it, expect } from "vitest";
import {
  parseTwentyWebhook,
  createCRMWebhookHandler,
} from "../src/adapters/crm-webhook.js";
// Inlined from exe-os/src/automation/trigger-engine.ts — trigger-engine
// lives outside exe-gateway; only types are needed for test fixtures.
interface Condition {
  field: string;
  op: "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains" | "not_contains";
  value: string | number | boolean;
}
interface Action {
  type: "send_whatsapp" | "send_message" | "create_task" | "update_wiki" | "mcp_tool";
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
// Twenty webhook payload parsing
// ---------------------------------------------------------------------------

describe("parseTwentyWebhook", () => {
  it("parses a standard Twenty webhook payload", () => {
    const payload = {
      targetUrl: "https://example.com/webhook/crm",
      eventName: "company.created",
      objectMetadata: {
        id: "obj-123",
        nameSingular: "company",
        namePlural: "companies",
      },
      workspaceId: "ws-456",
      record: {
        id: "rec-789",
        name: "Acme Corp",
        employees: 50,
      },
    };

    const event = parseTwentyWebhook(payload);
    expect(event).not.toBeNull();
    expect(event!.objectType).toBe("Company");
    expect(event!.eventType).toBe("created");
    expect(event!.record.name).toBe("Acme Corp");
    expect(event!.record.employees).toBe(50);
  });

  it("capitalizes object type", () => {
    const event = parseTwentyWebhook({
      eventName: "deal.updated",
      record: { stage: "won" },
    });
    expect(event!.objectType).toBe("Deal");
  });

  it("handles updated event", () => {
    const event = parseTwentyWebhook({
      eventName: "person.updated",
      record: { id: "p1", name: { firstName: "Alice" } },
    });
    expect(event!.eventType).toBe("updated");
    expect(event!.objectType).toBe("Person");
  });

  it("handles deleted event", () => {
    const event = parseTwentyWebhook({
      eventName: "order.deleted",
      record: { id: "o1" },
    });
    expect(event!.eventType).toBe("deleted");
    expect(event!.objectType).toBe("Order");
  });

  it("returns null for null payload", () => {
    expect(parseTwentyWebhook(null)).toBeNull();
  });

  it("returns null for non-object payload", () => {
    expect(parseTwentyWebhook("string")).toBeNull();
    expect(parseTwentyWebhook(42)).toBeNull();
  });

  it("returns null for missing eventName", () => {
    expect(parseTwentyWebhook({ record: { id: "1" } })).toBeNull();
  });

  it("returns null for eventName without dot separator", () => {
    expect(parseTwentyWebhook({ eventName: "invalid" })).toBeNull();
  });

  it("returns null for empty eventName parts", () => {
    expect(parseTwentyWebhook({ eventName: ".created" })).toBeNull();
    expect(parseTwentyWebhook({ eventName: "deal." })).toBeNull();
  });

  it("defaults to empty record when not provided", () => {
    const event = parseTwentyWebhook({ eventName: "deal.created" });
    expect(event).not.toBeNull();
    expect(event!.record).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// CRM webhook handler integration
// ---------------------------------------------------------------------------

describe("createCRMWebhookHandler", () => {
  const dealWonTrigger: Trigger = {
    id: "t1",
    name: "Deal Won Notify",
    event: "Deal.updated",
    conditions: [{ field: "stage", op: "eq", value: "won" }],
    actions: [
      {
        type: "send_whatsapp",
        params: { to: "+123", message: "Deal {{name}} won!" },
      },
    ],
    enabled: true,
  };

  it("routes valid CRM event to trigger engine", async () => {
    const mockExecutor: ActionExecutor = async () => ({ success: true });
    const firedLogs: TriggerFireLog[] = [];

    const handler = createCRMWebhookHandler({
      executor: mockExecutor,
      onFired: (logs) => firedLogs.push(...logs),
      triggers: [dealWonTrigger],
    });

    await handler({
      eventName: "deal.updated",
      record: { stage: "won", name: "Big Deal" },
    });

    expect(firedLogs).toHaveLength(1);
    expect(firedLogs[0]!.triggerName).toBe("Deal Won Notify");
  });

  it("does not fire when conditions do not match", async () => {
    const mockExecutor: ActionExecutor = async () => ({ success: true });
    const firedLogs: TriggerFireLog[] = [];

    const handler = createCRMWebhookHandler({
      executor: mockExecutor,
      onFired: (logs) => firedLogs.push(...logs),
      triggers: [dealWonTrigger],
    });

    await handler({
      eventName: "deal.updated",
      record: { stage: "pending" },
    });

    expect(firedLogs).toHaveLength(0);
  });

  it("handles malformed payload gracefully", async () => {
    const handler = createCRMWebhookHandler({ triggers: [] });

    // Should not throw
    await handler(null);
    await handler("invalid");
    await handler({ noEventName: true });
    await handler({ eventName: "no-dot" });
  });

  it("handles errors in trigger engine gracefully", async () => {
    const throwingExecutor: ActionExecutor = async () => {
      throw new Error("Boom");
    };

    const handler = createCRMWebhookHandler({
      executor: throwingExecutor,
      triggers: [
        {
          id: "t1",
          name: "Exploding",
          event: "Deal.created",
          conditions: [],
          actions: [{ type: "send_whatsapp", params: {} }],
          enabled: true,
        },
      ],
    });

    // Should not throw — errors are caught internally
    await handler({ eventName: "deal.created", record: {} });
  });
});
