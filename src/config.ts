import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { DBConfig } from "./db.js";

export const DEFAULT_PORT = 3100;
export const DEFAULT_BIND_HOST = "127.0.0.1";
const DEFAULT_STATE_DIR_NAME = ".exe-os";

interface StorageFilterConfig {
  enabled: boolean;
  allowGroups?: string[];
  allowContacts?: string[];
}

interface LLMProxyConfig {
  enabled: boolean;
  anthropicApiKey?: string;
  marginPercent?: number;
}

interface AutoReplyConfig {
  enabled: boolean;
  message?: string;
  allowGroups?: string[];
  allowContacts?: string[];
  cooldownHours?: number;
  dailyCap?: number;
  dmOnly?: boolean;
}

interface AdapterAccountConfig {
  name: string;
  authDir?: string;
  defaultAgent?: string;
  readOnly?: boolean;
  proxy?: string;
  [key: string]: string | boolean | undefined;
}

interface AdapterConfig {
  enabled?: boolean;
  credentials?: Record<string, string>;
  proxy?: string;
  accounts?: AdapterAccountConfig[];
}

export interface WsRelayRuntimeConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  authToken?: string;
}

export interface GatewayJsonConfig {
  port?: number;
  host?: string;
  authToken?: string;
  authTokenHash?: string;
  whatsappVerifyToken?: string;
  readOnly?: boolean;
  database?: DBConfig;
  storageFilter?: StorageFilterConfig;
  llmProxy?: LLMProxyConfig;
  autoReply?: AutoReplyConfig;
  wsRelay?: WsRelayRuntimeConfig;
  adapters?: Record<string, AdapterConfig>;
}

export interface LoadedGatewayConfig {
  config: GatewayJsonConfig;
  configPath: string;
  stateDir: string;
  configFileExists: boolean;
}

export interface StartupConfigValidation {
  errors: string[];
  warnings: string[];
}

export function getGatewayStateDir(): string {
  const envDir = process.env.EXE_GATEWAY_HOME?.trim();
  if (envDir) return path.resolve(envDir);
  return path.join(os.homedir(), DEFAULT_STATE_DIR_NAME);
}

export function getGatewayConfigPath(): string {
  const envPath =
    process.env.EXE_GATEWAY_CONFIG?.trim() ??
    process.env.EXE_GATEWAY_CONFIG_PATH?.trim();
  if (envPath) return path.resolve(envPath);
  return path.join(getGatewayStateDir(), "gateway.json");
}

export function getDefaultWhatsAppAuthDir(accountName: string): string {
  return path.join(getGatewayStateDir(), ".auth", `whatsapp-${accountName}`);
}

