import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_BIND_HOST,
  getDefaultWhatsAppAuthDir,
  loadGatewayConfig,
  validateStartupConfig,
} from "../src/config.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("config", () => {
  it("loads config from EXE_GATEWAY_CONFIG and applies env overrides", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "exe-gateway-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "gateway.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        port: 3100,
        host: "127.0.0.1",
        authToken: "file-token",
      }),
    );

    vi.stubEnv("EXE_GATEWAY_CONFIG", configPath);
    vi.stubEnv("EXE_GATEWAY_AUTH_TOKEN", "env-token");
    vi.stubEnv("EXE_GATEWAY_PORT", "3200");

    const loaded = loadGatewayConfig();

    expect(loaded.configPath).toBe(configPath);
    expect(loaded.config.port).toBe(3200);
    expect(loaded.config.authToken).toBe("env-token");
    expect(loaded.config.host).toBe("127.0.0.1");
  });

  it("parses DATABASE_URL into database config", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "exe-gateway-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "gateway.json");
    writeFileSync(configPath, JSON.stringify({ authToken: "abc123" }));

    vi.stubEnv("EXE_GATEWAY_CONFIG", configPath);
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://gateway_user:secret-pass@db.internal:5433/gateway_prod",
    );

    const loaded = loadGatewayConfig();

    expect(loaded.config.database).toEqual({
      host: "db.internal",
      port: 5433,
      user: "gateway_user",
      password: "secret-pass",
      database: "gateway_prod",
    });
  });

  it("validates missing auth token and placeholder values", () => {
    const validation = validateStartupConfig({
      host: DEFAULT_BIND_HOST,
      wsRelay: { enabled: true, authToken: "not-hex-token" },
      database: {
        host: "127.0.0.1",
        port: 5432,
        user: "gateway",
        password: "CHANGE_ME",
        database: "gateway",
      },
    });

    expect(validation.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Missing auth token"),
        expect.stringContaining("database.password"),
        expect.stringContaining("wsRelay.authToken"),
      ]),
    );
  });

  it("resolves default WhatsApp auth dir from EXE_GATEWAY_HOME", () => {
    vi.stubEnv("EXE_GATEWAY_HOME", "/srv/exe-gateway-state");

    expect(getDefaultWhatsAppAuthDir("sales")).toBe(
      "/srv/exe-gateway-state/.auth/whatsapp-sales",
    );
  });
});
