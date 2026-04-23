/**
 * CRM Bridge — pushes gateway conversations to exe-crm (Twenty fork).
 *
 * One-way push: gateway writes to CRM, CRM is the read layer.
 * Uses Twenty's auto-generated GraphQL API for Person + TimelineActivity.
 *
 * Env vars:
 *   CRM_GRAPHQL_URL  — Twenty server URL (default: http://localhost:3000)
 *   CRM_API_TOKEN    — Twenty API key (bridge disabled if missing)
 */

import type { GatewayPlatform, DataCategory } from "./types.js";

interface CRMBridgeConfig {
  graphqlUrl: string;
  apiToken: string;
}

interface ConversationParams {
  platform: GatewayPlatform;
  senderId: string;
  senderName?: string;
  messageText: string;
  agentResponse: string;
  agentName: string;
  timestamp: string;
  accountId?: string;
}

interface InboundMessageParams {
  platform: GatewayPlatform;
  senderId: string;
  senderName?: string;
  messageText: string;
  timestamp: string;
  accountId?: string;
}

interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string }>;
}

let config: CRMBridgeConfig | null = null;
let disabledLogged = false;

/**
 * Initialize the CRM bridge from env vars. Call once at startup.
 * Returns true if bridge is enabled, false if disabled (missing config).
 */
export function initCRMBridge(): boolean {
  const apiToken = process.env.CRM_API_TOKEN;
  if (!apiToken) {
    if (!disabledLogged) {
      console.log("[crm-bridge] Disabled — CRM_API_TOKEN not set");
      disabledLogged = true;
    }
    config = null;
    return false;
  }

  const graphqlUrl = process.env.CRM_GRAPHQL_URL || "http://localhost:3000";
  config = { graphqlUrl, apiToken };
  console.log(`[crm-bridge] Enabled — pushing to ${graphqlUrl}`);
  return true;
}

/** Check if bridge is active */
export function isCRMBridgeEnabled(): boolean {
  return config !== null;
}

