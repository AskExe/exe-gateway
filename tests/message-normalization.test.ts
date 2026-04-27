import { describe, it, expect, vi } from "vitest";
import type { NormalizedMessage } from "../src/types.js";

// ---------------------------------------------------------------------------
// WhatsApp (Baileys) — normalizes via injectMessage is no-op, test via socket
// The Baileys adapter receives messages via socket events, not injectMessage.
// We test the Telegram/Discord/Slack/iMessage injectMessage normalization.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

describe("TelegramAdapter — message normalization", () => {
  it("normalizes a text message", async () => {
    const { TelegramAdapter } = await import("../src/adapters/telegram.js");
    const adapter = new TelegramAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.injectMessage({
      message: {
        message_id: 42,
        from: { id: 123, first_name: "Alice", last_name: "W" },
        chat: { id: 456, type: "private" },
        text: "Hello from Telegram",
        date: 1700000000,
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0].platform).toBe("telegram");
    expect(received[0].senderId).toBe("123");
    expect(received[0].senderName).toBe("Alice W");
    expect(received[0].channelId).toBe("456");
    expect(received[0].chatType).toBe("direct");
    expect(received[0].text).toBe("Hello from Telegram");
    expect(received[0].messageId).toBe("42");
  });

  it("normalizes a group message", async () => {
    const { TelegramAdapter } = await import("../src/adapters/telegram.js");
    const adapter = new TelegramAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.injectMessage({
      message: {
        message_id: 99,
        from: { id: 10, first_name: "Bob" },
        chat: { id: -100, type: "supergroup" },
        text: "Group msg",
        date: 1700000000,
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0].chatType).toBe("group");
    expect(received[0].channelId).toBe("-100");
  });

  it("normalizes a reply", async () => {
    const { TelegramAdapter } = await import("../src/adapters/telegram.js");
    const adapter = new TelegramAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.injectMessage({
      message: {
        message_id: 50,
        from: { id: 1 },
        chat: { id: 2, type: "private" },
        text: "Replying",
        date: 1700000000,
        reply_to_message: {
          message_id: 49,
          text: "Original",
          from: { id: 3 },
        },
      },
    });

    expect(received[0].replyTo).toEqual({
      messageId: "49",
      text: "Original",
      senderId: "3",
    });
  });

  it("skips messages without text or chat", async () => {
    const { TelegramAdapter } = await import("../src/adapters/telegram.js");
    const adapter = new TelegramAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.injectMessage({ update_id: 1 });
    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

describe("DiscordAdapter — message normalization", () => {
  it("normalizes a DM", async () => {
    const { DiscordAdapter } = await import("../src/adapters/discord.js");
    const adapter = new DiscordAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.injectMessage({
      id: "msg-001",
      content: "Hello Discord",
      author: { id: "user-1", username: "alice", bot: false },
      channel_id: "ch-1",
      guild_id: null,
      timestamp: "2026-04-15T00:00:00.000Z",
    });

    expect(received).toHaveLength(1);
    expect(received[0].platform).toBe("discord");
    expect(received[0].senderId).toBe("user-1");
    expect(received[0].senderName).toBe("alice");
    expect(received[0].channelId).toBe("ch-1");
    expect(received[0].chatType).toBe("direct");
    expect(received[0].text).toBe("Hello Discord");
  });

  it("normalizes a guild message as group", async () => {
    const { DiscordAdapter } = await import("../src/adapters/discord.js");
    const adapter = new DiscordAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.injectMessage({
      id: "msg-002",
      content: "Server msg",
      author: { id: "user-2", username: "bob", bot: false },
      channel_id: "ch-2",
      guild_id: "guild-1",
      timestamp: "2026-04-15T00:00:00.000Z",
    });

    expect(received[0].chatType).toBe("group");
  });

  it("skips bot messages", async () => {
    const { DiscordAdapter } = await import("../src/adapters/discord.js");
    const adapter = new DiscordAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.injectMessage({
      id: "msg-003",
      content: "Bot says hi",
      author: { id: "bot-1", username: "mybot", bot: true },
      channel_id: "ch-1",
    });

    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

describe("SlackAdapter — message normalization", () => {
  it("normalizes a channel message", async () => {
    const { SlackAdapter } = await import("../src/adapters/slack.js");
    const adapter = new SlackAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.injectMessage({
      text: "Hello Slack",
      user: "U123",
      channel: "C456",
      ts: "1700000000.000100",
      channel_type: "channel",
    });

    expect(received).toHaveLength(1);
    expect(received[0].platform).toBe("slack");
    expect(received[0].senderId).toBe("U123");
    expect(received[0].channelId).toBe("C456");
    expect(received[0].chatType).toBe("group");
    expect(received[0].text).toBe("Hello Slack");
  });

  it("normalizes a DM", async () => {
    const { SlackAdapter } = await import("../src/adapters/slack.js");
    const adapter = new SlackAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.injectMessage({
      text: "DM text",
      user: "U789",
      channel: "D001",
      ts: "1700000001.000200",
      channel_type: "im",
    });

    expect(received[0].chatType).toBe("direct");
  });

  it("includes thread ID", async () => {
    const { SlackAdapter } = await import("../src/adapters/slack.js");
    const adapter = new SlackAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.injectMessage({
      text: "Thread reply",
      user: "U1",
      channel: "C1",
      ts: "1700000002.000300",
      thread_ts: "1700000000.000100",
      channel_type: "channel",
    });

    expect(received[0].threadId).toBe("1700000000.000100");
  });

  it("skips events without text", async () => {
    const { SlackAdapter } = await import("../src/adapters/slack.js");
    const adapter = new SlackAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.injectMessage({ user: "U1", channel: "C1" });
    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// iMessage
// ---------------------------------------------------------------------------

describe("IMessageAdapter — message normalization", () => {
  it("normalizes a direct message", async () => {
    const { IMessageAdapter } = await import("../src/adapters/imessage.js");
    const adapter = new IMessageAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.injectMessage({
      guid: "msg-abc",
      sender: "+15551234567",
      text: "Hello from iMessage",
      timestamp: "2026-04-15T00:00:00.000Z",
    });

    expect(received).toHaveLength(1);
    expect(received[0].platform).toBe("imessage");
    expect(received[0].senderId).toBe("+15551234567");
    expect(received[0].text).toBe("Hello from iMessage");
    expect(received[0].chatType).toBe("direct");
    expect(received[0].messageId).toBe("msg-abc");
  });

  it("normalizes using 'from' field as fallback", async () => {
    const { IMessageAdapter } = await import("../src/adapters/imessage.js");
    const adapter = new IMessageAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.injectMessage({
      id: "msg-def",
      from: "user@example.com",
      text: "Email handle",
    });

    expect(received).toHaveLength(1);
    expect(received[0].senderId).toBe("user@example.com");
    expect(received[0].senderEmail).toBe("user@example.com");
  });

  it("normalizes a group message", async () => {
    const { IMessageAdapter } = await import("../src/adapters/imessage.js");
    const adapter = new IMessageAdapter();
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.injectMessage({
      guid: "msg-group",
      sender: "+15559876543",
      text: "Group chat",
      chat_id: "42",
      is_group: true,
    });

    expect(received[0].chatType).toBe("group");
    expect(received[0].channelId).toBe("42");
  });
});
