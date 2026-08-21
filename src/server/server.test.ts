/**
 * Tests for server routing and proxy API key auth.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import { describe, it, expect } from "bun:test";
import { createFetchHandler } from "./server.js";
import { handleListModels } from "./routes-openai.js";
import { handleMessages } from "./routes-anthropic.js";
import type { ProxyConfig } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: { mode: "apikey", apiKey: "testkey.testsecret", ...overrides.auth },
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
    mcp: { enabled: true, webSearch: true, webReader: false, zread: false },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
    logging: { level: "info" },
    ...overrides,
  };
}

function mockUpstream(): typeof fetch {
  return (async (req: Request): Promise<Response> => {
    const url = req.url;
    if (url.includes("/v1/models") || req.method === "GET") {
      return new Response('{"object":"list","data":[]}', { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = await req.text();
    const parsed = JSON.parse(body);
    if (url.includes("/anthropic/") || url.includes("/v1/messages")) {
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello from upstream" }],
          model: parsed.model ?? "glm-4.6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Date.now(),
        model: parsed.model ?? "glm-4.6",
        choices: [{ index: 0, message: { role: "assistant", content: "Hello from upstream" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

describe("server routing", () => {
  it("GET /v1/models returns model list", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/v1/models", { method: "GET" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].object).toBe("model");
  });

  it("POST /v1/chat/completions forwards to upstream", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.choices[0].message.content).toBe("Hello from upstream");
  });

  it("POST /v1/messages returns Anthropic-compatible response", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );
    expect(resp.status).toBe(200);
  });

  it("does not expose POST /v1/responses when Responses API is disabled", async () => {
    const config = makeConfig({ responses: { enabled: false, storeMaxEntries: 1000, storeTtlMs: 86400000 } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    let upstreamCalls = 0;
    const fetchImpl = Object.assign(async (_request: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      upstreamCalls++;
      return new Response("unexpected", { status: 500 });
    }, { preconnect: fetch.preconnect });
    const handler = createFetchHandler({ config, auth, fetchImpl });

    const resp = await handler(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", input: "Hi" }),
    }));
    expect(resp.status).toBe(404);
    expect(upstreamCalls).toBe(0);
  });

  it("GET /health returns ok status", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(new Request("http://localhost/health"));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
  });

  it("GET /status returns runtime snapshot", async () => {
    const config = makeConfig({ plan: "start-plan", models: ["glm-5.3"] });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(new Request("http://localhost/status"));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { status: string; plan: string; models: string[]; requestCount: number };
    expect(body.status).toBe("ok");
    expect(body.plan).toBe("start-plan");
    expect(body.models).toEqual(["glm-5.3"]);
    expect(typeof body.requestCount).toBe("number");
  });

  it("unknown route returns 404", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(new Request("http://localhost/unknown", { method: "GET" }));
    expect(resp.status).toBe(404);
  });
});

describe("proxy API key auth", () => {
  it("rejects request without proxy API key when configured", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/v1/models"));
    expect(resp.status).toBe(401);
  });

  it("accepts request with correct Bearer proxy key", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer proxy-secret" },
      }),
    );
    expect(resp.status).toBe(200);
  });

  it("accepts request with correct x-api-key proxy key", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/models", {
        headers: { "x-api-key": "proxy-secret" },
      }),
    );
    expect(resp.status).toBe(200);
  });

  it("rejects request with wrong proxy key", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer wrong-key" },
      }),
    );
    expect(resp.status).toBe(401);
  });

  it("does not require proxy key when proxyApiKey is unset", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/v1/models"));
    expect(resp.status).toBe(200);
  });
});

describe("CORS", () => {
  it("OPTIONS returns 204 with CORS headers", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(new Request("http://localhost/v1/models", { method: "OPTIONS" }));
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("web UI", () => {
  it("GET / serves the multi-instance manager without the proxy API key", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });
    const resp = await handler(new Request("http://localhost/", { method: "GET" }));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/html");
    const body = await resp.text();
    expect(body).toContain("多开");
    expect(body).toContain("/console");
    expect(body).not.toContain("导入 / 导出凭证");
    expect(body).not.toContain("导出当前端口");
    expect(body).toContain("开新反代");
    expect(body).toContain("独立凭证目录");
    expect(body).toContain("add.onclick = startNew");
    expect(body).not.toContain("add.onclick = function () { $(\"new-port\").focus(); }");
    expect(body).not.toContain("__ZCODE_PROXY_KEY_JSON__");
    expect(body).not.toContain("__ZCODE_PROXY_PORT_JSON__");
    expect(resp.headers.get("x-frame-options")).toBe("DENY");
  });

  it("GET /console serves the per-instance console", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });
    const resp = await handler(new Request("http://localhost/console", { method: "GET" }));
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain("可视化控制台");
    expect(body).toContain("登录 Bigmodel");
    expect(body).toContain("从 ZCode 导入");
    expect(body).toContain("导出解密凭证");
    expect(body).toContain("导入解密凭证");
    expect(body).toContain(">测试<");
    expect(body).not.toContain("主题");
    expect(body).not.toContain("复制 Base URL");
    expect(body).not.toContain("复制 Key");
  });

  it("GET /webui serves HTML without the proxy API key", async () => {
    // proxyApiKey is configured, yet /webui must load freely — it sits before
    // the auth gate by design so the page can present the key input.
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/webui", { method: "GET" }));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/html");
    const body = await resp.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("proxy-secret");
    expect(body).not.toContain("__ZCODE_PROXY_KEY_JSON__");
    expect(body).toContain("var SERVER_PROXY_API_KEY = \"proxy-secret\"");
    expect(body).toContain("Log in with Bigmodel");
    expect(body).toContain("/auth/login");
  });

  it("non-GET /webui is not served as the SPA", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/webui", { method: "POST" }));
    // POST falls through to the auth gate (proxyApiKey set, no creds) -> 401.
    expect(resp.status).toBe(401);
  });
});

describe("route handler exports", () => {
  it("handleListModels returns model list", async () => {
    const resp = handleListModels();
    expect(resp.status).toBe(200);
  });

  it("handleListModels prefers config.models", async () => {
    const resp = handleListModels({ models: ["glm-5-turbo", "glm-5.3"] });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(["glm-5-turbo", "glm-5.3"]);
  });

  it("handleMessages is a function", () => {
    expect(typeof handleMessages).toBe("function");
  });
});
