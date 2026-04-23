# Gateway Adapters

Unified abstraction for messaging platforms. Each platform implements the `GatewayAdapter` interface.

## Adapters

- **WhatsApp** — Baileys (WhatsApp Web authentication via QR code)
- **Telegram** — Grammy (Telegram Bot API with polling/webhook support)
- **Discord** — @buape/carbon (Discord bot with gateway intents)
- **Slack** — @slack/bolt (Slack app with Socket Mode)
- **iMessage** — Native macOS integration (BlueBubbles or direct SQLite access)

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

- [x] Interface definition (`gateway-adapter.ts`)
- [x] Adapter stubs for all 5 platforms
- [x] Factory and registry
- [ ] WhatsApp Baileys implementation (full)
- [ ] Telegram Grammy implementation (full)
- [ ] Discord Carbon implementation (full)
- [ ] Slack Bolt implementation (full)
- [ ] iMessage implementation (full)
- [ ] Integration tests
- [ ] Message routing and dispatch logic
