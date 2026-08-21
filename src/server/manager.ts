/**
 * Spawn / list / stop extra proxy instances from the visual manager.
 * Each instance is a child `serve` with its own port, captcha CDP port, and store dir.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProxyConfig } from "../config/types.js";
import type { Credential } from "../auth/types.js";
import { credentialFromUnknown, loadCredentialFromDir, saveCredentialToDir } from "../auth/store.js";
import { credentialAccountView, toPortableCredential } from "../auth/portable.js";
import { errorResponse } from "../proxy/handler.js";

export interface ManagerHooks {
  /** Apply a portable credential to this process (hot-swap + persist). */
  applyCredential?: (cred: Credential) => Promise<void>;
  /** Decrypt this process's store (or live oauth cred) for export. */
  exportCredential?: () => Promise<Credential>;
}

export interface ManagerInstance {
  port: number;
  pid: number | null;
  storeDir: string;
  isolated: boolean;
  alive: boolean;
  self: boolean;
}

function runDir(root: string): string {
  const dir = join(root, "run");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pidPath(root: string, port: number): string {
  return join(runDir(root), `${port}.pid`);
}

function storeDirFor(root: string, port: number, isolated: boolean): string {
  return isolated ? join(root, `.credentials-${port}`) : join(root, ".credentials");
}

function readPid(root: string, port: number): number | null {
  const f = pidPath(root, port);
  if (!existsSync(f)) return null;
  const n = Number(readFileSync(f, "utf-8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

function writePid(root: string, port: number, pid: number): void {
  writeFileSync(pidPath(root, port), `${pid}\n`, { encoding: "ascii" });
}

function clearPid(root: string, port: number): void {
  try { unlinkSync(pidPath(root, port)); } catch { /* missing is fine */ }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function spawnCommand(configPath: string): { cmd: string; args: string[] } {
  const cmd = process.execPath;
  const entry = process.argv[1] ?? "";
  const bunfs = entry.includes("$bunfs") || entry.includes("B:/~bunfs") || entry.includes("/~bunfs");
  const looksLikeSource = /\.(ts|js|mjs)$/i.test(entry) && !bunfs && existsSync(entry);
  if (looksLikeSource) {
    return { cmd, args: [entry, "serve", configPath] };
  }
  return { cmd, args: ["serve", configPath] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilListening(port: number, pid: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) throw new Error(`child pid=${pid} exited before listening on :${port}`);
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(400) });
      if (resp.ok) return;
    } catch { /* not up yet */ }
    await sleep(120);
  }
  throw new Error(`started pid=${pid} but :${port} did not become ready`);
}

function readLogTail(root: string, port: number): string {
  const p = join(runDir(root), `${port}.log`);
  if (!existsSync(p)) return "";
  try {
    return readFileSync(p, "utf-8").trim().slice(-800);
  } catch {
    return "";
  }
}

export function listInstances(config: ProxyConfig, root: string = process.cwd()): ManagerInstance[] {
  const selfPort = config.server.port;
  const found = new Map<number, ManagerInstance>();
  found.set(selfPort, {
    port: selfPort,
    pid: process.pid,
    storeDir: process.env.ZCODE_PROXY_STORE_DIR?.trim() || join(root, ".credentials"),
    isolated: false,
    alive: true,
    self: true,
  });
  try {
    for (const name of readdirSync(runDir(root))) {
      const m = /^(\d+)\.pid$/.exec(name);
      if (!m) continue;
      const port = Number(m[1]);
      if (!validPort(port) || port === selfPort) continue;
      const pid = readPid(root, port);
      const alive = pid != null && pidAlive(pid);
      if (!alive) {
        clearPid(root, port);
        continue;
      }
      found.set(port, {
        port,
        pid,
        storeDir: existsSync(join(root, `.credentials-${port}`)) ? join(root, `.credentials-${port}`) : join(root, ".credentials"),
        isolated: existsSync(join(root, `.credentials-${port}`)),
        alive: true,
        self: false,
      });
    }
  } catch { /* no run dir */ }
  return [...found.values()].sort((a, b) => a.port - b.port);
}

export async function startInstance(
  config: ProxyConfig,
  port: number,
  isolated: boolean,
  root: string = process.cwd(),
): Promise<ManagerInstance> {
  if (!validPort(port)) throw new Error("invalid port");
  if (port === config.server.port) throw new Error("that port is this window's own instance");
  const existing = readPid(root, port);
  if (existing && pidAlive(existing)) {
    return {
      port,
      pid: existing,
      storeDir: existsSync(join(root, `.credentials-${port}`)) ? join(root, `.credentials-${port}`) : join(root, ".credentials"),
      isolated: existsSync(join(root, `.credentials-${port}`)),
      alive: true,
      self: false,
    };
  }

  const configPath = resolve(process.env.ZCODE_PROXY_CONFIG ?? join(root, "config.yaml"));
  if (!existsSync(configPath)) throw new Error(`config not found: ${configPath}`);

  const storeDir = storeDirFor(root, port, isolated);
  mkdirSync(storeDir, { recursive: true });
  const cdp = (10000 + port) <= 65535 ? 10000 + port : 20000 + (port % 40000);
  const logPath = join(runDir(root), `${port}.log`);
  const logFd = openSync(logPath, "a");
  const { cmd, args } = spawnCommand(configPath);
  const child = spawn(cmd, args, {
    cwd: root,
    env: {
      ...process.env,
      ZCODE_PROXY_PORT: String(port),
      ZCODE_PROXY_STORE_DIR: storeDir,
      ZCODE_CAPTCHA_CDP_PORT: String(cdp),
      ZCODE_PROXY_NO_OPEN: "1",
    },
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });
  if (child.pid == null) {
    try { closeSync(logFd); } catch { /* */ }
    throw new Error("failed to spawn proxy process");
  }
  child.unref();
  try { closeSync(logFd); } catch { /* inherited */ }
  writePid(root, port, child.pid);
  try {
    await waitUntilListening(port, child.pid);
  } catch (err) {
    const tail = readLogTail(root, port);
    try { process.kill(child.pid); } catch { /* already dead */ }
    clearPid(root, port);
    throw new Error(`${(err as Error).message}${tail ? `\n${tail}` : ""}`);
  }
  return {
    port,
    pid: child.pid,
    storeDir,
    isolated,
    alive: true,
    self: false,
  };
}

export function stopInstance(config: ProxyConfig, port: number, root: string = process.cwd()): void {
  if (!validPort(port)) throw new Error("invalid port");
  if (port === config.server.port) throw new Error("cannot stop this window's own instance from here");
  const pid = readPid(root, port);
  if (pid && pidAlive(pid)) {
    try { process.kill(pid); } catch { /* continue */ }
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    }
  }
  clearPid(root, port);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleManagerApi(
  req: Request,
  config: ProxyConfig,
  root: string = process.cwd(),
  hooks: ManagerHooks = {},
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === "GET" && path === "/manager/api/list") {
    return json(200, { ok: true, self: config.server.port, instances: listInstances(config, root) });
  }
  if (method === "POST" && path === "/manager/api/start") {
    let body: { port?: unknown; isolated?: unknown } = {};
    const text = await req.text();
    if (text.trim()) {
      try { body = JSON.parse(text) as { port?: unknown; isolated?: unknown }; }
      catch { return errorResponse(400, "invalid_request_error", "body must be JSON"); }
    }
    const port = Number(body.port);
    try {
      const inst = await startInstance(config, port, body.isolated !== false, root);
      return json(200, { ok: true, instance: inst });
    } catch (err) {
      return errorResponse(400, "invalid_request_error", (err as Error).message);
    }
  }
  if (method === "POST" && path === "/manager/api/stop") {
    let body: { port?: unknown } = {};
    const text = await req.text();
    if (text.trim()) {
      try { body = JSON.parse(text) as { port?: unknown }; }
      catch { return errorResponse(400, "invalid_request_error", "body must be JSON"); }
    }
    try {
      stopInstance(config, Number(body.port), root);
      return json(200, { ok: true });
    } catch (err) {
      return errorResponse(400, "invalid_request_error", (err as Error).message);
    }
  }
  if (method === "POST" && path === "/manager/api/import-credential") {
    let body: { port?: unknown; bundle?: unknown } = {};
    const text = await req.text();
    if (text.trim()) {
      try { body = JSON.parse(text) as { port?: unknown; bundle?: unknown }; }
      catch { return errorResponse(400, "invalid_request_error", "body must be JSON"); }
    }
    const port = Number(body.port);
    if (!validPort(port)) return errorResponse(400, "invalid_request_error", "invalid port");
    let cred: Credential;
    try {
      cred = await credentialFromUnknown(body.bundle ?? body);
    } catch (err) {
      return errorResponse(400, "invalid_request_error", (err as Error).message);
    }
    try {
      const result = await importCredentialToPort(config, port, cred, root, hooks);
      return json(200, { ok: true, ...result, account: credentialAccountView(cred) });
    } catch (err) {
      return errorResponse(400, "invalid_request_error", (err as Error).message);
    }
  }
  if (method === "POST" && path === "/manager/api/export-credential") {
    let body: { port?: unknown } = {};
    const text = await req.text();
    if (text.trim()) {
      try { body = JSON.parse(text) as { port?: unknown }; }
      catch { return errorResponse(400, "invalid_request_error", "body must be JSON"); }
    }
    const port = Number(body.port ?? config.server.port);
    if (!validPort(port)) return errorResponse(400, "invalid_request_error", "invalid port");
    try {
      const result = await exportCredentialFromPort(config, port, root, hooks);
      return json(200, {
        ok: true,
        port,
        source: "decrypt",
        account: credentialAccountView(result.cred),
        bundle: toPortableCredential(result.cred, {
          homedir: homedir(),
          platform: process.platform,
          arch: process.arch,
          store: result.storeDir,
        }),
      });
    } catch (err) {
      return errorResponse(400, "invalid_request_error", (err as Error).message);
    }
  }
  return null;
}

async function importCredentialToPort(
  config: ProxyConfig,
  port: number,
  cred: Credential,
  root: string,
  hooks: ManagerHooks,
): Promise<{ port: number; live: boolean; storeDir: string }> {
  if (port === config.server.port) {
    if (!hooks.applyCredential) throw new Error("this window cannot import credentials");
    await hooks.applyCredential(cred);
    return {
      port,
      live: true,
      storeDir: process.env.ZCODE_PROXY_STORE_DIR?.trim() || join(root, ".credentials"),
    };
  }

  const listed = listInstances(config, root).find((i) => i.port === port);
  if (listed?.alive) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.auth.proxyApiKey) headers.authorization = `Bearer ${config.auth.proxyApiKey}`;
    const resp = await fetch(`http://127.0.0.1:${port}/auth/import-credential`, {
      method: "POST",
      headers,
      body: JSON.stringify({ bundle: toPortableCredential(cred) }),
    });
    const raw = await resp.text();
    if (!resp.ok) {
      let message = raw.slice(0, 240);
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string } };
        if (parsed.error?.message) message = parsed.error.message;
      } catch { /* keep raw */ }
      throw new Error(message || `import failed on :${port}`);
    }
    return { port, live: true, storeDir: listed.storeDir };
  }

  const storeDir = storeDirFor(root, port, true);
  await saveCredentialToDir(storeDir, cred);
  return { port, live: false, storeDir };
}

