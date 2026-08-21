/**
 * Bind helpers for the compiled Windows exe: a dead process can leave
 * EADDRINUSE on the configured port, which previously made double-click
 * flash-exit with no window.
 */
import { createServer } from "node:net";

export function isAddrInUse(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  const msg = `${e.code ?? ""} ${e.message ?? ""} ${String(err)}`;
  return /EADDRINUSE|EACCES|address already in use|Failed to listen/i.test(msg);
}

export async function probeLocalProxy(port: number, timeoutMs = 800): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return false;
    const body = await resp.json() as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}

export async function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    const finish = (ok: boolean) => {
      try { server.close(); } catch { /* */ }
      resolve(ok);
    };
    server.once("error", () => finish(false));
    server.listen(port, host, () => finish(true));
  });
}

export async function nextListenPort(start: number, host: string, maxTries = 40): Promise<number> {
  if (!Number.isInteger(start) || start < 1) start = 10100;
  for (let i = 0; i < maxTries; i++) {
    const port = start + i;
    if (port > 65535) break;
    if (await canListen(port, host)) return port;
  }
  throw new Error(`no free listen port from ${start}`);
}
