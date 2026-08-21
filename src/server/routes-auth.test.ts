import { describe, it, expect } from "bun:test";
import { AuthManager } from "../auth/manager.js";
import type { Credential } from "../auth/types.js";
import type { ProxyConfig } from "../config/types.js";
import { WebLoginService } from "./routes-auth.js";
import { createFetchHandler } from "./server.js";

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: { mode: "oauth", proxyApiKey: "proxy-secret", ...overrides.auth },
    provider: "bigmodel",
    plan: "start-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-5.3",
    models: ["glm-5.3"],
    identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { enabled: false, storeMaxEntries: 1000, storeTtlMs: 86400000 },
    mcp: { enabled: false, webSearch: false, webReader: false, zread: false },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
    logging: { level: "info" },
    ...overrides,
  };
}

function memoryStore() {
  let cred: Credential | null = null;
  return {
    saveCredential: async (c: Credential) => { cred = c; },
    loadCredential: async () => cred,
    clearCredential: () => { cred = null; },
    get: () => cred,
  };
}

function envelope(data: Record<string, unknown>): string {
  return JSON.stringify({ code: 0, data, msg: "success" });
}

describe("WebLoginService", () => {
  it("POST /auth/login returns an authorize URL for the request origin", async () => {
    const auth = new AuthManager({ mode: "oauth", provider: "bigmodel" });
    const store = memoryStore();
    const svc = new WebLoginService({
      auth,
      config: makeConfig(),
      ...store,
      resolveCredential: async () => ({ apiKey: "k", provider: "bigmodel" }),
    });

    const resp = await svc.startLogin(new Request("http://192.168.24.66:8080/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", host: "192.168.24.66:8080" },
      body: JSON.stringify({ provider: "bigmodel" }),
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { authorizeUrl: string; callbackUrl: string; provider: string };
    expect(body.provider).toBe("bigmodel");
    expect(body.callbackUrl).toBe("http://192.168.24.66:8080/auth/callback");
    const url = new URL(body.authorizeUrl);
    expect(url.hostname).toBe("bigmodel.cn");
    expect(url.searchParams.get("redirect")).toBe("http://192.168.24.66:8080/auth/callback");
    expect(url.searchParams.get("appId")).toBe("zcode");
  });

  it("callback exchanges the code, stores credential, and hot-swaps AuthManager", async () => {
    const auth = new AuthManager({ mode: "oauth", provider: "bigmodel" });
    const store = memoryStore();
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return new Response(envelope({
          token: "jwt-from-exchange",
          bigmodel: { access_token: "bm-access" },
          user: { user_id: "u-9" },
        }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const svc = new WebLoginService({
      auth,
      config: makeConfig(),
      fetchImpl,
      ...store,
      resolveCredential: async (accessToken, provider, userId) => ({
        apiKey: `resolved-${accessToken}`,
        provider,
        userId,
      }),
    });

    const started = await svc.startLogin(new Request("http://127.0.0.1:8080/auth/login", {
      method: "POST",
      body: JSON.stringify({ provider: "bigmodel" }),
    }));
    const { authorizeUrl } = await started.json() as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state");

    const cb = await svc.handleCallback(new Request(
      `http://127.0.0.1:8080/auth/callback?authCode=the-code&state=${state}`,
    ));
    expect(cb.status).toBe(200);
    const html = await cb.text();
    expect(html).toContain("Login successful");
    expect(html).toContain("__zcodeOauth");

    expect(auth.hasLiveCredential()).toBe(true);
    const cred = await auth.getCredential();
    expect(cred.apiKey).toBe("resolved-bm-access");
    expect(cred.jwt).toBe("jwt-from-exchange");
    expect(cred.userId).toBe("u-9");
    expect(store.get()?.jwt).toBe("jwt-from-exchange");
  });

  it("callback rejects a mismatched state", async () => {
    const auth = new AuthManager({ mode: "oauth", provider: "bigmodel" });
    const svc = new WebLoginService({
      auth,
      config: makeConfig(),
      ...memoryStore(),
    });
    await svc.startLogin(new Request("http://127.0.0.1:8080/auth/login", {
      method: "POST",
      body: "{}",
    }));
    const cb = await svc.handleCallback(new Request("http://127.0.0.1:8080/auth/callback?code=x&state=wrong"));
    expect(cb.status).toBe(400);
    expect(auth.hasLiveCredential()).toBe(false);
  });

  it("logout clears store and live credential", async () => {
    const auth = new AuthManager({ mode: "oauth", provider: "bigmodel" });
    const store = memoryStore();
    auth.setOAuthCredential({ apiKey: "live", provider: "bigmodel", jwt: "j" });
    await store.saveCredential({ apiKey: "live", provider: "bigmodel", jwt: "j" });
    const svc = new WebLoginService({ auth, config: makeConfig(), ...store });
    const resp = await svc.logout();
    expect(resp.status).toBe(200);
    expect(auth.hasLiveCredential()).toBe(false);
    expect(store.get()).toBeNull();
  });

  it("status reports logged-out when nothing is stored", async () => {
    const auth = new AuthManager({ mode: "oauth", provider: "bigmodel" });
    const svc = new WebLoginService({ auth, config: makeConfig(), ...memoryStore() });
    const resp = await svc.status();
    const body = await resp.json() as { loggedIn: boolean; live: boolean; plan: string };
    expect(body.loggedIn).toBe(false);
    expect(body.live).toBe(false);
    expect(body.plan).toBe("start-plan");
  });
});

describe("server auth routes", () => {
  it("GET /auth/callback is public (no proxy key)", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "oauth", provider: "bigmodel" });
    const handler = createFetchHandler({
      config,
      auth,
      webLogin: new WebLoginService({ auth, config, ...memoryStore() }),
    });
    const resp = await handler(new Request("http://localhost/auth/callback"));
    expect(resp.status).toBe(400);
    expect(resp.headers.get("content-type")).toContain("text/html");
  });

  it("POST /auth/login is public so WebUI can open the provider page without a proxy key", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "oauth", provider: "bigmodel" });
    const handler = createFetchHandler({ config, auth });
    const ok = await handler(new Request("http://localhost/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "zai" }),
    }));
    expect(ok.status).toBe(200);
    const body = await ok.json() as { authorizeUrl: string };
    expect(body.authorizeUrl).toContain("chat.z.ai");
  });

  it("GET /auth/status is public and hydrates from store", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "oauth", provider: "bigmodel" });
    const store = memoryStore();
    await store.saveCredential({ apiKey: "stored-key-abcdef", provider: "bigmodel", jwt: "jwt", userId: "u1" });
    const handler = createFetchHandler({
      config,
      auth,
      webLogin: new WebLoginService({ auth, config, ...store }),
    });
    const ok = await handler(new Request("http://localhost/auth/status"));
    expect(ok.status).toBe(200);
    const body = await ok.json() as { loggedIn: boolean; live: boolean; account: { hasJwt: boolean; userId: string } };
    expect(body.loggedIn).toBe(true);
    expect(body.live).toBe(true);
    expect(body.account.hasJwt).toBe(true);
    expect(body.account.userId).toBe("u1");
  });

  it("POST /auth/import-zcode requires the proxy API key", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "oauth", provider: "bigmodel" });
    const handler = createFetchHandler({
      config,
      auth,
      webLogin: new WebLoginService({ auth, config, ...memoryStore() }),
    });
    const denied = await handler(new Request("http://localhost/auth/import-zcode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    expect(denied.status).toBe(401);
  });

  it("POST /auth/import-credential hot-swaps a portable bundle", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "oauth", provider: "bigmodel" });
    const store = memoryStore();
    const handler = createFetchHandler({
      config,
      auth,
      webLogin: new WebLoginService({ auth, config, ...store }),
    });
    const denied = await handler(new Request("http://localhost/auth/import-credential", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "zcode-proxy-credential", version: 1, credential: { provider: "zai", apiKey: "k", jwt: "jwt-1" } }),
    }));
    expect(denied.status).toBe(401);

    const ok = await handler(new Request("http://localhost/auth/import-credential", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer proxy-secret" },
      body: JSON.stringify({ kind: "zcode-proxy-credential", version: 1, credential: { provider: "zai", apiKey: "k", jwt: "jwt-1", userId: "u" } }),
    }));
    expect(ok.status).toBe(200);
    const body = await ok.json() as { source: string; account: { hasJwt: boolean; provider: string } };
    expect(body.source).toBe("portable");
    expect(body.account.provider).toBe("zai");
    expect(body.account.hasJwt).toBe(true);
    expect(auth.hasLiveCredential()).toBe(true);
    expect(store.get()?.jwt).toBe("jwt-1");
  });

  it("POST /auth/export-credential decrypts the live credential to a portable bundle", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "oauth", provider: "bigmodel" });
    auth.setOAuthCredential({ apiKey: "export-key-abcdef", provider: "zai", jwt: "jwt-export", userId: "u" });
    const handler = createFetchHandler({
      config,
      auth,
      webLogin: new WebLoginService({ auth, config, ...memoryStore() }),
    });
    const denied = await handler(new Request("http://localhost/auth/export-credential", { method: "POST", body: "{}" }));
    expect(denied.status).toBe(401);

    const ok = await handler(new Request("http://localhost/auth/export-credential", {
      method: "POST",
      headers: { authorization: "Bearer proxy-secret" },
      body: "{}",
    }));
    expect(ok.status).toBe(200);
    const body = await ok.json() as { source: string; bundle: { kind: string; credential: { apiKey: string; jwt?: string } } };
    expect(body.source).toBe("decrypt");
    expect(body.bundle.kind).toBe("zcode-proxy-credential");
    expect(body.bundle.credential.apiKey).toBe("export-key-abcdef");
    expect(body.bundle.credential.jwt).toBe("jwt-export");
  });
});