async function exportCredentialFromPort(
  config: ProxyConfig,
  port: number,
  root: string,
  hooks: ManagerHooks,
): Promise<{ cred: Credential; storeDir: string }> {
  if (port === config.server.port) {
    if (!hooks.exportCredential) throw new Error("this window cannot export credentials");
    const cred = await hooks.exportCredential();
    return {
      cred,
      storeDir: process.env.ZCODE_PROXY_STORE_DIR?.trim() || join(root, ".credentials"),
    };
  }

  const listed = listInstances(config, root).find((i) => i.port === port);
  if (listed?.alive) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.auth.proxyApiKey) headers.authorization = `Bearer ${config.auth.proxyApiKey}`;
    const resp = await fetch(`http://127.0.0.1:${port}/auth/export-credential`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const raw = await resp.text();
    let parsed: { error?: { message?: string }; bundle?: unknown } = {};
    try { parsed = JSON.parse(raw) as { error?: { message?: string }; bundle?: unknown }; } catch { /* */ }
    if (!resp.ok) throw new Error(parsed.error?.message || raw.slice(0, 240) || `export failed on :${port}`);
    return { cred: await credentialFromUnknown(parsed.bundle ?? parsed), storeDir: listed.storeDir };
  }

  const storeDir = existsSync(join(root, `.credentials-${port}`))
    ? join(root, `.credentials-${port}`)
    : join(root, ".credentials");
  const cred = await loadCredentialFromDir(storeDir);
  if (!cred) throw new Error(`no credential file in ${storeDir}`);
  return { cred, storeDir };
}