export function loadGatewayConfig(options?: {
  allowMissing?: boolean;
}): LoadedGatewayConfig {
  const allowMissing = options?.allowMissing ?? false;
  const configPath = getGatewayConfigPath();
  const stateDir = getGatewayStateDir();
  const configFileExists = existsSync(configPath);

  let fileConfig: GatewayJsonConfig = {};

  if (configFileExists) {
    const raw = readFileSync(configPath, "utf-8");
    try {
      fileConfig = JSON.parse(raw) as GatewayJsonConfig;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse ${configPath}: ${msg}`);
    }
  } else if (!allowMissing) {
    throw new Error(
      `Missing gateway config at ${configPath}. ` +
        `Create it from deploy/gateway.example.json or set EXE_GATEWAY_CONFIG.`,
    );
  }

  return {
    config: mergeConfigWithEnv(fileConfig),
    configPath,
    stateDir,
    configFileExists,
  };
}

export function validateStartupConfig(config: GatewayJsonConfig): StartupConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.authTokenHash && !config.authToken && !parseBooleanEnv("EXE_GATEWAY_ALLOW_INSECURE_NO_AUTH")) {
    errors.push(
      "Missing auth token. Set EXE_GATEWAY_AUTH_TOKEN in the environment " +
        "or authToken/authTokenHash in the config file.",
    );
  }

  if (config.authToken && isPlaceholderValue(config.authToken)) {
    errors.push("authToken still contains a placeholder value.");
  }

  if (config.authTokenHash && !isSha256Hex(config.authTokenHash)) {
    errors.push("authTokenHash must be a 64-character SHA-256 hex string.");
  }

  if (config.whatsappVerifyToken && isPlaceholderValue(config.whatsappVerifyToken)) {
    errors.push("whatsappVerifyToken still contains a placeholder value.");
  }

  if (config.database) {
    const missingDbField = getMissingDatabaseField(config.database);
    if (missingDbField) {
      errors.push(`database.${missingDbField} is required when database config is present.`);
    }
    if (config.database.password && isPlaceholderValue(config.database.password)) {
      errors.push("database.password still contains a placeholder value.");
    }
  }

  const wsRelay = config.wsRelay;
  if (wsRelay?.enabled) {
    if (!wsRelay.authToken) {
      errors.push(
        "wsRelay.enabled=true requires wsRelay.authToken or EXE_GATEWAY_WS_RELAY_AUTH_TOKEN.",
      );
    } else if (!isHexToken(wsRelay.authToken)) {
      errors.push("wsRelay.authToken must be an even-length hex string.");
    }
  }

  const bindHost = config.host ?? DEFAULT_BIND_HOST;
  if (isPublicBindHost(bindHost)) {
    warnings.push(
      `host is set to ${bindHost}. For VPS deployments, bind to 127.0.0.1 and publish through nginx unless direct exposure is intentional.`,
    );
  }

  if (!hasEnabledAdapters(config.adapters)) {
    warnings.push("No adapters are enabled. The service will boot, but it will not connect to any channels.");
  }

  return { errors, warnings };
}

export function isHexToken(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
}

function mergeConfigWithEnv(config: GatewayJsonConfig): GatewayJsonConfig {
  const database = mergeDatabaseConfig(config.database);
  const wsRelay = mergeWsRelayConfig(config.wsRelay);
  const authToken = getFirstEnv(["EXE_GATEWAY_AUTH_TOKEN", "AUTH_TOKEN"]) ?? config.authToken;
  const authTokenHash =
    getFirstEnv(["EXE_GATEWAY_AUTH_TOKEN_HASH"]) ??
    config.authTokenHash ??
    (authToken ? hashAuthToken(authToken) : undefined);

  return {
    ...config,
    port: parseIntegerEnv(["EXE_GATEWAY_PORT", "PORT"]) ?? config.port,
    host: getFirstEnv(["EXE_GATEWAY_HOST"]) ?? config.host,
    authToken,
    authTokenHash,
    whatsappVerifyToken:
      getFirstEnv(["EXE_GATEWAY_WHATSAPP_VERIFY_TOKEN"]) ?? config.whatsappVerifyToken,
    readOnly: parseBooleanEnv("EXE_GATEWAY_READ_ONLY") ?? config.readOnly,
    database,
    wsRelay,
  };
}

function mergeDatabaseConfig(config?: DBConfig): DBConfig | undefined {
  if (process.env.DATABASE_URL) {
    return parseDatabaseUrl(process.env.DATABASE_URL);
  }

  const hasOverride =
    getFirstEnv([
      "EXE_GATEWAY_DB_HOST",
      "EXE_GATEWAY_DB_PORT",
      "EXE_GATEWAY_DB_USER",
      "EXE_GATEWAY_DB_PASSWORD",
      "EXE_GATEWAY_DB_NAME",
    ]) !== undefined;

  if (!hasOverride) return config;

  return {
    host: getFirstEnv(["EXE_GATEWAY_DB_HOST"]) ?? config?.host ?? "",
    port: parseIntegerEnv(["EXE_GATEWAY_DB_PORT"]) ?? config?.port ?? 5432,
    user: getFirstEnv(["EXE_GATEWAY_DB_USER"]) ?? config?.user ?? "",
    password: getFirstEnv(["EXE_GATEWAY_DB_PASSWORD"]) ?? config?.password ?? "",
    database: getFirstEnv(["EXE_GATEWAY_DB_NAME"]) ?? config?.database ?? "",
  };
}

function mergeWsRelayConfig(config?: WsRelayRuntimeConfig): WsRelayRuntimeConfig | undefined {
  const enabled = parseBooleanEnv("EXE_GATEWAY_WS_RELAY_ENABLED");
  const host = getFirstEnv(["EXE_GATEWAY_WS_RELAY_HOST"]);
  const port = parseIntegerEnv(["EXE_GATEWAY_WS_RELAY_PORT"]);
  const authToken = getFirstEnv(["EXE_GATEWAY_WS_RELAY_AUTH_TOKEN"]);

  if (
    enabled === undefined &&
    host === undefined &&
    port === undefined &&
    authToken === undefined
  ) {
    return config;
  }

  return {
    ...config,
    enabled: enabled ?? config?.enabled,
    host: host ?? config?.host,
    port: port ?? config?.port,
    authToken: authToken ?? config?.authToken,
  };
}

function parseDatabaseUrl(rawUrl: string): DBConfig {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  }

  const database = parsed.pathname.replace(/^\/+/, "");
  return {
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

function getMissingDatabaseField(config: DBConfig): keyof DBConfig | null {
  if (!config.host) return "host";
  if (!config.port) return "port";
  if (!config.user) return "user";
  if (!config.password) return "password";
  if (!config.database) return "database";
  return null;
}

function hasEnabledAdapters(adapters?: Record<string, AdapterConfig>): boolean {
  if (!adapters) return false;
  return Object.values(adapters).some(
    (adapter) => adapter.enabled || (adapter.accounts?.length ?? 0) > 0,
  );
}

function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith("change_me") ||
    normalized.startsWith("replace_me") ||
    normalized.includes("your-") ||
    normalized.includes("example.com")
  );
}

export function hashAuthToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value.trim());
}

function isPublicBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return !["127.0.0.1", "localhost", "::1"].includes(normalized);
}

function getFirstEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseIntegerEnv(keys: string[]): number | undefined {
  const raw = getFirstEnv(keys);
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected an integer value for ${keys.join(" or ")}.`);
  }
  return parsed;
}

function parseBooleanEnv(key: string): boolean | undefined {
  const raw = process.env[key];
  if (raw === undefined) return undefined;

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;

  throw new Error(`Expected a boolean value for ${key}.`);
}
