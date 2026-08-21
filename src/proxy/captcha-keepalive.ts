/**
 * SSE keepalive while start-plan captcha is solved.
 *
 * Streaming clients idle-timeout if the proxy emits no bytes during a slow
 * captcha relaunch. This module returns HTTP 200 + `text/event-stream`
 * immediately, heartbeats with SSE comments (`: keepalive\n\n`), then splices
 * in the real upstream SSE. Comments are ignored by spec-compliant SDKs and
 * must never be inserted after upstream bytes begin.
 */
import { keepaliveFrame } from "../async/keepalive.js";

export type SseErrorFormat = "anthropic" | "openai" | "responses";

export interface CaptchaClient {
  getCaptchaToken(appVersion: string): Promise<{ verifyParam: string; region: string }>;
  detectCaptchaChallenge(resp: Response): string | null;
  invalidateCaptchaToken(): void;
  RETRY_HEADERS: { PARAM: string; REGION: string };
}

/** Terminal error after SSE headers are already flushed (cannot change HTTP status). */
export class SseTerminalError extends Error {
  readonly type: string;
  constructor(type: string, message: string) {
    super(message);
    this.name = "SseTerminalError";
    this.type = type;
  }
}

export const SSE_KEEPALIVE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

export const DEFAULT_CAPTCHA_KEEPALIVE_MS = 3000;

export function captchaKeepaliveIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ZCODE_CAPTCHA_KEEPALIVE_MS);
  if (Number.isInteger(n) && n >= 200 && n <= 30_000) return n;
  return DEFAULT_CAPTCHA_KEEPALIVE_MS;
}

export interface CaptchaKeepaliveSseOptions {
  format: SseErrorFormat;
  /** Cadence of comment frames. First frame is always emitted immediately. */
  intervalMs?: number;
  signal?: AbortSignal;
  /**
   * Slow work (captcha + upstream fetch). Return the client-facing SSE body
   * to pipe. Throw `SseTerminalError` (or any Error) to emit an in-stream
   * error event. Abort should throw `AbortError` / DOMException — no error event.
   */
  produce: (ctx: { signal: AbortSignal }) => Promise<ReadableStream<Uint8Array>>;
}

export function captchaKeepaliveSseResponse(opts: CaptchaKeepaliveSseOptions): Response {
  const intervalMs = opts.intervalMs ?? captchaKeepaliveIntervalMs();
  const localAbort = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) localAbort.abort();
    else opts.signal.addEventListener("abort", () => localAbort.abort(), { once: true });
  }
  const signal = localAbort.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const pump = startKeepalivePump(controller, intervalMs, signal);
      try {
        if (signal.aborted) return;
        const body = await opts.produce({ signal });
        if (signal.aborted) {
          try { await body.cancel(); } catch { /* already closed */ }
          return;
        }
        pump.stop();
        await pipeBytes(controller, body, signal);
      } catch (err) {
        pump.stop();
        if (signal.aborted || isAbortError(err)) return;
        emitSseTerminalError(controller, opts.format, err);
      } finally {
        pump.stop();
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      localAbort.abort();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_KEEPALIVE_HEADERS });
}

export function emitSseTerminalError(controller: ReadableStreamDefaultController<Uint8Array>, format: SseErrorFormat, err: unknown): void {
  const type = err instanceof SseTerminalError ? err.type : "api_error";
  const message = err instanceof Error ? err.message : String(err);
  const encoder = new TextEncoder();
  try {
    if (format === "openai") {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { type, message } })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      return;
    }
    if (format === "responses") {
      const payload = JSON.stringify({ type: "error", code: type, message });
      controller.enqueue(encoder.encode(`event: error\ndata: ${payload}\n\n`));
      return;
    }
    const payload = JSON.stringify({ type: "error", error: { type, message } });
    controller.enqueue(encoder.encode(`event: error\ndata: ${payload}\n\n`));
  } catch {
    // consumer already gone
  }
}

function startKeepalivePump(
  controller: ReadableStreamDefaultController<Uint8Array>,
  intervalMs: number,
  signal: AbortSignal,
): { stop: () => void } {
  let alive = true;
  const enqueue = (): void => {
    if (!alive || signal.aborted) return;
    try {
      controller.enqueue(keepaliveFrame());
    } catch {
      alive = false;
    }
  };
  enqueue();
  const timer = setInterval(enqueue, intervalMs);
  timer.unref?.();
  const onAbort = (): void => stop();
  signal.addEventListener("abort", onAbort, { once: true });
  function stop(): void {
    alive = false;
    clearInterval(timer);
    signal.removeEventListener("abort", onAbort);
  }
  return { stop };
}

async function pipeBytes(
  controller: ReadableStreamDefaultController<Uint8Array>,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        return;
      }
      if (value && value.byteLength > 0) {
        try {
          controller.enqueue(value);
        } catch {
          await reader.cancel().catch(() => {});
          return;
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}
