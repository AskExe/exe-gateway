import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initCRMBridge,
  isCRMBridgeEnabled,
  pushConversationToCRM,
  pushInboundMessageToCRM,
} from "../src/crm-bridge.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeJsonResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    json: () => Promise.resolve(data),
  };
}

const baseParams = {
  platform: "whatsapp" as const,
  senderId: "+1234567890",
  senderName: "Jane Doe",
  messageText: "Hello, I need help",
  agentResponse: "Hi Jane! How can I assist you?",
  agentName: "receptionist",
  timestamp: "2026-04-15T12:00:00Z",
};

describe("crm-bridge", () => {
  beforeEach(() => {
    vi.stubEnv("CRM_API_TOKEN", "test-token-123");
    vi.stubEnv("CRM_GRAPHQL_URL", "http://crm.test:3000");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("initCRMBridge", () => {
    it("enables bridge when CRM_API_TOKEN is set", () => {
      const result = initCRMBridge();
      expect(result).toBe(true);
      expect(isCRMBridgeEnabled()).toBe(true);
    });

    it("disables bridge when CRM_API_TOKEN is missing", () => {
      vi.stubEnv("CRM_API_TOKEN", "");
      delete process.env.CRM_API_TOKEN;
      const result = initCRMBridge();
      expect(result).toBe(false);
      expect(isCRMBridgeEnabled()).toBe(false);
    });

    it("uses default CRM_GRAPHQL_URL when not set", () => {
      delete process.env.CRM_GRAPHQL_URL;
      initCRMBridge();
      expect(isCRMBridgeEnabled()).toBe(true);
    });
  });

  describe("pushConversationToCRM", () => {
    it("skips push when bridge is disabled", async () => {
      delete process.env.CRM_API_TOKEN;
      initCRMBridge();
      await pushConversationToCRM(baseParams);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("finds existing person and creates timeline activity", async () => {
      initCRMBridge();

      // First call: findPerson returns existing person
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: {
            people: {
              edges: [{ node: { id: "person-uuid-1" } }],
            },
          },
        }),
      );

      // Second call: createTimelineActivity
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { createTimelineActivity: { id: "activity-uuid-1" } },
        }),
      );

      await pushConversationToCRM(baseParams);

      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify findPerson query uses phone filter for whatsapp
      const findCall = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(findCall.query).toContain("people");
      expect(findCall.query).toContain("primaryPhoneNumber");

      // Verify timeline activity payload
      const activityCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(activityCall.query).toContain("createTimelineActivity");
      expect(activityCall.variables.input.targetPersonId).toBe("person-uuid-1");
      expect(activityCall.variables.input.properties.channel).toBe("whatsapp");
      expect(activityCall.variables.input.properties.messageText).toBe(baseParams.messageText);
      expect(activityCall.variables.input.properties.agentResponse).toBe(baseParams.agentResponse);
    });

    it("creates new person when not found, then creates activity", async () => {
      initCRMBridge();

      // findPerson: no results
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ data: { people: { edges: [] } } }),
      );

      // createPerson
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ data: { createPerson: { id: "new-person-1" } } }),
      );

      // createTimelineActivity
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { createTimelineActivity: { id: "activity-uuid-2" } },
        }),
      );

      await pushConversationToCRM(baseParams);

      expect(mockFetch).toHaveBeenCalledTimes(3);

      // Verify createPerson uses phone for whatsapp
      const createCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(createCall.query).toContain("createPerson");
      expect(createCall.variables.input.phones.primaryPhoneNumber).toBe("+1234567890");
      expect(createCall.variables.input.name.firstName).toBe("Jane");
      expect(createCall.variables.input.name.lastName).toBe("Doe");
    });

    it("uses email filter for email platform", async () => {
      initCRMBridge();

      const emailParams = {
        ...baseParams,
        platform: "email" as const,
        senderId: "jane@example.com",
      };

      // findPerson by email
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ data: { people: { edges: [] } } }),
      );

      // createPerson with email
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ data: { createPerson: { id: "email-person-1" } } }),
      );

      // createTimelineActivity
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { createTimelineActivity: { id: "activity-3" } },
        }),
      );

      await pushConversationToCRM(emailParams);

      // Verify findPerson uses email filter
      const findCall = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(findCall.query).toContain("primaryEmail");

      // Verify createPerson uses email field
      const createCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(createCall.variables.input.emails.primaryEmail).toBe("jane@example.com");
    });

    it("sends auth header with bearer token", async () => {
      initCRMBridge();

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { people: { edges: [{ node: { id: "p1" } }] } },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { createTimelineActivity: { id: "a1" } },
        }),
      );

      await pushConversationToCRM(baseParams);

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer test-token-123");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("handles GraphQL errors gracefully", async () => {
      initCRMBridge();

      // findPerson returns error → null, then createPerson also errors
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: null,
          errors: [{ message: "Unauthorized" }],
        }),
      );
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: null,
          errors: [{ message: "Unauthorized" }],
        }),
      );

      // Should not throw
      await pushConversationToCRM(baseParams);
      // findPerson fails → createPerson called → also fails → stops
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("handles network errors gracefully", async () => {
      initCRMBridge();

      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      // Should not throw
      await pushConversationToCRM(baseParams);
    });

    it("posts to correct URL from config", async () => {
      initCRMBridge();

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { people: { edges: [{ node: { id: "p1" } }] } },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { createTimelineActivity: { id: "a1" } },
        }),
      );

      await pushConversationToCRM(baseParams);

      expect(mockFetch.mock.calls[0][0]).toBe("http://crm.test:3000/api");
    });

    it("sets direction to 'conversation' in timeline activity", async () => {
      initCRMBridge();

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { people: { edges: [{ node: { id: "p1" } }] } },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { createTimelineActivity: { id: "a1" } },
        }),
      );

      await pushConversationToCRM(baseParams);

      const activityCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(activityCall.variables.input.properties.direction).toBe("conversation");
      expect(activityCall.variables.input.properties.threadId).toBe("whatsapp:+1234567890");
    });

    it("passes accountId through to timeline activity properties", async () => {
      initCRMBridge();

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { people: { edges: [{ node: { id: "p1" } }] } },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { createTimelineActivity: { id: "a1" } },
        }),
      );

      await pushConversationToCRM({ ...baseParams, accountId: "acct-lenny" });

      const activityCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(activityCall.variables.input.properties.accountId).toBe("acct-lenny");
    });
  });

  describe("pushInboundMessageToCRM", () => {
    const inboundParams = {
      platform: "whatsapp" as const,
      senderId: "+1234567890",
      senderName: "Jane Doe",
      messageText: "Hello, I need help",
      timestamp: "2026-04-15T12:00:00Z",
    };

    it("stores message without agent response", async () => {
      initCRMBridge();

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { people: { edges: [{ node: { id: "p1" } }] } },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { createTimelineActivity: { id: "a1" } },
        }),
      );

      await pushInboundMessageToCRM(inboundParams);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const activityCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(activityCall.variables.input.properties.agentResponse).toBeNull();
      expect(activityCall.variables.input.properties.agentName).toBeNull();
      expect(activityCall.variables.input.properties.messageText).toBe(inboundParams.messageText);
    });

    it("creates person if not found", async () => {
      initCRMBridge();

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ data: { people: { edges: [] } } }),
      );
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ data: { createPerson: { id: "new-p1" } } }),
      );
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { createTimelineActivity: { id: "a1" } },
        }),
      );

      await pushInboundMessageToCRM(inboundParams);

      expect(mockFetch).toHaveBeenCalledTimes(3);
      const createCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(createCall.query).toContain("createPerson");
    });

    it("sets direction to 'inbound' in timeline activity", async () => {
      initCRMBridge();

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { people: { edges: [{ node: { id: "p1" } }] } },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { createTimelineActivity: { id: "a1" } },
        }),
      );

      await pushInboundMessageToCRM(inboundParams);

      const activityCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(activityCall.variables.input.properties.direction).toBe("inbound");
    });

    it("sets threadId correctly", async () => {
      initCRMBridge();

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { people: { edges: [{ node: { id: "p1" } }] } },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { createTimelineActivity: { id: "a1" } },
        }),
      );

      await pushInboundMessageToCRM(inboundParams);

      const activityCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(activityCall.variables.input.properties.threadId).toBe("whatsapp:+1234567890");
    });

    it("passes accountId through to properties", async () => {
      initCRMBridge();

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { people: { edges: [{ node: { id: "p1" } }] } },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { createTimelineActivity: { id: "a1" } },
        }),
      );

      await pushInboundMessageToCRM({ ...inboundParams, accountId: "acct-noah" });

      const activityCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(activityCall.variables.input.properties.accountId).toBe("acct-noah");
    });

    it("skips push when bridge is disabled", async () => {
      delete process.env.CRM_API_TOKEN;
      initCRMBridge();
      await pushInboundMessageToCRM(inboundParams);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("handles network errors gracefully", async () => {
      initCRMBridge();
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await pushInboundMessageToCRM(inboundParams);
      // Should not throw
    });
  });
});
