/** In-process snapshot for GET /status and the tray app. */

export interface LastRequestSnapshot {
  id: string;
  at: number;
  format: string;
  model: string;
  status: number;
  ttfbMs: number;
  tokens: number;
}

const startedAt = Date.now();
let requestCount = 0;
let lastRequest: LastRequestSnapshot | null = null;

export function recordRequest(snap: LastRequestSnapshot): void {
  requestCount += 1;
  lastRequest = snap;
}

export function getRuntimeSnapshot(): {
  startedAt: number;
  uptimeMs: number;
  requestCount: number;
  lastRequest: LastRequestSnapshot | null;
} {
  return {
    startedAt,
    uptimeMs: Date.now() - startedAt,
    requestCount,
    lastRequest,
  };
}
