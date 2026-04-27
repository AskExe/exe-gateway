<p align="center">
  <strong>exe-gateway</strong><br>
  Standalone multi-platform messaging gateway with human-like sending behavior.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node 20+">
  <img src="https://img.shields.io/badge/platforms-10-orange.svg" alt="10 Platforms">
</p>

---

exe-gateway is a self-hosted messaging gateway that connects WhatsApp, Telegram, Discord, Slack, Email, iMessage, Signal, Webchat, and Webhooks behind a single REST API. It handles rate limiting, typing simulation, and multi-account support out of the box — so your messages look human, not automated.

## Features

| Feature | Details |
|---------|---------|
| **10 platform adapters** | WhatsApp (Baileys), Telegram (Grammy), Discord, Slack, Email (SMTP/IMAP), iMessage, Signal, Webchat, Webhook, CRM |
| **Multi-account** | Unlimited numbers per platform. Each account gets its own session and rate limiter. |
| **Human-like sending** | Typing simulation, randomized delays between messages, per-recipient pacing. |
| **Anti-ban rate limiting** | Per-platform hourly/daily caps tuned to each platform's tolerance. |
| **Full history sync** | First WhatsApp link pulls complete message history. |
| **REST API** | Send messages, list groups, check contacts, view rate limits, health checks. |
| **One-command install** | Single `curl` command sets up Node.js, clones the repo, builds, configures systemd. |
| **Production-ready** | Systemd service, nginx config, Docker support, security-hardened. |
| **Standalone** | Works on its own. Optional hooks for [Exe OS](https://github.com/AskExe/exe-os) integration. |

## Quick Start

### One-command install (VPS — Ubuntu 22.04+ / Debian 12+)

```bash
curl -fsSL https://raw.githubusercontent.com/AskExe/exe-gateway/main/install.sh | bash
```

This installs Node.js 20, clones the repo to `/opt/exe-gateway`, builds from source, creates a system user, generates an auth token, and sets up the systemd service.

### Pair WhatsApp

```bash
node /opt/exe-gateway/pair-whatsapp.mjs my-account +1234567890
```

Scan the QR code with WhatsApp on your phone. The session persists across restarts.

### Start the service

```bash
systemctl start exe-gateway
```

### Verify

```bash
curl -H "Authorization: Bearer <your-token>" http://localhost:3100/health
```

The auth token is printed during installation and stored in `/opt/exe-gateway/.env`.

### Manual install (any platform)

```bash
git clone https://github.com/AskExe/exe-gateway.git
cd exe-gateway
npm install
npm run build
cp deploy/.env.example ~/.exe-os/gateway.json  # Edit with your config
node dist/bin/exe-gateway.js
```

## WhatsApp IP Safety

> **Running on a local machine (laptop, home server, office network)?**
>
> You're already on a residential IP — **skip this section entirely**. Tailscale is not needed. Just install, pair, and go.

WhatsApp actively detects and bans datacenter IP addresses. If you're running exe-gateway on a VPS or cloud server (AWS, DigitalOcean, Hostinger, Hetzner, etc.), you must route WhatsApp traffic through a residential IP.

### Why this matters

Connecting WhatsApp directly from a datacenter IP will trigger verification loops or outright bans. This is WhatsApp's anti-automation measure — it flags IPs that belong to known hosting providers.

### Solution A: SOCKS proxy (recommended)

Route only WhatsApp traffic through your home machine via a lightweight SOCKS5 proxy over Tailscale. This avoids routing ALL VPS traffic through the exit node, which can break Cloudflare and other services.

```
VPS (Cloud/Datacenter)                Home Machine
┌─────────────────────────┐           ┌─────────────────────────┐
│  exe-gateway             │           │  microsocks (SOCKS5)     │
│  Baileys + SocksProxy    │◄─────────►│  bound to Tailscale IP   │
│  (only WhatsApp traffic) │ Tailscale │  (residential IP)        │
└─────────────────────────┘  mesh     └─────────────────────────┘
                                                ↓
                                        WhatsApp servers
                                        see: residential IP
```

**1. Install a SOCKS5 proxy on your home machine:**

```bash
# macOS
brew install microsocks
microsocks -i $(tailscale ip -4) -p 1080 &

# Linux
apt install microsocks
microsocks -i $(tailscale ip -4) -p 1080 &
```

**2. Configure exe-gateway to use the proxy:**

```bash
# In .env
WHATSAPP_PROXY_URL=socks5://<home-tailscale-ip>:1080
```

**3. Verify:**

```bash
# From VPS — should show your home IP
curl --socks5-hostname <home-tailscale-ip>:1080 https://ifconfig.me
```

### Solution B: Tailscale exit node (simpler but routes all traffic)

Route ALL VPS traffic through a home machine using Tailscale's exit node feature. Simpler setup but can interfere with Cloudflare, nginx, and other services on the VPS.

```bash
# Home machine
tailscale up --advertise-exit-node

# VPS
tailscale set --exit-node=<home-machine-name>

# Verify
curl -s ifconfig.me  # Should show HOME IP
```

**Warning:** Exit node routes all traffic, including return paths for inbound connections. If your VPS serves websites behind Cloudflare or a reverse proxy, use Solution A instead.

See [`docs/tailscale-exit-node.md`](docs/tailscale-exit-node.md) for troubleshooting, DNS issues, firewall config, and keeping the exit node online.

## Multi-Account Configuration

Config lives at `~/.exe-os/gateway.json`. Each platform supports multiple accounts with independent sessions and rate limiters.

```json
{
  "port": 3100,
  "authToken": "your-secret-token",
  "adapters": {
    "whatsapp": {
      "enabled": true,
      "accounts": [
        {
          "name": "sales",
          "authDir": "/home/exe/.exe-os/.auth/whatsapp-sales"
        },
        {
          "name": "support",
          "authDir": "/home/exe/.exe-os/.auth/whatsapp-support"
        }
      ]
    },
    "telegram": {
      "enabled": true,
      "accounts": [
        {
          "name": "main-bot",
          "botToken": "123456:ABC-DEF..."
        }
      ]
    },
    "discord": {
      "enabled": true,
      "accounts": [
        {
          "name": "community-bot",
          "botToken": "your-discord-token",
          "applicationId": "your-app-id"
        }
      ]
    },
    "slack": {
      "enabled": true,
      "accounts": [
        {
          "name": "workspace-bot",
          "botToken": "xoxb-...",
          "appToken": "xapp-..."
        }
      ]
    },
    "email": {
      "enabled": true,
      "accounts": [
        {
          "name": "notifications",
          "smtpHost": "smtp.example.com",
          "smtpPort": 587,
          "smtpUser": "bot@example.com",
          "smtpPass": "your-password",
          "from": "bot@example.com"
        }
      ]
    }
  }
}
```

Pair each WhatsApp account separately:

```bash
node /opt/exe-gateway/pair-whatsapp.mjs sales +1234567890
node /opt/exe-gateway/pair-whatsapp.mjs support +0987654321
```

## API Reference

All endpoints require the `Authorization: Bearer <token>` header (except `/health`).

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server health, uptime, registered platforms |
| `POST` | `/api/send` | Send a message (rate-limited, with typing simulation) |
| `GET` | `/api/groups` | List WhatsApp groups |
| `GET` | `/api/group/:id` | Group metadata + participants |
| `GET` | `/api/limits` | Rate limit stats per platform |
| `POST` | `/webhook/:platform` | Incoming webhook payload from external platform |

### Send a message

```bash
curl -X POST http://localhost:3100/api/send \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "whatsapp",
    "account": "sales",
    "to": "+1234567890",
    "text": "Hey — just following up on our conversation."
  }'
```

The message enters the outbound queue and is sent with realistic typing simulation and randomized delay. You don't need to manage pacing — the limiter handles it.

### List groups

```bash
curl -H "Authorization: Bearer <token>" http://localhost:3100/api/groups
```

### Check rate limits

```bash
curl -H "Authorization: Bearer <token>" http://localhost:3100/api/limits
```

## Rate Limiting

Outbound messages are paced per-platform with human-like timing. These are the defaults — tuned to avoid platform bans:

| Platform | Per Hour | Per Day | Typing Simulation | Delay Between Messages |
|----------|----------|---------|-------------------|----------------------|
| WhatsApp | 30 | 200 | 1.5–8s (25 cps) | 5–15s per recipient |
| Telegram | 60 | 500 | 1–5s (40 cps) | 2–8s per recipient |
| Discord | 120 | 1,000 | 0.5–4s (50 cps) | 1–5s per recipient |
| Slack | 120 | 1,000 | 0.5–4s (50 cps) | 1–5s per recipient |
| Email | 20 | 100 | None | 10–30s per recipient |

Inbound messages are also rate-limited: 10 req/s per sender, 100 req/s global (sliding window).

## Auto-Reply

Automatic replies for incoming messages — **disabled by default**, allowlist-gated, with 8 safety gates to prevent spam.

Add to `gateway.json`:

```json
{
  "autoReply": {
    "enabled": true,
    "message": "Received. We'll get back to you shortly.",
    "allowGroups": ["120363428671509944@g.us"],
    "allowContacts": ["+16179354486"],
    "cooldownHours": 24,
    "dailyCap": 20,
    "dmOnly": false
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `false` | Master switch. No replies sent unless explicitly `true`. |
| `message` | `"Received."` | Text to send as the auto-reply. |
| `allowGroups` | `[]` | Only reply in these group JIDs. Empty = no group replies. |
| `allowContacts` | `[]` | Only reply to these phone numbers/JIDs. Empty = no DM replies. |
| `cooldownHours` | `24` | Minimum hours between replies to the same contact. |
| `dailyCap` | `20` | Maximum total auto-replies per day across all contacts. |
| `dmOnly` | `false` | If `true`, blocks all group replies regardless of `allowGroups`. |

**Safety gates (always enforced, not configurable):**

1. Must be explicitly enabled (default OFF)
2. Never replies to historical/sync messages
3. Never replies to your own messages
4. Never replies to empty or system messages
5. Never replies to read receipts, reactions, or calls
6. Only replies to allowlisted groups or contacts (must have at least one allowlist)
7. Per-contact cooldown (default 24h)
8. Daily cap (default 20)

Auto-replies include a random 3–15 second delay and typing indicator simulation to appear human.

## Data Ingestion Adapters

exe-gateway serves as the data ingestion layer for the Exe platform. It runs API adapters (cron or webhook) that pull data from clients' external systems and stage it for routing into the wiki and CRM.

### How it works

```
External APIs → exe-gateway adapters → staging.raw_imports → (routing handled downstream)
```

The gateway's job is to **pull and stage** — it does not route data into wiki or CRM schemas. Routing happens in a separate transform step after staging.

### Adapter lifecycle

1. Adapter runs on a configurable schedule (cron: 15min / hourly / daily)
2. Checks `staging.sync_cursors` for the last pull position per source
3. Pulls new/updated records from the external API
4. Writes raw JSON to `staging.raw_imports` (same Postgres instance, `staging` schema)
5. Updates `sync_cursors` with the new position

For platforms that support it (Stripe, Asana), webhooks provide real-time ingestion alongside cron-based pulls.

### Supported adapters (current / planned)

| Adapter | Protocol | Status |
|---------|----------|--------|
| Xero | OAuth 2.0 REST | Planned |
| Stripe | REST + Webhooks | Planned |
| Asana | REST + Webhooks | Planned |
| Banking APIs | Open Banking REST | Planned |
| QuickBooks | OAuth 2.0 REST | Planned |

### Configuration

Each adapter is configured via environment variables:

```bash
# Example: Xero adapter
XERO_CLIENT_ID=your-client-id
XERO_CLIENT_SECRET=your-client-secret
XERO_TENANT_ID=your-tenant-id
XERO_SYNC_INTERVAL=hourly    # 15min | hourly | daily
```

### Related repos

- **[exe-wiki/ARCHITECTURE.md](https://github.com/AskExe/exe-wiki/blob/master/ARCHITECTURE.md)** — Full staging/routing architecture, schema definitions, routing rules
- **[exe-crm](https://github.com/AskExe/exe-crm)** — CRM-side entity mapping and how routed data lands in contacts/deals/activities

---

## Integration with Exe OS (Optional)

exe-gateway is fully standalone. To integrate with [Exe OS](https://github.com/AskExe/exe-os) for memory, wiki, and CRM hooks:

```typescript
import { setHooks } from "@askexenow/exe-gateway";
import { orgBus } from "@askexenow/exe-os/dist/lib/state-bus.js";
import { ingest } from "@askexenow/exe-os/dist/lib/pipeline-router.js";

setHooks({
  onEvent: (event) => orgBus.emit(event),
  onIngest: (msg) => ingest(msg),
});
```

This pipes all incoming messages through the Exe OS memory pipeline and broadcasts events to the organization bus.

## Deployment

### Systemd (recommended for VPS)

The installer sets this up automatically. To configure manually:

```bash
cp exe-gateway.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now exe-gateway
```

View logs:

```bash
journalctl -u exe-gateway -f
```

The service runs as a dedicated `exe` system user with security hardening (read-only filesystem, private tmp, no new privileges, 512MB memory cap).

### Nginx reverse proxy

For SSL termination and public-facing deployments:

```bash
cp nginx-gateway.conf /etc/nginx/sites-available/gateway.yourdomain.com
ln -s /etc/nginx/sites-available/gateway.yourdomain.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

Includes rate limiting (10 req/s webhooks, 5 conn/s WebSocket), CORS headers, and WebSocket upgrade support.

### Docker

```bash
docker build -t exe-gateway .
docker run -d \
  --name exe-gateway \
  -p 3100:3100 \
  -p 3101:3101 \
  -v ~/.exe-os:/home/exegateway/.exe-os \
  exe-gateway
```

## Platform Adapters

| Platform | Library | Status | Notes |
|----------|---------|--------|-------|
| WhatsApp | Baileys (Web protocol) | Production | Multi-account, full history sync, QR pairing |
| Telegram | Grammy | Production | Bot API, inline keyboards, media |
| Discord | discord.js | Production | Slash commands, threads, embeds |
| Slack | Bolt + Web API | Production | Socket Mode, interactive messages |
| Email | Nodemailer + IMAP | Production | SMTP outbound, IMAP inbound |
| iMessage | macOS native | Beta | Requires macOS host |
| Signal | signal-cli | Beta | Requires signal-cli daemon |
| Webchat | WebSocket | Production | Browser widget, real-time |
| Webhook | Generic HTTP | Production | Any platform via HTTP POST |
| CRM | Exe CRM bridge | Production | Bi-directional contact/deal sync |

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes with tests
4. Run `npm test` and `npm run typecheck`
5. Open a PR

## License

[MIT](LICENSE)
