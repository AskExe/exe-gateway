#!/usr/bin/env bash
# exe-gateway — idempotent installer for customer VPS deployment.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/AskExe/exe-gateway/main/install.sh | bash
#
# Supports: Ubuntu 22.04+, Debian 12+
# Must run as root.

set -euo pipefail

PREFIX="[exe-gateway]"
INSTALL_DIR="/opt/exe-gateway"
STATE_DIR="/home/exe/.exe-os"
CONFIG_FILE="$STATE_DIR/gateway.json"
ENV_DIR="/etc/exe-gateway"
ENV_FILE="$ENV_DIR/exe-gateway.env"
LEGACY_ENV_FILE="$INSTALL_DIR/.env"

log()  { echo "$PREFIX $*"; }
fail() { echo "$PREFIX ERROR: $*" >&2; exit 1; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fail "This script must be run as root. Try: sudo bash install.sh"
  fi
}

install_node() {
  log "Installing Node.js 20 LTS via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local node_major
    node_major="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [ "$node_major" -ge 20 ]; then
      log "Node.js $(node -v) found (>= 20)."
      return
    fi
    log "Node.js $(node -v) found but too old (need >= 20)."
  else
    log "Node.js not found."
  fi

  install_node
}

ensure_repo() {
  apt-get install -y git

  if [ -d "$INSTALL_DIR/.git" ]; then
    log "Updating existing installation at $INSTALL_DIR..."
    git -C "$INSTALL_DIR" pull --ff-only
  else
    log "Cloning exe-gateway to $INSTALL_DIR..."
    git clone https://github.com/AskExe/exe-gateway.git "$INSTALL_DIR"
  fi
}

build_repo() {
  log "Installing dependencies..."
  cd "$INSTALL_DIR"
  npm ci

  log "Building TypeScript..."
  npm run build

  log "Pruning dev dependencies..."
  npm prune --omit=dev
}

ensure_service_user() {
  if id exe >/dev/null 2>&1; then
    log "System user 'exe' already exists."
  else
    log "Creating system user 'exe'..."
    useradd -r -s /bin/false -d /home/exe -m exe
  fi

  install -d -o exe -g exe "$STATE_DIR"
  install -d -o exe -g exe "$STATE_DIR/.auth"
}

read_existing_secret() {
  local file="$1"
  local key="$2"
  if [ -f "$file" ]; then
    awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$file"
  fi
}

ensure_env_setting() {
  local file="$1"
  local key="$2"
  local value="$3"

  if grep -q "^${key}=" "$file"; then
    return
  fi

  printf '%s=%s\n' "$key" "$value" >> "$file"
}

ensure_env_file() {
  local auth_token
  auth_token="$(read_existing_secret "$ENV_FILE" EXE_GATEWAY_AUTH_TOKEN)"
  if [ -z "$auth_token" ]; then
    auth_token="$(read_existing_secret "$LEGACY_ENV_FILE" AUTH_TOKEN)"
  fi
  if [ -z "$auth_token" ]; then
    auth_token="$(openssl rand -hex 32)"
    log "Generated new API auth token."
  else
    log "Reusing existing API auth token."
  fi

  local ws_auth_token
  ws_auth_token="$(read_existing_secret "$ENV_FILE" EXE_GATEWAY_WS_RELAY_AUTH_TOKEN)"
  if [ -z "$ws_auth_token" ]; then
    ws_auth_token="$(openssl rand -hex 32)"
    log "Generated new WebSocket relay auth token."
  fi

  install -d -m 750 "$ENV_DIR"

  if [ -f "$ENV_FILE" ]; then
    log "Environment file $ENV_FILE already exists. Keeping it."
  else
    log "Writing environment file to $ENV_FILE..."
    cat > "$ENV_FILE" <<ENV_EOF
NODE_ENV=production
NODE_OPTIONS=--max-old-space-size=2048
EXE_GATEWAY_HOME=$STATE_DIR
EXE_GATEWAY_CONFIG=$CONFIG_FILE
EXE_GATEWAY_AUTH_TOKEN=$auth_token
EXE_GATEWAY_WS_RELAY_ENABLED=false
EXE_GATEWAY_WS_RELAY_HOST=127.0.0.1
EXE_GATEWAY_WS_RELAY_PORT=3101
EXE_GATEWAY_WS_RELAY_AUTH_TOKEN=$ws_auth_token
ENV_EOF
    chmod 640 "$ENV_FILE"
  fi

  ensure_env_setting "$ENV_FILE" NODE_ENV production
  ensure_env_setting "$ENV_FILE" NODE_OPTIONS --max-old-space-size=2048
  ensure_env_setting "$ENV_FILE" EXE_GATEWAY_HOME "$STATE_DIR"
  ensure_env_setting "$ENV_FILE" EXE_GATEWAY_CONFIG "$CONFIG_FILE"
  ensure_env_setting "$ENV_FILE" EXE_GATEWAY_AUTH_TOKEN "$auth_token"
  ensure_env_setting "$ENV_FILE" EXE_GATEWAY_WS_RELAY_ENABLED false
  ensure_env_setting "$ENV_FILE" EXE_GATEWAY_WS_RELAY_HOST 127.0.0.1
  ensure_env_setting "$ENV_FILE" EXE_GATEWAY_WS_RELAY_PORT 3101
  ensure_env_setting "$ENV_FILE" EXE_GATEWAY_WS_RELAY_AUTH_TOKEN "$ws_auth_token"

  AUTH_TOKEN="$auth_token"
}

ensure_config() {
  if [ -f "$CONFIG_FILE" ]; then
    log "Config $CONFIG_FILE already exists. Keeping it."
    return
  fi

  log "Writing config to $CONFIG_FILE..."
  cat > "$CONFIG_FILE" <<GATEWAY_JSON
{
  "port": 3100,
  "host": "127.0.0.1",
  "adapters": {
    "whatsapp": {
      "enabled": true,
      "accounts": [
        {
          "name": "default",
          "authDir": "$STATE_DIR/.auth/whatsapp-default"
        }
      ]
    }
  }
}
GATEWAY_JSON
  chown exe:exe "$CONFIG_FILE"
  chmod 640 "$CONFIG_FILE"
}

install_service() {
  log "Installing systemd service..."
  cp "$INSTALL_DIR/exe-gateway.service" /etc/systemd/system/exe-gateway.service
  systemctl daemon-reload
  systemctl enable exe-gateway
}

lock_repo_permissions() {
  log "Setting repository ownership and permissions..."
  chown -R root:root "$INSTALL_DIR"
  chmod -R a+rX "$INSTALL_DIR"
}

print_summary() {
  cat <<DONE

═══════════════════════════════════════════════
 exe-gateway installed successfully

 Config file: $CONFIG_FILE
 Env file:    $ENV_FILE
 API token:   $AUTH_TOKEN

 Next steps:
 1. Edit $CONFIG_FILE for the customer's adapters.
 2. Add any secrets to $ENV_FILE.
 3. Pair WhatsApp if needed:
    sudo -u exe node /opt/exe-gateway/pair-whatsapp.mjs <name> <phone>
 4. Start the service:
    systemctl start exe-gateway
 5. Verify health:
    curl -H "Authorization: Bearer $AUTH_TOKEN" http://127.0.0.1:3100/health

 Optional:
 - Configure nginx with nginx-gateway.conf
 - Set WHATSAPP_PROXY_URL in $ENV_FILE for residential proxy routing
═══════════════════════════════════════════════

DONE
}

require_root
ensure_node
ensure_repo
build_repo
ensure_service_user
ensure_env_file
ensure_config
install_service
lock_repo_permissions
print_summary
