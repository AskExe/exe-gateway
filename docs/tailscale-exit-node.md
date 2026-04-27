# Tailscale Exit Node Setup for exe-gateway

## Why

WhatsApp detects and flags datacenter IP addresses. Connections from cloud VPS providers (Hostinger, AWS, DigitalOcean, etc.) often trigger verification loops or outright bans.

The fix: route the VPS's outbound traffic through a **residential IP** using Tailscale's exit node feature. WhatsApp sees a normal home internet connection instead of a datacenter.

## Architecture

```
VPS (Hostinger/Jakarta)          Home (Mac/Linux/Router)
┌─────────────────────┐          ┌─────────────────────┐
│  exe-gateway         │          │  Tailscale           │
│  ↓                   │          │  exit node           │
│  Tailscale client    │◄────────►│  ↓                   │
│  --exit-node=home    │  WireGuard│  Home ISP router     │
│                      │  tunnel   │  (residential IP)    │
└─────────────────────┘          └─────────────────────┘
                                          ↓
                                   WhatsApp servers
                                   see: residential IP
```

All WhatsApp traffic from the VPS flows through the encrypted Tailscale mesh to
the home machine, then exits to the internet via the home ISP. WhatsApp sees the
residential IP, not the datacenter IP.

## Setup

### Step 1: Create a Tailscale account

Sign up at [tailscale.com](https://tailscale.com). Free tier supports up to 100 devices.

### Step 2: Install Tailscale on the home machine (exit node)

This is the machine with the residential IP. Can be a Mac, Linux box, or router.

**macOS:**
```bash
# Install via Homebrew
brew install tailscale

# Or download from https://tailscale.com/download/mac

# Start and advertise as exit node
sudo tailscaled &
tailscale up --advertise-exit-node
```

**Linux:**
```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --advertise-exit-node
```

**Router (advanced):**
Some routers support Tailscale natively (GL.iNet, OPNsense, pfSense).
Check [tailscale.com/kb/1019/subnets](https://tailscale.com/kb/1019/subnets) for router-specific guides.

### Step 3: Approve the exit node in Tailscale admin

1. Go to [login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines)
2. Find the home machine
3. Click the three-dot menu > **Edit route settings**
4. Toggle **Use as exit node** to ON
5. Save

### Step 4: Install Tailscale on the VPS

The installer script (`install.sh`) already handles this. If installing manually:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
```

Authenticate by visiting the URL printed in the terminal.

### Step 5: Route VPS traffic through the exit node

On the VPS, set the home machine as the exit node:

```bash
# List available exit nodes
tailscale exit-node list

# Set exit node (use the machine name from Tailscale admin)
tailscale set --exit-node=<home-machine-name>
```

### Step 6: Verify

```bash
# Should show your HOME residential IP, not the VPS datacenter IP
curl -s ifconfig.me

# Compare with the VPS's actual IP (shown in Hostinger panel)
# They should be different — ifconfig.me shows the residential IP
```

## Troubleshooting

### Connection drops or timeout

```bash
# Check Tailscale status
tailscale status

# Check if exit node is reachable
tailscale ping <home-machine-name>

# Restart Tailscale on VPS
systemctl restart tailscaled
```

### Home machine firewall blocking traffic

The home machine needs to allow IP forwarding:

**Linux:**
```bash
echo 'net.ipv4.ip_forward = 1' | sudo tee -a /etc/sysctl.d/99-tailscale.conf
echo 'net.ipv6.conf.all.forwarding = 1' | sudo tee -a /etc/sysctl.d/99-tailscale.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale.conf
```

**macOS:**
IP forwarding is handled automatically by Tailscale on macOS. If issues persist,
check System Settings > Network > Tailscale is enabled.

### DNS resolution fails

If DNS stops working after enabling the exit node:

```bash
# Use Tailscale's MagicDNS (recommended)
tailscale set --accept-dns

# Or fall back to public DNS
tailscale set --exit-node=<home-machine-name> --accept-dns=false
echo "nameserver 1.1.1.1" | sudo tee /etc/resolv.conf
```

### WhatsApp still getting flagged

1. Verify the exit node is actually being used: `curl -s ifconfig.me` must show the residential IP
2. If the residential IP was previously flagged, try a different home network
3. Ensure the home machine stays online — if it disconnects, the VPS falls back to its datacenter IP
4. Consider keeping the home machine on a wired connection (more stable than WiFi)

### Checking Tailscale logs

```bash
# VPS
journalctl -u tailscaled -f

# macOS
log show --predicate 'subsystem == "io.tailscale.ipn.macos"' --last 1h
```

## Keeping the exit node online

The home machine must stay powered on and connected for the VPS to route traffic.
Options for reliability:

- **Always-on Mac Mini** — low power, reliable
- **Linux server** — Raspberry Pi or NUC, connect via ethernet
- **Router with Tailscale** — best option, always on by design
- **UPS** — protect against power outages

If the exit node goes offline, the VPS loses its residential IP routing. exe-gateway
will keep running but WhatsApp may flag the connection until the exit node comes back.
