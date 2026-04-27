import { describe, it, expect } from "vitest";
import { CustomerStore } from "../src/customer-store.js";

describe("CustomerStore", () => {
  describe("resolve", () => {
    it("creates new customer on first contact", () => {
      const store = new CustomerStore();
      const customer = store.resolve("whatsapp", "+1-555-1234");
      expect(customer.id).toBeTruthy();
      expect(customer.interactionCount).toBe(1);
      expect(customer.firstSeenAt).toBeTruthy();
    });

    it("returns same customer on repeat contact", () => {
      const store = new CustomerStore();
      const c1 = store.resolve("whatsapp", "+1-555-1234");
      const c2 = store.resolve("whatsapp", "+1-555-1234");
      expect(c1.id).toBe(c2.id);
      expect(c2.interactionCount).toBe(2);
    });

    it("creates different customers for different senders", () => {
      const store = new CustomerStore();
      const c1 = store.resolve("whatsapp", "+1-555-1234");
      const c2 = store.resolve("whatsapp", "+1-555-5678");
      expect(c1.id).not.toBe(c2.id);
    });

    it("creates different customers for different platforms", () => {
      const store = new CustomerStore();
      const c1 = store.resolve("whatsapp", "+1-555-1234");
      const c2 = store.resolve("signal", "+1-555-1234");
      expect(c1.id).not.toBe(c2.id);
    });
  });

  describe("find", () => {
    it("returns undefined for unknown customer", () => {
      const store = new CustomerStore();
      expect(store.find("whatsapp", "+1-555-0000")).toBeUndefined();
    });

    it("returns existing customer", () => {
      const store = new CustomerStore();
      store.resolve("whatsapp", "+1-555-1234");
      const found = store.find("whatsapp", "+1-555-1234");
      expect(found).toBeDefined();
      expect(found!.interactionCount).toBe(1);
    });
  });

  describe("setName / assignEmployee", () => {
    it("sets customer name", () => {
      const store = new CustomerStore();
      const c = store.resolve("whatsapp", "+1-555-1234");
      store.setName(c.id, "Sarah");
      expect(c.name).toBe("Sarah");
    });

    it("assigns employee", () => {
      const store = new CustomerStore();
      const c = store.resolve("whatsapp", "+1-555-1234");
      store.assignEmployee(c.id, "support-bot");
      expect(c.assignedEmployee).toBe("support-bot");
    });
  });

  describe("buildContext", () => {
    it("returns undefined for first interaction", () => {
      const store = new CustomerStore();
      const c = store.resolve("whatsapp", "+1-555-1234");
      expect(store.buildContext(c)).toBeUndefined();
    });

    it("returns context for returning customer", () => {
      const store = new CustomerStore();
      store.resolve("whatsapp", "+1-555-1234");
      const c = store.resolve("whatsapp", "+1-555-1234");
      const ctx = store.buildContext(c);
      expect(ctx).toContain("Returning customer");
      expect(ctx).toContain("#2");
    });

    it("includes name when set", () => {
      const store = new CustomerStore();
      const c = store.resolve("whatsapp", "+1-555-1234");
      store.setName(c.id, "Sarah");
      store.resolve("whatsapp", "+1-555-1234");
      const ctx = store.buildContext(c);
      expect(ctx).toContain("Sarah");
    });
  });

  describe("count", () => {
    it("tracks customer count", () => {
      const store = new CustomerStore();
      expect(store.count()).toBe(0);
      store.resolve("whatsapp", "+1-555-1234");
      expect(store.count()).toBe(1);
      store.resolve("whatsapp", "+1-555-1234"); // same customer
      expect(store.count()).toBe(1);
      store.resolve("signal", "+1-555-5678");
      expect(store.count()).toBe(2);
    });
  });
});