async function gqlRequest<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphQLResponse<T>> {
  const res = await fetch(`${config!.graphqlUrl}/api`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config!.apiToken}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`CRM GraphQL request failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<GraphQLResponse<T>>;
}

/**
 * Find an existing person by phone number or email.
 * Returns the person ID if found, null otherwise.
 */
export async function findPersonByContact(
  platform: GatewayPlatform,
  senderId: string,
): Promise<string | null> {
  const isEmail = platform === "email";

  const query = isEmail
    ? `query FindPerson($value: String!) {
        people(filter: { emails: { primaryEmail: { eq: $value } } }, first: 1) {
          edges { node { id } }
        }
      }`
    : `query FindPerson($value: String!) {
        people(filter: { phones: { primaryPhoneNumber: { eq: $value } } }, first: 1) {
          edges { node { id } }
        }
      }`;

  const res = await gqlRequest<{
    people: { edges: Array<{ node: { id: string } }> };
  }>(query, { value: senderId });

  if (res.errors && res.errors.length > 0) {
    console.error("[crm-bridge] findPerson error:", res.errors[0]!.message);
    return null;
  }

  const edges = res.data?.people?.edges;
  return edges && edges.length > 0 ? edges[0]!.node.id : null;
}

/**
 * Create a new person in the CRM from sender info.
 */
export async function createPerson(
  platform: GatewayPlatform,
  senderId: string,
  senderName?: string,
): Promise<string | null> {
  const firstName = senderName?.split(" ")[0] || "";
  const lastName = senderName?.split(" ").slice(1).join(" ") || "";
  const isEmail = platform === "email";

  const input: Record<string, unknown> = {
    name: { firstName, lastName },
  };

  if (isEmail) {
    input.emails = { primaryEmail: senderId, additionalEmails: [] };
  } else {
    input.phones = {
      primaryPhoneNumber: senderId,
      primaryPhoneCountryCode: "",
      primaryPhoneCallingCode: "",
      additionalPhones: [],
    };
  }

  const query = `
    mutation CreatePerson($input: PersonCreateInput!) {
      createPerson(data: $input) {
        id
      }
    }
  `;

  const res = await gqlRequest<{ createPerson: { id: string } }>(query, {
    input,
  });

  if (res.errors && res.errors.length > 0) {
    console.error("[crm-bridge] createPerson error:", res.errors[0]!.message);
    return null;
  }

  return res.data?.createPerson?.id ?? null;
}

interface TimelineActivityParams {
  platform: GatewayPlatform;
  senderId: string;
  senderName?: string;
  messageText: string;
  timestamp: string;
  accountId?: string;
  direction: "inbound" | "conversation";
  agentResponse?: string;
  agentName?: string;
}

/**
 * Create a timeline activity on a person recording the conversation.
 */
async function createTimelineActivity(
  personId: string,
  params: TimelineActivityParams,
): Promise<boolean> {
  const channelLabel =
    params.platform.charAt(0).toUpperCase() + params.platform.slice(1);
  const label = params.direction === "inbound" ? "message from" : "conversation with";

  const input = {
    name: `${channelLabel} ${label} ${params.senderName || params.senderId}`,
    happensAt: params.timestamp,
    properties: {
      channel: params.platform,
      senderId: params.senderId,
      senderName: params.senderName || null,
      messageText: params.messageText,
      agentResponse: params.agentResponse || null,
      agentName: params.agentName || null,
      threadId: `${params.platform}:${params.senderId}`,
      direction: params.direction,
      accountId: params.accountId || null,
    },
    targetPersonId: personId,
  };

  const query = `
    mutation CreateTimelineActivity($input: TimelineActivityCreateInput!) {
      createTimelineActivity(data: $input) {
        id
      }
    }
  `;

  const res = await gqlRequest<{ createTimelineActivity: { id: string } }>(
    query,
    { input },
  );

  if (res.errors && res.errors.length > 0) {
    console.error(
      "[crm-bridge] createTimelineActivity error:",
      res.errors[0]!.message,
    );
    return false;
  }

  return true;
}

/**
 * Push a gateway conversation to the CRM.
 * Finds or creates the Person, then creates a TimelineActivity.
 *
 * Fails silently — CRM push should never block message delivery.
 */
export async function pushConversationToCRM(
  params: ConversationParams,
): Promise<void> {
  if (!config) return;

  try {
    // Find or create person
    let personId = await findPersonByContact(params.platform, params.senderId);

    if (!personId) {
      personId = await createPerson(
        params.platform,
        params.senderId,
        params.senderName,
      );
    }

    if (!personId) {
      console.error("[crm-bridge] Failed to find or create person for", params.senderId);
      return;
    }

    // Create timeline activity
    const ok = await createTimelineActivity(personId, {
      ...params,
      direction: "conversation",
    });
    if (ok) {
      console.log(
        `[crm-bridge] Pushed ${params.platform}/${params.senderId} → person ${personId}`,
      );
    }
  } catch (err) {
    console.error("[crm-bridge] Push failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Store an inbound message in the CRM without requiring an agent response.
 * Enables background collection — every message gets logged even if the agent hasn't responded.
 *
 * Fails silently — CRM push should never block message delivery.
 */
export async function pushInboundMessageToCRM(
  params: InboundMessageParams,
): Promise<void> {
  if (!config) return;

  try {
    let personId = await findPersonByContact(params.platform, params.senderId);

    if (!personId) {
      personId = await createPerson(
        params.platform,
        params.senderId,
        params.senderName,
      );
    }

    if (!personId) {
      console.error("[crm-bridge] Failed to find or create person for", params.senderId);
      return;
    }

    const ok = await createTimelineActivity(personId, {
      ...params,
      direction: "inbound",
    });
    if (ok) {
      console.log(
        `[crm-bridge] Inbound ${params.platform}/${params.senderId} → person ${personId}`,
      );
    }
  } catch (err) {
    console.error("[crm-bridge] Inbound push failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Push a gateway event (any dataCategory) to the CRM as a timeline activity.
 * Handles location, read receipts, contacts, groups, reactions, calls, history.
 *
 * Fails silently — CRM push should never block event processing.
 */
export interface GatewayEventParams {
  platform: GatewayPlatform;
  dataCategory: DataCategory;
  senderId: string;
  senderName?: string;
  timestamp: string;
  accountId?: string;
  rawPayload: unknown;
  eventData: Record<string, unknown>;
}

export async function pushGatewayEventToCRM(
  params: GatewayEventParams,
): Promise<void> {
  if (!config) return;

  try {
    let personId = await findPersonByContact(params.platform, params.senderId);

    if (!personId) {
      personId = await createPerson(
        params.platform,
        params.senderId,
        params.senderName,
      );
    }

    if (!personId) {
      console.error("[crm-bridge] Failed to find or create person for", params.senderId);
      return;
    }

    const channelLabel =
      params.platform.charAt(0).toUpperCase() + params.platform.slice(1);
    const categoryLabel = params.dataCategory.replace(/_/g, " ");

    const input = {
      name: `${channelLabel} ${categoryLabel} — ${params.senderName || params.senderId}`,
      happensAt: params.timestamp,
      properties: {
        channel: params.platform,
        dataCategory: params.dataCategory,
        senderId: params.senderId,
        senderName: params.senderName || null,
        accountId: params.accountId || null,
        direction: "inbound",
        ...params.eventData,
      },
      targetPersonId: personId,
    };

    const query = `
      mutation CreateTimelineActivity($input: TimelineActivityCreateInput!) {
        createTimelineActivity(data: $input) {
          id
        }
      }
    `;

    const res = await gqlRequest<{ createTimelineActivity: { id: string } }>(
      query,
      { input },
    );

    if (res.errors && res.errors.length > 0) {
      console.error(
        "[crm-bridge] pushGatewayEvent error:",
        res.errors[0]!.message,
      );
      return;
    }

    console.log(
      `[crm-bridge] Event ${params.dataCategory} ${params.platform}/${params.senderId} → person ${personId}`,
    );
  } catch (err) {
    console.error("[crm-bridge] Event push failed:", err instanceof Error ? err.message : err);
  }
}
