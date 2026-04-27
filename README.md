# exe-gateway

Standalone webhook server + messaging gateway for multi-platform bot deployment.

## Supported Platforms

| Platform | Adapter | Status |
|----------|---------|--------|
| WhatsApp | Baileys (Web protocol) | Production |
| Telegram | Grammy | Production |
| Discord | discord.js / Carbon | Production |
| Slack | Bolt / Web API | Production |
| Email | Nodemailer + IMAP | Production |
| iMessage | macOS native | Beta |
| Signal | signal-cli | Beta |
| Webchat | WebSocket | Production |
| Webhook | Generic HTTP | Production |

## Quick Start

```bash
npm install
npm run build
cp deploy/.env.example ~/.exe-os/gateway.json
node dist/bin/exe-gateway.js
```

## Configuration

Config lives at `~/.exe-os/gateway.json`. See `deploy/.env.example` for all options.

## Hooks (Integration with exe-os)

exe-gateway is standalone by default. To integrate with exe-os, inject hooks at startup:

```typescript
import { setHooks } from "@askexenow/exe-gateway";
import { orgBus } from "@askexenow/exe-os/dist/lib/state-bus.js";
import { ingest } from "@askexenow/exe-os/dist/lib/pipeline-router.js";

setHooks({
  onEvent: (event) => orgBus.emit(event),
  onIngest: (msg) => ingest(msg),
});
```

## License

MIT
