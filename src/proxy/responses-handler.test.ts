import { describe, it, expect } from "bun:test";
import { handleResponses } from "./responses-handler.js";
import { ResponseStore } from "../responses/store.js";
import type { ProxyConfig } from "../config/types.js";

const CONFIG: ProxyConfig = {
  server: { port: 0, host: "127.0.0.1" },
  auth: { mode: "apikey", apiKey: "testkey.testsecret" },
  provider: "zai",
  plan: "coding-plan",
  providers: {
    zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
    bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
  },
  defaultModel: "glm-5.2",
  models: ["glm-5.2"],
  identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
  clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
  responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
  mcp: { enabled: true, webSearch: true, webReader: false, zread: false },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  logging: { level: "info" },
};

const auth = { getCredential: async () => ({ apiKey: "testkey.testsecret", userId: "u1" }) } as unknown as import("../auth/manager.js").AuthManager;

function chatUpstream(body: string, status = 200): typeof fetch {
  return (async (): Promise<Response> => new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

function makeReq(body: unknown): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleResponses", () => {
  it("returns a ResponsesResponse with message output for a basic text request", async () => {
    const fetchImpl = chatUpstream(JSON.stringify({
      id: "cc-1",
      object: "chat.completion",
      created: 1,
      model: "glm-5.2",
      choices: [{ index: 0, message: { role: "assistant", content: "hi back" }, finish_reason: "stop" }],
    }));
    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hello" }), { config: CONFIG, auth, fetchImpl });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("response");
    expect(body.output[0].type).toBe("message");
    expect(body.output[0].content[0].text).toBe("hi back");
  });

  it("stores the response and resolves previous_response_id from the store", async () => {
    const store = new ResponseStore();
    const fetchImpl = chatUpstream(JSON.stringify({
      id: "cc-1", object: "chat.completion", created: 1, model: "glm-5.2",
      choices: [{ index: 0, message: { role: "assistant", content: "turn1" }, finish_reason: "stop" }],
    }));
    const r1 = await handleResponses(makeReq({ model: "glm-5.2", input: "first turn" }), { config: CONFIG, auth, fetchImpl, responseStore: store });
    const body1 = await r1.json();
    expect(store.size()).toBe(1);

    // Second request references the first response's id.
    let secondUpstreamBody = "";
    const fetchImpl2 = (async (request: Request): Promise<Response> => {
      secondUpstreamBody = await request.text();
      return new Response(JSON.stringify({
        id: "cc-2", object: "chat.completion", created: 1, model: "glm-5.2",
        choices: [{ index: 0, message: { role: "assistant", content: "turn2" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r2 = await handleResponses(makeReq({ model: "glm-5.2", input: "second turn", previous_response_id: body1.id }), { config: CONFIG, auth, fetchImpl: fetchImpl2, responseStore: store });
    expect(r2.status).toBe(200);
    expect(secondUpstreamBody).toContain("first turn");
    expect(secondUpstreamBody).toContain("turn1");
    expect(secondUpstreamBody).toContain("second turn");
  });

  it("returns 404 when previous_response_id is not in the store", async () => {
    const store = new ResponseStore();
    const fetchImpl = chatUpstream(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "glm-5.2", choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" }] }));
    const r = await handleResponses(makeReq({ model: "glm-5.2", input: "x", previous_response_id: "resp_missing" }), { config: CONFIG, auth, fetchImpl, responseStore: store });
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error.type).toBe("response_not_found");
  });

  it("does not store the response when store:false", async () => {
    const store = new ResponseStore();
    const fetchImpl = chatUpstream(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "glm-5.2", choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" }] }));
    await handleResponses(makeReq({ model: "glm-5.2", input: "x", store: false }), { config: CONFIG, auth, fetchImpl, responseStore: store });
    expect(store.size()).toBe(0);
  });

  it("strips web_search_preview silently (model never sees it)", async () => {
    let upstreamCalls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      upstreamCalls++;
      return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "glm-5.2", choices: [{ index: 0, message: { role: "assistant", content: "no search needed" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r = await handleResponses(makeReq({ model: "glm-5.2", input: "search the web", tools: [{ type: "web_search_preview" }] }), { config: CONFIG, auth, fetchImpl });
    expect(r.status).toBe(200);
    expect(upstreamCalls).toBe(1);
    const body = await r.json();
    expect(body.output[0].type).toBe("message");
    const wsCall = body.output.find((o: { type: string }) => o.type === "web_search_call");
    expect(wsCall).toBeUndefined();
  });

  it("returns a text/event-stream response for stream:true", async () => {
    const sseBody = [
      `data:${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "glm-5.2", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
      `data:${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "glm-5.2", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] })}\n\n`,
      `data:${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "glm-5.2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      `data:[DONE]\n\n`,
    ].join("");
    const fetchImpl = (async (): Promise<Response> => new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const r = await handleResponses(makeReq({ model: "glm-5.2", input: "hi", stream: true }), { config: CONFIG, auth, fetchImpl });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const text = await r.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.completed");
    expect(text).toContain("response.output_text.delta");
  });

  it("stores a completed stream for previous_response_id continuation", async () => {
    const store = new ResponseStore();
    const sseBody = [
      `data:${JSON.stringify({ id: "chatcmpl-stream", object: "chat.completion.chunk", created: 1, model: "glm-5.2", choices: [{ index: 0, delta: { content: "turn1" }, finish_reason: null }] })}\n\n`,
      `data:${JSON.stringify({ id: "chatcmpl-stream", object: "chat.completion.chunk", created: 1, model: "glm-5.2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data:[DONE]\n\n",
    ].join("");
    const streamFetch = (async (): Promise<Response> => new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const streamed = await handleResponses(makeReq({ model: "glm-5.2", input: "first turn", stream: true }), { config: CONFIG, auth, fetchImpl: streamFetch, responseStore: store });
    const streamText = await streamed.text();
    const responseId = streamText.match(/event: response\.completed\ndata: .*?"id":"([^"]+)"/)?.[1];
    expect(responseId).toBeDefined();

    let continuationUpstreamBody = "";
    const continuationFetch = (async (request: Request): Promise<Response> => {
      continuationUpstreamBody = await request.text();
      return new Response(JSON.stringify({
        id: "cc-2", object: "chat.completion", created: 1, model: "glm-5.2",
        choices: [{ index: 0, message: { role: "assistant", content: "turn2" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const continuation = await handleResponses(makeReq({ model: "glm-5.2", input: "second turn", previous_response_id: responseId }), { config: CONFIG, auth, fetchImpl: continuationFetch, responseStore: store });
    expect(continuation.status).toBe(200);
    expect(continuationUpstreamBody).toContain("first turn");
    expect(continuationUpstreamBody).toContain("turn1");
    expect(continuationUpstreamBody).toContain("second turn");
  });

  it("start-plan posts Anthropic body to the gateway and translates the reply", async () => {
    const startConfig: ProxyConfig = { ...CONFIG, plan: "start-plan" };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (req: Request | string): Promise<Response> => {
      const url = typeof req === "string" ? req : req.url;
      if (url.includes("/client/configs")) {
        return new Response(JSON.stringify({ data: { configs: { captcha: { enabled: false } } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected global fetch in test: ${url}`);
    }) as typeof fetch;

    let seenUrl = "";
    let seenBody = "";
    const fetchImpl = (async (request: Request): Promise<Response> => {
      seenUrl = request.url;
      seenBody = await request.text();
      return new Response(JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "start-plan via responses" }],
        model: "glm-5.3",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 3 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    try {
      const resp = await handleResponses(makeReq({ model: "glm-5.3", input: "hi" }), {
        config: startConfig,
        auth,
        fetchImpl,
      });
      expect(resp.status).toBe(200);
      expect(seenUrl).toContain("/anthropic/v1/messages");
      const posted = JSON.parse(seenBody) as { max_tokens?: number; stream_options?: unknown };
      expect(posted.max_tokens).toBeGreaterThan(0);
      expect(posted.stream_options).toBeUndefined();
      const body = await resp.json();
      expect(body.object).toBe("response");
      expect(body.output[0].content[0].text).toBe("start-plan via responses");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("start-plan stream:true returns SSE before a slow captcha solve", async () => {
    const startConfig: ProxyConfig = { ...CONFIG, plan: "start-plan" };
    let solved = false;
    const captcha = {
      RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
      invalidateCaptchaToken() {},
      detectCaptchaChallenge() { return null; },
      async getCaptchaToken() {
        await Bun.sleep(60);
        solved = true;
        return { verifyParam: "tok-1", region: "cn" };
      },
    };
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"glm-5.2","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const fetchImpl = (async (): Promise<Response> => new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;

    const t0 = Date.now();
    const r = await handleResponses(makeReq({ model: "glm-5.2", input: "hi", stream: true }), {
      config: startConfig,
      auth,
      fetchImpl,
      captcha,
      captchaKeepaliveMs: 20,
    });
    expect(Date.now() - t0).toBeLessThan(60);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const text = await r.text();
    expect(solved).toBe(true);
    expect(text).toContain(": keepalive");
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.completed");
  });
});
