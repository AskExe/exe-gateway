# Gateway Adapters

Unified abstraction for messaging platforms. Each platform implements the `GatewayAdapter` interface.

## Adapters

- **WhatsApp** — Baileys (WhatsApp Web authentication via QR code)
- **Telegram** — Bot API with long-polling (no Grammy dependency)
- **Discord** — REST API + Gateway WebSocket for real-time messages
- **Slack** — Web API + Socket Mode for real-time messages
- **iMessage** — Native macOS integration (AppleScript send + SQLite polling)

## Usage

```typescript
import { createAdapter } from "./adapters/index.js";

const whatsapp = await createAdapter({
  platform: "whatsapp",
  config: { authDir: "/path/to/auth" }
});

// Listen for messages
const stop = await whatsapp.startMonitor(async (msg) => {
  console.log("Received:", msg.content.text);
});

// Send a message
const result = await whatsapp.sendMessage({
  to: "+1234567890",
  content: { text: "Hello!" }
});

// Stop listening
await stop();
```

## Implementation Status

- [x] Interface definition (`gateway-adapter-types.ts`)
- [x] Adapter stubs for all 5 platforms (lightweight, no deps)
- [x] Factory and registry
- [x] WhatsApp Baileys implementation (full — socket injection, debounce, media)
- [x] Telegram implementation (full — long-polling, media send, offset persistence)
- [x] Discord implementation (full — Gateway WebSocket, reconnect, intents)
- [x] Slack implementation (full — Socket Mode, event acknowledgement, thread support)
- [x] iMessage implementation (full — AppleScript send, SQLite poll, macOS-only)
- [ ] Integration tests with live services (requires credentials)
