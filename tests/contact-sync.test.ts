import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initCRMBridge } from "../src/crm-bridge.js";
import { ensureCRMContact } from "../src/contact-sync.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeJsonResponse(data: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Internal Server Error",
    json: () => Promise.resolve(data),
  };
}

describe("contact-sync", () => {
  beforeEach(() => {
    vi.stubEnv("CRM_API_TOKEN", "test-token-123");
    vi.stubEnv("CRM_GRAPHQL_URL", "http://crm.test:3000");
    initCRMBridge();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("ensureCRMContact", () => {
    it("returns person ID when person exists", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          data: { people: { edges: [{ node: { id: "existing-person-1" } }] } },
        }),
      );

      const id = await ensureCRMContact({
        platform: "whatsapp",
        senderId: "+1234567890",
        senderName: "Jane Doe",
      });

      expect(id).toBe("existing-person-1");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("creates person when not found", async () => {
      // findPerson: no results
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ data: { people: { edges: [] } } }),
      );
      // createPerson
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ data: { createPerson: { id: "new-person-1" } } }),
      );

      const id = await ensureCRMContact({
        platform: "whatsapp",
        senderId: "+1234567890",
        senderName: "Jane Doe",
      });

      expect(id).toBe("new-person-1");
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const createCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(createCall.variables.input.name.firstName).toBe("Jane");
      expect(createCall.variables.input.name.lastName).toBe("Doe");
    });

    it("uses WhatsApp profile name when available", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ data: { people: { edges: [] } } }),
      );
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ data: { createPerson: { id: "wp-person-1" } } }),
      );

      await ensureCRMContact({
        platform: "whatsapp",
        senderId: "+9876543210",
        senderName: "WhatsApp User",
      });

      const createCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(createCall.variables.input.name.firstName).toBe("WhatsApp");
      expect(createCall.variables.input.name.lastName).toBe("User");
    });

    it("uses fallback name for unknown sender", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ data: { people: { edges: [] } } }),
      );
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ data: { createPerson: { id: "unknown-person-1" } } }),
      );

      await ensureCRMContact({
        platform: "whatsapp",
        senderId: "+5555555555",
        // No senderName provided
      });

      const createCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      // Fallback name: "Unknown (+5555555555)"
      expect(createCall.variables.input.name.firstName).toBe("Unknown");
      expect(createCall.variables.input.name.lastName).toBe("(+5555555555)");
    });

    it("fails silently on error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const id = await ensureCRMContact({
        platform: "whatsapp",
        senderId: "+1234567890",
      });

      expect(id).toBeNull();
    });
  });
});
