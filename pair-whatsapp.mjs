#!/usr/bin/env node
/**
 * WhatsApp pairing script for exe-gateway.
 * Links a WhatsApp number to an account via pairing code (no QR scan needed).
 *
 * Usage: node pair-whatsapp.mjs <account-name> <phone-number>
 * Example: node pair-whatsapp.mjs exe-ea +6281234567890
 *
 * Rate limited: max 3 attempts, 30s cooldown between attempts.
 */

import { existsSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { SocksProxyAgent } from "socks-proxy-agent";

const MAX_ATTEMPTS = 3;
const COOLDOWN_MS = 30_000;

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: node pair-whatsapp.mjs <account-name> <phone-number>");
  console.error("Example: node pair-whatsapp.mjs default +6281234567890");
  process.exit(1);
}

const [accountName, rawPhone] = args;
const normalizedAccountName = normalizeAccountName(accountName);

// Strip non-numeric except leading +
const phoneNumber = rawPhone.replace(/[^0-9]/g, "");
if (phoneNumber.length < 10) {
  console.error("Error: Phone number too short. Include country code (e.g., +6281234567890).");
  process.exit(1);
}

const stateDir = process.env.EXE_GATEWAY_HOME?.trim()
  ? resolve(process.env.EXE_GATEWAY_HOME.trim())
  : join(homedir(), ".exe-os");
const configPath = process.env.EXE_GATEWAY_CONFIG?.trim()
  ? resolve(process.env.EXE_GATEWAY_CONFIG.trim())
  : join(stateDir, "gateway.json");

// Resolve auth dir + proxy — check gateway.json first, fall back to defaults/env
let authDir = join(stateDir, ".auth", `whatsapp-${accountName}`);
let proxyUrl = process.env.WHATSAPP_PROXY_URL || "";
if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const accounts = config?.adapters?.whatsapp?.accounts ?? [];
    const match = accounts.find((a) => normalizeAccountName(a.name) === normalizedAccountName);
    if (match) {
      authDir = match.authDir || join(stateDir, ".auth", `whatsapp-${match.name}`);
    }
    proxyUrl = match?.proxy || config?.adapters?.whatsapp?.proxy || proxyUrl;
  } catch {
    // Ignore config parse errors — use default
  }
}

mkdirSync(authDir, { recursive: true, mode: 0o700 });
chmodSync(authDir, 0o700);

console.log(`[pair] Account: ${accountName}`);
console.log(`[pair] Phone: +${phoneNumber}`);
console.log(`[pair] Auth dir: ${authDir}`);
if (proxyUrl) {
  console.log(`[pair] Proxy: ${sanitizeProxyUrl(proxyUrl)}`);
}
console.log("");

const baileys = await import("@whiskeysockets/baileys");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = baileys;

let attempt = 0;

async function pair() {
  attempt++;
  if (attempt > MAX_ATTEMPTS) {
    console.error(`[pair] Max attempts (${MAX_ATTEMPTS}) reached. Wait a few minutes and try again.`);
    process.exit(1);
  }

  if (attempt > 1) {
    console.log(`[pair] Cooldown ${COOLDOWN_MS / 1000}s before attempt ${attempt}/${MAX_ATTEMPTS}...`);
    await new Promise((r) => setTimeout(r, COOLDOWN_MS));
  }

  console.log(`[pair] Attempt ${attempt}/${MAX_ATTEMPTS}...`);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  const proxyAgent = proxyUrl ? new SocksProxyAgent(proxyUrl) : undefined;

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, undefined),
    },
    version,
    printQRInTerminal: false,
    browser: ["Chrome", "Chrome", "130.0.0"],  // Blend in — real Chrome linked-device fingerprint
    markOnlineOnConnect: false,
    ...(proxyUrl
      ? {
          agent: proxyAgent,
          fetchAgent: proxyAgent,
        }
      : {}),
  });

  sock.ev.on("creds.update", saveCreds);

  // Wait for socket to be ready before requesting pairing code
  await new Promise((resolve) => setTimeout(resolve, 3000));

  let pairingCode;
  try {
    pairingCode = await sock.requestPairingCode(phoneNumber);
  } catch (err) {
    console.error(`[pair] Failed to request pairing code: ${err.message}`);
    sock.ws?.close();
    await pair();
    return;
  }

  const formatted = pairingCode.match(/.{1,4}/g)?.join("-") ?? pairingCode;

  console.log("");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Pairing code: ${formatted}`);
  console.log("");
  console.log("  Open WhatsApp on your phone:");
  console.log("  Settings > Linked Devices > Link a Device");
  console.log("  Tap 'Link with phone number instead'");
  console.log(`  Enter this code: ${formatted}`);
  console.log("═══════════════════════════════════════════════");
  console.log("");
  console.log("[pair] Waiting for pairing confirmation...");

  sock.ev.on("connection.update", (update) => {
    const { connection } = update;

    if (connection === "open") {
      console.log("");
      console.log(`[pair] Paired successfully! Account "${accountName}" is linked.`);
      console.log(`[pair] Auth state saved to: ${authDir}`);
      console.log("");
      console.log("Next: systemctl start exe-gateway");
      sock.ws?.close();
      process.exit(0);
    }

    if (connection === "close") {
      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      if (statusCode === 401 || statusCode === 403) {
        console.error("[pair] Pairing rejected or expired.");
        sock.ws?.close();
        void pair();
      }
    }
  });
}

await pair();

function sanitizeProxyUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "[invalid proxy URL]";
  }
}

function normalizeAccountName(value) {
  return String(value ?? "").trim().toLowerCase();
}
