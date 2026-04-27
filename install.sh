#!/usr/bin/env bash
# exe-gateway — idempotent one-command installer for customer VPS deployment.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/AskExe/exe-gateway/main/install.sh | bash
#
# Supports: Ubuntu 22.04+, Debian 12+
# Must run as root.

set -euo pipefail

PREFIX="[exe-gateway]"

log()  { echo "$PREFIX $*"; }
fail() { echo "$PREFIX ERROR: $*" >&2; exit 1; }

# ── 0. Root check ────────────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  fail "This script must be run as root. Try: sudo bash install.sh"
fi

# ── 1. Check / install Node.js 20+ ──────────────────────────────────────────
install_node() {
  log "Installing Node.js 20 LTS via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
}

if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 20 ]; then
    log "Node.js $(node -v) found (>= 20). OK."
  else
    log "Node.js $(node -v) found but too old (need >= 20)."
    install_node
  fi
else
  log "Node.js not found."
  install_node
fi

# ── 2. Check / install Tailscale ─────────────────────────────────────────────
if command -v tailscale &>/dev/null; then
  log "Tailscale $(tailscale version | head -1) found. OK."
else
  log "Installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh
fi

# ── 3. Clone or update exe-gateway ───────────────────────────────────────────
INSTALL_DIR="/opt/exe-gateway"

if [ -d "$INSTALL_DIR/.git" ]; then
  log "Updating existing installation at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  log "Cloning exe-gateway to $INSTALL_DIR..."
  apt-get install -y git
  git clone https://github.com/AskExe/exe-gateway.git "$INSTALL_DIR"
fi

# ── 4. Install dependencies + build ─────────────────────────────────────────
log "Installing dependencies..."
cd "$INSTALL_DIR"
npm install --omit=dev

log "Building TypeScript..."
npx tsc

# ── 5. Create exe system user ────────────────────────────────────────────────
if id exe &>/dev/null; then
  log "System user 'exe' already exists. OK."
else
  log "Creating system user 'exe'..."
  useradd -r -s /bin/false -d /home/exe -m exe
fi

mkdir -p /home/exe/.exe-os
chown -R exe:exe /home/exe/.exe-os

# ── 6. Generate auth token ───────────────────────────────────────────────────
ENV_FILE="$INSTALL_DIR/.env"

if [ -f "$ENV_FILE" ] && grep -q '^AUTH_TOKEN=' "$ENV_FILE"; then
  AUTH_TOKEN=$(grep '^AUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2)
  log "Existing auth token found. Keeping it."
else
  AUTH_TOKEN=$(openssl rand -hex 16)
  log "Generated new auth token."
fi

# ── 7. Create gateway.json config ────────────────────────────────────────────
CONFIG_FILE="/home/exe/.exe-os/gateway.json"

if [ -f "$CONFIG_FILE" ]; then
  log "Config $CONFIG_FILE already exists. Keeping it."
else
  log "Writing config to $CONFIG_FILE..."
  cat > "$CONFIG_FILE" <<GATEWAY_JSON
{
  "port": 3100,
  "authToken": "$AUTH_TOKEN",
  "adapters": {
    "whatsapp": {
      "enabled": true,
      "accounts": [
        {
          "name": "default",
          "authDir": "/home/exe/.exe-os/.auth/whatsapp-default"
        }
      ]
    }
  }
}
GATEWAY_JSON
  chown exe:exe "$CONFIG_FILE"
fi

# ── 8. Install systemd service ───────────────────────────────────────────────
log "Installing systemd service..."
cp "$INSTALL_DIR/exe-gateway.service" /etc/systemd/system/exe-gateway.service
systemctl daemon-reload
systemctl enable exe-gateway

# ── 9. Write .env file ───────────────────────────────────────────────────────
cat > "$ENV_FILE" <<ENV_EOF
AUTH_TOKEN=$AUTH_TOKEN
ENV_EOF
chown exe:exe "$ENV_FILE"
chmod 600 "$ENV_FILE"

log "Ensuring correct ownership on $INSTALL_DIR..."
chown -R exe:exe "$INSTALL_DIR"

# ── 10. Done ─────────────────────────────────────────────────────────────────
cat <<DONE

═══════════════════════════════════════════════
 exe-gateway installed successfully!

 Auth token: $AUTH_TOKEN
 Config:     $CONFIG_FILE

 Next steps:
 1. Set up Tailscale exit node (see docs/tailscale-exit-node.md)
 2. Pair WhatsApp:
    node /opt/exe-gateway/pair-whatsapp.mjs <name> <phone>
 3. Start the service:
    systemctl start exe-gateway
 4. Verify health:
    curl -H "Authorization: Bearer $AUTH_TOKEN" http://localhost:3100/health
═══════════════════════════════════════════════

DONE
