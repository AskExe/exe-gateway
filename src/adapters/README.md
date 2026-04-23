# Gateway Adapters

Multi-platform message adapters for exe-os gateway. Each adapter normalizes incoming messages from a platform into `NormalizedMessage` format and handles outgoing message delivery.

## Supported Platforms

### WhatsApp (Cloud API)
- **Package:** Meta Graph API v21.0
- **Auth:** Phone number ID + Access token (webhook verify token for inbound)
- **Features:** Text, images, documents, audio, video, reactions
- **State:** Multi-account via `~/.exe-os/whatsapp-accounts.json`
- **File:** `whatsapp.ts`

### Telegram (Bot API)
- **Package:** `grammy@^1.41.1`, `@grammyjs/runner@^2.0.3`, `@grammyjs/transformer-throttler@^1.2.1`
- **Auth:** Bot token (from BotFather)
- **Features:** Text, images, documents, audio, video, voice notes, inline buttons, topics, silent mode
- **State:** Update offset tracking via `~/.openclaw/state/telegram/`
- **Modes:** Polling (default) or webhook
- **File:** `telegram.ts`

### Discord (Bot API)
- **Package:** `@buape/carbon@0.0.0-beta-20260317045421`, `discord-api-types@^0.38.42`, `@discordjs/voice@^0.19.2`
- **Auth:** Bot token (Discord Developer Portal)
- **Features:** Text, embeds, components, threads, reactions, moderation, roles
- **State:** Ephemeral (WebSocket connection)
- **Connection:** WebSocket gateway
- **File:** `discord.ts`

### iMessage (RPC)
- **Package:** None (spawned process)
- **Auth:** Local system access (macOS only)
- **Features:** Text messages to handles or chat groups
- **State:** Messages database on disk
- **Protocol:** JSON-RPC 2.0 over stdio
- **CLI:** External `imsg` tool required
- **File:** `imessage.ts`

### Slack (Socket Mode)
- **Package:** `@slack/bolt@^4.6.0`, `@slack/web-api@^7.15.0`
- **Auth:** Bot token + App token (Socket Mode)
- **Features:** Rich messages, blocks, attachments, threads, reactions, file uploads
- **State:** Stateless (tokens in config)
- **Connection:** Socket Mode (no webhook required)
- **File:** `slack.ts`

## Adapter Interface

All adapters implement `PlatformAdapter`:

```typescript
interface PlatformAdapter {
  platform: GatewayPlatform;
  connect(config: PlatformConfig): Promise<void>;
  disconnect(): Promise<void>;
  send(to: string, message: string, options?: SendOptions): Promise<{ messageId: string }>;
  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void;
  isHealthy(): Promise<boolean>;
  getStatus(): { connected: boolean; platform: string };
}
```

## Configuration

Each adapter is configured via `~/.exe-os/gateway.json`:

```json
{
  "adapters": {
    "telegram": {
      "enabled": true,
      "credentials": {
        "bot_token": "YOUR_BOT_TOKEN"
      }
    },
    "discord": {
      "enabled": true,
      "credentials": {
        "bot_token": "YOUR_BOT_TOKEN"
      }
    },
    "slack": {
      "enabled": true,
      "credentials": {
        "bot_token": "xoxb-...",
        "app_token": "xapp-..."
      }
    },
    "imessage": {
      "enabled": true,
      "credentials": {
        "cli_path": "imsg",
        "db_path": "~/Library/Messages/chat.db"
      }
    }
  }
}
```

## Message Normalization

All adapters convert platform-specific messages into `NormalizedMessage`:

```typescript
interface NormalizedMessage {
  id: string;
  platform: GatewayPlatform;
  sender: { id: string; name: string; isBot: boolean };
  channel: { id: string; type: "private" | "group"; name: string };
  text: string;
  timestamp: Date;
  raw: unknown; // Platform-specific data
}
```

## Outbound Message Handling

Adapters support sending text and media via `send()`:

```typescript
send(to: string, message: string, options?: SendOptions): Promise<{ messageId: string }>
```

`SendOptions` includes:
- `replyToMessageId`: Reply to specific message (threading)
- `mediaUrl`: URL to attach media (image, video, document, audio)

## Implementation Notes

### Grammy (Telegram)
- Uses `Bot` class for message handling
- Supports both polling and webhook modes
- Auto-formats HTML/Markdown
- Thread support via `messageThreadId` for forum topics

### Carbon (Discord)
- Direct Discord API v10 calls via fetch
- WebSocket connection managed by Consumer
- Thread/reply support via `thread_ts`
- Permission-aware message sending

### Slack Bolt
- Socket Mode for real-time events (no webhook required)
- Dual-token support (bot + user for elevated permissions)
- Interactive components via Block Kit
- Channel type inference from config + API

### iMessage RPC
- Spawns `imsg` CLI process on demand
- JSON-RPC 2.0 protocol over stdio
- Pending request tracking with timeout
- Notification handler for inbound messages
- Requires macOS with iMessage database access

## Testing

Each adapter can be tested in isolation:

```bash
# Telegram
node -e "import('./dist/gateway/adapters/telegram.js').then(m => new m.TelegramAdapter())"

# Discord
node -e "import('./dist/gateway/adapters/discord.js').then(m => new m.DiscordAdapter())"

# Slack
node -e "import('./dist/gateway/adapters/slack.js').then(m => new m.SlackAdapter())"

# iMessage
node -e "import('./dist/gateway/adapters/imessage.js').then(m => new m.IMessageAdapter())"
```

## Future Enhancements

- [ ] Media handling for all adapters (download/cache/serve)
- [ ] Batch message support (e.g., `sendMany()`)
- [ ] Edit/delete message support
- [ ] Rich reactions (emoji, custom)
- [ ] Read receipt tracking
- [ ] Typing indicators
- [ ] Connection pooling for high-volume adapters
