import { describe, it, expect, mock } from "bun:test";
import { proxyRequest } from "./handler.js";
import type { CaptchaClient } from "./captcha-keepalive.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
};

const startPlanConfig: ProxyConfig = {
  server: { port: 8080, host: "0.0.0.0" },
  auth: { mode: "oauth" },
  provider: "zai",
  plan: "start-plan",
  providers: {
    zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
    bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
  },
  defaultModel: "glm-5.3",
  models: ["glm-5.3"],
  identity: IDENTITY,
  clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
  responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
  mcp: { enabled: true, webSearch: true, webReader: false, zread: false },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  logging: { level: "info" },
};

function startPlanAuth(): AuthManager {
  const auth = new AuthManager({ mode: "oauth", provider: "zai" });
  auth.setOAuthCredential({ apiKey: "dummy", provider: "zai", jwt: "jwt-mock" });
  return auth;
}

function mockCaptcha(opts?: { delayMs?: number; fail?: boolean }): CaptchaClient & { calls: number } {
  const client = {
    calls: 0,
    RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
    invalidateCaptchaToken() {},
    detectCaptchaChallenge(resp: Response): string | null {
      const v = resp.headers.get("x-aliyun-captcha-verify-param");
      return v && v.trim().length > 0 ? v.trim() : null;
    },
    async getCaptchaToken(): Promise<{ verifyParam: string; region: string }> {
      client.calls++;
      if (opts?.delayMs) await Bun.sleep(opts.delayMs);
      if (opts?.fail) throw new Error("captcha down");
      return { verifyParam: `tok-${client.calls}`, region: "cn" };
    },
  };
  return client;
}

function mockFetch(impl: (req: Request) => Promise<Response>): typeof fetch {
  return Object.assign(impl, { preconnect: () => {} }) as typeof fetch;
}

function anthropicSse(): string {
  return [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"glm-5.3","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
    "",
    "event: content_block_stop",
    'data: {"type":"content_block_stop","index":0}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
}

function streamReq(format: "openai" | "anthropic"): Request {
  if (format === "openai") {
    return new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
  }
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3", max_tokens: 64, messages: [{ role: "user", content: "hi" }], stream: true }),
  });
}

describe("proxyRequest start-plan captcha keepalive", () => {
  it("returns SSE headers before a slow captcha solve finishes", async () => {
    const captcha = mockCaptcha({ delayMs: 80 });
    const fetchImpl = mockFetch(async () => new Response(anthropicSse(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    const t0 = Date.now();
    const resp = await proxyRequest(streamReq("openai"), "openai", {
      config: startPlanConfig,
      auth: startPlanAuth(),
      fetchImpl,
      captcha,
      captchaKeepaliveMs: 20,
    });
    expect(Date.now() - t0).toBeLessThan(80);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");

    const decoder = new TextDecoder();
    const reader = resp.body!.getReader();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(": keepalive\n\n");

    const restChunks: string[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      restChunks.push(decoder.decode(next.value));
    }
    const rest = restChunks.join("");
    expect(rest).toContain("chat.completion.chunk");
    expect(rest).toContain("hello");
    const dataIdx = rest.search(/^data:/m);
    expect(dataIdx).toBeGreaterThanOrEqual(0);
    expect(rest.slice(dataIdx)).not.toContain(": keepalive");
  });

  it("keeps Anthropic streaming clients on comment heartbeats then pipes upstream events", async () => {
    const captcha = mockCaptcha({ delayMs: 50 });
    const fetchImpl = mockFetch(async (req) => {
      expect(req.headers.get("x-aliyun-captcha-verify-param")).toBe("tok-1");
      return new Response(anthropicSse(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const resp = await proxyRequest(streamReq("anthropic"), "anthropic", {
      config: startPlanConfig,
      auth: startPlanAuth(),
      fetchImpl,
      captcha,
      captchaKeepaliveMs: 20,
    });
    const text = await resp.text();
    expect(text.startsWith(": keepalive\n\n")).toBe(true);
    expect(text).toContain("event: message_start");
    expect(text).toContain("hello");
    expect(text.slice(text.indexOf("event: message_start"))).not.toContain(": keepalive");
  });

  it("does not delay non-stream start-plan JSON behind SSE headers", async () => {
    const captcha = mockCaptcha({ delayMs: 40 });
    const fetchImpl = mockFetch(async () => new Response(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "glm-5.3",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const t0 = Date.now();
    const resp = await proxyRequest(new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] }),
    }), "openai", {
      config: startPlanConfig,
      auth: startPlanAuth(),
      fetchImpl,
      captcha,
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/json");
    const body = await resp.json();
    expect(body.choices[0].message.content).toBe("ok");
  });

  it("emits an in-stream error (still HTTP 200) when captcha retry fails", async () => {
    const captcha = mockCaptcha({ fail: true });
    const fetchImpl = mock(async () => new Response(JSON.stringify({ error: "need captcha" }), {
      status: 403,
      headers: { "content-type": "application/json", "x-aliyun-captcha-verify-param": "challenge" },
    }));

    const resp = await proxyRequest(streamReq("openai"), "openai", {
      config: startPlanConfig,
      auth: startPlanAuth(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      captcha,
      captchaKeepaliveMs: 50,
    });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain("captcha_solver_failed");
    expect(text).toContain("data: [DONE]");
  });
});
