import { describe, it, expect } from "bun:test";
import {
  captchaKeepaliveIntervalMs,
  captchaKeepaliveSseResponse,
  SseTerminalError,
  SSE_KEEPALIVE_HEADERS,
} from "./captcha-keepalive.js";

const decoder = new TextDecoder();

async function drain(resp: Response): Promise<string> {
  return decoder.decode(await resp.arrayBuffer());
}

describe("captchaKeepaliveIntervalMs", () => {
  it("defaults to 3000 and accepts a clamped env override", () => {
    expect(captchaKeepaliveIntervalMs({})).toBe(3000);
    expect(captchaKeepaliveIntervalMs({ ZCODE_CAPTCHA_KEEPALIVE_MS: "2500" })).toBe(2500);
    expect(captchaKeepaliveIntervalMs({ ZCODE_CAPTCHA_KEEPALIVE_MS: "50" })).toBe(3000);
    expect(captchaKeepaliveIntervalMs({ ZCODE_CAPTCHA_KEEPALIVE_MS: "nope" })).toBe(3000);
  });
});

describe("captchaKeepaliveSseResponse", () => {
  it("returns 200 SSE immediately and emits a keepalive before produce resolves", async () => {
    let produceStarted = 0;
    let produceResolved = 0;
    const resp = captchaKeepaliveSseResponse({
      format: "anthropic",
      intervalMs: 30,
      produce: async () => {
        produceStarted = Date.now();
        await Bun.sleep(70);
        produceResolved = Date.now();
        return new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
            c.close();
          },
        });
      },
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe(SSE_KEEPALIVE_HEADERS["content-type"]);
    expect(resp.headers.get("x-accel-buffering")).toBe("no");

    const reader = resp.body!.getReader();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(": keepalive\n\n");
    expect(produceResolved).toBe(0);
    expect(produceStarted).toBeGreaterThan(0);

    const restChunks: string[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      restChunks.push(decoder.decode(next.value));
    }
    const rest = restChunks.join("");
    expect(rest).toContain("message_stop");
    const dataIdx = rest.search(/event: message_stop/);
    expect(dataIdx).toBeGreaterThanOrEqual(0);
    expect(rest.slice(dataIdx)).not.toContain(": keepalive");
    expect(produceResolved).toBeGreaterThan(produceStarted);
  });

  it("emits an Anthropic error event when produce throws", async () => {
    const resp = captchaKeepaliveSseResponse({
      format: "anthropic",
      intervalMs: 50,
      produce: async () => {
        throw new SseTerminalError("captcha_solver_failed", "no browser");
      },
    });
    const text = await drain(resp);
    expect(resp.status).toBe(200);
    expect(text).toContain("event: error");
    expect(text).toContain("captcha_solver_failed");
    expect(text).toContain("no browser");
  });

  it("emits an OpenAI error + [DONE] when produce throws", async () => {
    const resp = captchaKeepaliveSseResponse({
      format: "openai",
      intervalMs: 50,
      produce: async () => {
        throw new SseTerminalError("upstream_error", "boom");
      },
    });
    const text = await drain(resp);
    expect(text).toContain('"error"');
    expect(text).toContain("boom");
    expect(text).toContain("data: [DONE]");
  });

  it("does not emit an error event when the client aborts during produce", async () => {
    const ac = new AbortController();
    const resp = captchaKeepaliveSseResponse({
      format: "anthropic",
      intervalMs: 20,
      signal: ac.signal,
      produce: async ({ signal }) => {
        await Bun.sleep(30);
        ac.abort();
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        throw new Error("should not reach");
      },
    });
    const text = await drain(resp);
    expect(text).not.toContain("event: error");
    expect(text).not.toContain("should not reach");
  });
});
