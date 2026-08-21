import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleManagerApi, listInstances, startInstance, stopInstance } from "./manager.js";
import type { Credential } from "../auth/types.js";
import type { ProxyConfig } from "../config/types.js";

function makeConfig(): ProxyConfig {
  return {
    server: { port: 8081, host: "127.0.0.1" },
    auth: { mode: "oauth", proxyApiKey: "k" },
    provider: "bigmodel",
    plan: "start-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-5.3",
    models: ["glm-5.3"],
    identity: { appVersion: "test", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { enabled: false, storeMaxEntries: 1000, storeTtlMs: 86400000 },
    mcp: { enabled: false, webSearch: false, webReader: false, zread: false },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
    logging: { level: "info" },
  };
}

describe("instance manager", () => {
  it("lists the current process as self", () => {
    const root = join(tmpdir(), `mgr-list-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const list = listInstances(makeConfig(), root);
      expect(list.length).toBe(1);
      expect(list[0]?.self).toBe(true);
      expect(list[0]?.port).toBe(8081);
      expect(list[0]?.alive).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to start or stop the hub port", async () => {
    const root = join(tmpdir(), `mgr-hub-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const config = makeConfig();
    try {
      await expect(startInstance(config, 8081, true, root)).rejects.toThrow(/own instance/);
      expect(() => stopInstance(config, 8081, root)).toThrow(/own instance/);
      await expect(startInstance(config, 0, true, root)).rejects.toThrow(/invalid port/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("imports a portable bundle onto the hub port via applyCredential", async () => {
    const applied: Credential[] = [];
    const config = makeConfig();
    const resp = await handleManagerApi(
      new Request("http://localhost/manager/api/import-credential", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          port: 8081,
          bundle: {
            kind: "zcode-proxy-credential",
            version: 1,
            credential: { provider: "bigmodel", apiKey: "imported", jwt: "jwt-imp" },
          },
        }),
      }),
      config,
      join(tmpdir(), `mgr-imp-${Date.now()}`),
      { applyCredential: async (cred) => { applied.push(cred); } },
    );
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);
    const body = await resp!.json() as { ok: boolean; live: boolean; account: { hasJwt: boolean } };
    expect(body.ok).toBe(true);
    expect(body.live).toBe(true);
    expect(body.account.hasJwt).toBe(true);
    expect(applied[0]?.apiKey).toBe("imported");
  });

  it("writes an isolated store when the target port is not running", async () => {
    const root = join(tmpdir(), `mgr-disk-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const resp = await handleManagerApi(
        new Request("http://localhost/manager/api/import-credential", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            port: 8099,
            bundle: { kind: "zcode-proxy-credential", version: 1, credential: { provider: "zai", apiKey: "disk-key" } },
          }),
        }),
        makeConfig(),
        root,
      );
      expect(resp!.status).toBe(200);
      const body = await resp!.json() as { live: boolean; storeDir: string };
      expect(body.live).toBe(false);
      expect(existsSync(join(root, ".credentials-8099", "credentials.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exports a decrypted portable bundle from the hub port", async () => {
    const config = makeConfig();
    const resp = await handleManagerApi(
      new Request("http://localhost/manager/api/export-credential", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: 8081 }),
      }),
      config,
      join(tmpdir(), `mgr-exp-${Date.now()}`),
      { exportCredential: async () => ({ provider: "zai", apiKey: "exp-key", jwt: "exp-jwt" }) },
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json() as { source: string; bundle: { kind: string; credential: { jwt?: string } } };
    expect(body.source).toBe("decrypt");
    expect(body.bundle.kind).toBe("zcode-proxy-credential");
    expect(body.bundle.credential.jwt).toBe("exp-jwt");
  });
});
