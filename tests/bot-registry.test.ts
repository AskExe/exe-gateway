import { describe, it, expect } from "vitest";
import { BotRegistry } from "../src/bot-registry.js";
import { createSignupBot } from "../src/bot-templates/signup-bot.js";

describe("BotRegistry", () => {
  it("registers a bot from template", () => {
    const registry = new BotRegistry();
    registry.register(createSignupBot(), "test-key");
    expect(registry.has("signup-bot")).toBe(true);
    expect(registry.get("signup-bot")).toBeDefined();
  });

  it("returns undefined for unregistered bot", () => {
    const registry = new BotRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("lists registered bot names", () => {
    const registry = new BotRegistry();
    registry.register(createSignupBot(), "test-key");
    expect(registry.list()).toEqual(["signup-bot"]);
  });

  it("registers multiple bots", () => {
    const registry = new BotRegistry();
    registry.register(createSignupBot(), "test-key");

    const names = registry.list();
    expect(names).toContain("signup-bot");
  });
});
