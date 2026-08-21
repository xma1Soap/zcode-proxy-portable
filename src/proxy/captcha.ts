/**
 * Aliyun Captcha V3 solver — real Edge via CDP.
 *
 * Why not jsdom: the SDK's verification calls go through jsdom's XHR, which
 * on Windows runs against Bun's node:https TLS stack. Bun's BoringSSL fails
 * certificate verification for several aliyuncs.com endpoints ("unknown
 * certificate verification error") no matter what strictSSL flag or env var
 * is set, so the solve always ended in verifyCode F001. A fetch-backed XHR
 * shim fixed the transport, but then the risk engine degraded the traceless
 * verification to a puzzle slider (the fingerprint is not plausible), which
 * needs a real canvas for gap detection and fails without human-like input.
 *
 * Solution: run the SDK inside real Edge (Chromium) launched headful (not
 * headless — headless fingerprints trigger the slider). The traceless
 * verification then passes transparently in the common case. If the risk
 * engine still shows the puzzle slider, we detect the gap from the puzzle
 * image via canvas edge analysis and drag the slider with a human-like
 * trajectory through CDP input events.
 *
 * Edge is driven purely via the CDP protocol (fetch + WebSocket), no
 * puppeteer dependency, so `bun build --compile` keeps emitting a single
 * binary. Requires a local Chrome / Edge / Chromium install (Windows or Linux).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ALIYUN_SDK_LOCAL from "./AliyunCaptcha.js.txt" with { type: "text" };
import { browserSearchPaths, listCaptchaBrowserLaunches, type BrowserLaunch } from "./browser-launch.js";

export { browserSearchPaths } from "./browser-launch.js";

const CAPTCHA_HEADER = "x-aliyun-captcha-verify-param";
const REGION_HEADER = "x-aliyun-captcha-verify-region";
const CONFIGS_API = "https://zcode.z.ai/api/v1/client/configs";

function captchaPlatformQuery(): string {
  if (process.platform === "win32") return "win32-x64";
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
}

/** CDP listen port for this process. Derived from ZCODE_PROXY_PORT so instances do not collide. */
export function preferredCaptchaCdpPort(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = Number(env.ZCODE_CAPTCHA_CDP_PORT);
  if (Number.isInteger(explicit) && explicit > 0 && explicit <= 65535) return explicit;
  const listen = Number(env.ZCODE_PROXY_PORT);
  if (Number.isInteger(listen) && listen > 0 && listen <= 65535) {
    const derived = 10000 + listen;
    if (derived <= 65535) return derived;
    return 20000 + (listen % 40000);
  }
  return 9341;
}

async function isTcpPortFree(port: number): Promise<boolean> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function allocateCaptchaCdpPort(start: number = preferredCaptchaCdpPort()): Promise<number> {
  for (let port = start; port < start + 32 && port <= 65535; port++) {
    if (await isTcpPortFree(port)) return port;
  }
  throw new Error(`no free captcha CDP port near ${start}`);
}

/** How many times to retry a single captcha solve. Overridable via env. */
const SOLVE_RETRIES = Number(process.env.ZCODE_CAPTCHA_RETRIES || 3);
/** Per-attempt solve+slide timeout (ms). */
const SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_TIMEOUT_MS || 60_000);

interface FetchedCaptchaConfig { enabled: boolean; prefix: string; sceneId: string; region: string; }

export function detectCaptchaChallenge(resp: Response): string | null {
  const v = resp.headers.get(CAPTCHA_HEADER);
  return v && v.trim().length > 0 ? v.trim() : null;
}

export function invalidateCaptchaToken(): void { /* tokens are one-shot; nothing to invalidate */ }

async function fetchCaptchaConfig(appVersion: string): Promise<FetchedCaptchaConfig | null> {
  try {
    const resp = await fetch(`${CONFIGS_API}?app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(captchaPlatformQuery())}`, {
      signal: AbortSignal.timeout(3000),
    });
    const json = (await resp.json()) as { data?: { configs?: { captcha?: FetchedCaptchaConfig } } };
    return json?.data?.configs?.captcha ?? null;
  } catch { return null; }
}

export async function getCaptchaToken(appVersion: string): Promise<{ verifyParam: string; region: string }> {
  // Verify params are one-shot (the gateway rejects a reused param with 3007),
  // so every call solves fresh. The persistent Edge session keeps this fast
  // (~1-3s) — no token caching.
  const cfg = await fetchCaptchaConfig(appVersion);
  if (!cfg || !cfg.enabled || !cfg.prefix || !cfg.sceneId) throw new Error("Captcha config unavailable");
  const verifyParam = await solveWithRetry(cfg);
  return { verifyParam, region: cfg.region };
}

async function solveWithRetry(cfg: FetchedCaptchaConfig): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= SOLVE_RETRIES; attempt++) {
    try {
      return await solveViaEdge(cfg);
    } catch (err) {
      lastErr = err as Error;
      console.error(`[captcha] solve attempt ${attempt}/${SOLVE_RETRIES} failed: ${lastErr.message}`);
    }
  }
  throw new Error(`captcha solve failed after ${SOLVE_RETRIES} attempts: ${lastErr?.message ?? "unknown"}`);
}

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------

function chromeFlags(cdpPort: number, userData: string): string[] {
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userData}`,
    "--no-first-run",
    "--disable-extensions",
    "--mute-audio",
    "--disable-dev-shm-usage",
    "--window-size=800,700",
    "about:blank",
  ];
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (asRoot || process.env.ZCODE_CAPTCHA_NO_SANDBOX === "1") {
    args.splice(4, 0, "--no-sandbox", "--disable-setuid-sandbox");
  }
  return args;
}

const CDP_CALL_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_CDP_TIMEOUT_MS || 20_000);

function cdpCall(ws: WebSocket, id: number, method: string, params: any, timeoutMs = CDP_CALL_TIMEOUT_MS): Promise<any> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onErr);
      if (err) reject(err);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`${method}: timeout after ${timeoutMs}ms`)), timeoutMs);
    const onMsg = (ev: any) => {
      let msg: any;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (msg.id !== id) return;
      if (msg.error) finish(new Error(method + ": " + JSON.stringify(msg.error)));
      else finish(undefined, msg.result);
    };
    const onClose = () => finish(new Error(`${method}: websocket closed`));
    const onErr = () => finish(new Error(`${method}: websocket error`));
    ws.addEventListener("message", onMsg);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onErr);
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

async function waitForJson(url: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error("timeout waiting for " + url);
}



// ---------------------------------------------------------------------------
// Page-side scripts (run inside Edge via Runtime.evaluate)
// ---------------------------------------------------------------------------

const BOOT_SCRIPT = (cfg: FetchedCaptchaConfig) => `window.AliyunCaptchaConfig = ${JSON.stringify({ region: cfg.region, prefix: cfg.prefix })};
window.__captchaResult = null;
try {
  initAliyunCaptcha({
    SceneId: ${JSON.stringify(cfg.sceneId)}, mode: "popup", region: ${JSON.stringify(cfg.region)},
    prefix: ${JSON.stringify(cfg.prefix)}, language: "en",
    element: "#captcha-element", button: "#captcha-button", captchaLogoImg: "", showErrorTip: false,
    getInstance: (inst) => { window.__inst = inst; window.__started = true; try { inst.startTracelessVerification(); } catch (e) { window.__captchaResult = { ok:false, err: "start threw: "+e }; } },
    success: (param) => { window.__captchaResult = { ok: true, param }; },
    fail: (err) => { window.__captchaResult = { ok: false, err: JSON.stringify(err) }; },
    onError: (err) => { window.__captchaResult = { ok: false, err: JSON.stringify(err) }; },
  });
} catch (e) { window.__captchaResult = { ok:false, err: "init threw: "+e }; }`;

const GAP_DETECT_SCRIPT = `(() => {
  try {
    const imgs = document.images;
    if (imgs.length < 2) return JSON.stringify({ err: 'images=' + imgs.length });
    const bg = imgs[0];
    const edgeOf = (img) => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const w = c.width, h = c.height;
      const edge = new Float32Array(w*h);
      for (let y = 1; y < h; y++) {
        for (let x = 1; x < w; x++) {
          const i = (y*w+x)*4;
          const gx = Math.abs(d[i]-d[i-4]) + Math.abs(d[i+1]-d[i-3]) + Math.abs(d[i+2]-d[i-2]);
          const gy = Math.abs(d[i]-d[i-w*4]) + Math.abs(d[i+1]-d[i-w*4+1]) + Math.abs(d[i+2]-d[i-w*4+2]);
          edge[y*w+x] = gx + gy;
        }
      }
      return { edge, w, h, data: d };
    };
    const B = edgeOf(bg);
    const prof = [];
    for (let x = 1; x < B.w; x++) {
      let s = 0;
      for (let y = 0; y < B.h; y += 2) s += B.edge[y*B.w + x];
      prof.push({ x, s });
    }
    const colLum = (x) => {
      let L = 0;
      for (let y = 0; y < B.h; y += 3) {
        const i = (y*B.w + x)*4;
        L += 0.299*B.data[i] + 0.587*B.data[i+1] + 0.114*B.data[i+2];
      }
      return L / (B.h/3);
    };
    const byX = prof.slice().sort((a,b) => a.x - b.x);
    let gapBest = -1;
    for (const p of byX) {
      if (p.x < 80 || p.x > 270) continue;
      const left = byX.filter(q => q.x >= p.x - 3 && q.x < p.x).reduce((m,q) => Math.max(m,q.s), 0);
      const right = byX.filter(q => q.x > p.x && q.x <= p.x + 3).reduce((m,q) => Math.max(m,q.s), 0);
      if (p.s < left || p.s < right) continue;
      if (p.s < 3500) continue;
      const rightEdge = byX.filter(q => q.x >= p.x + 48 && q.x <= p.x + 56).reduce((m,q) => Math.max(m,q.s), 0);
      if (rightEdge < 2500) continue;
      const L0 = colLum(p.x - 3), L1 = colLum(p.x + 3);
      if (Math.abs(L0 - L1) > 6) { gapBest = p.x; break; }
    }
    return JSON.stringify({ bw: B.w, bh: B.h, gapX: gapBest });
  } catch (e) { return JSON.stringify({ err: String(e) }); }
})()`;

const BUTTON_POS_SCRIPT = `(() => { const b = document.querySelector('.slider-move'); if (!b) return null; const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 }); })()`;

const STATE_SCRIPT = `(() => {
  const imgs = document.images.length;
  const slider = !!document.querySelector('.slider-move');
  const done = window.__captchaResult;
  return JSON.stringify({ imgs, slider, done });
})()`;

// Headful Edge is required: headless fingerprints force the puzzle slider.

interface EdgeSession {
  proc: ReturnType<typeof spawn>;
  ws: WebSocket;
  pageId: string;
  userData: string;
  cdpId: () => number;
}

let edgeSession: EdgeSession | null = null;
let sessionLock: Promise<void> = Promise.resolve();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const prev = sessionLock;
  sessionLock = new Promise<void>((res) => { release = res; });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function destroySession(): Promise<void> {
  const s = edgeSession;
  edgeSession = null;
  if (s) {
    try { s.ws.close(); } catch {}
    try { s.proc.kill(); } catch {}
    setTimeout(() => { try { rmSync(s.userData, { recursive: true, force: true }); } catch {} }, 1500);
  }
}

export async function destroyCaptchaSession(): Promise<void> {
  await destroySession();
}

async function startSessionWith(launch: BrowserLaunch, html: string): Promise<EdgeSession> {
  const cdpPort = await allocateCaptchaCdpPort();
  const userData = mkdtempSync(join(tmpdir(), "zcode-captcha-"));
  const flags = chromeFlags(cdpPort, userData);
  const wrapped = launch.cmd.endsWith("flatpak") || launch.cmd.endsWith("snap") || launch.prefixArgs[0] === "run";
  const args = wrapped ? [...launch.prefixArgs, "--", ...flags] : [...launch.prefixArgs, ...flags];
  const proc = spawn(launch.cmd, args, { stdio: "ignore" });
  try {
    await waitForJson(`http://127.0.0.1:${cdpPort}/json/version`, 15_000);
    const newPage = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: "PUT" });
    const page: any = await newPage.json();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("cdp ws timeout")), 15_000);
      ws.addEventListener("open", () => { clearTimeout(t); res(); });
      ws.addEventListener("error", () => { clearTimeout(t); rej(new Error("cdp ws error")); });
    });
    const cdpId = (() => { let n = 1; return () => n++; })();
    await cdpCall(ws, cdpId(), "Page.enable", {});
    await cdpCall(ws, cdpId(), "Runtime.enable", {});
    await cdpCall(ws, cdpId(), "Page.setDocumentContent", { frameId: page.id, html });
    return { proc, ws, pageId: page.id, userData, cdpId };
  } catch (err) {
    try { proc.kill(); } catch {}
    setTimeout(() => { try { rmSync(userData, { recursive: true, force: true }); } catch {} }, 1500);
    throw err;
  }
}

async function getEdgeSession(): Promise<EdgeSession> {
  const s = edgeSession;
  if (s && s.ws.readyState === WebSocket.OPEN) return s;
  await destroySession();

  if (process.platform !== "win32" && process.platform !== "darwin" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error("[captcha] no DISPLAY/WAYLAND_DISPLAY; start-plan captcha needs a desktop session");
  }

  const launches = listCaptchaBrowserLaunches();
  if (launches.length === 0) {
    throw new Error("No Chromium-based browser found; install Chromium/Chrome/Brave or set ZCODE_EDGE_PATH");
  }

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="captcha-element"></div><button id="captcha-button"></button><script>${ALIYUN_SDK_LOCAL.replace(/<\/script>/gi, "<\\/script>")}</script></body></html>`;
  const errors: string[] = [];
  for (const launch of launches) {
    try {
      console.error(`[captcha] trying browser ${launch.label} (${launch.cmd})`);
      const sess = await startSessionWith(launch, html);
      edgeSession = sess;
      return sess;
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(`${launch.label}: ${msg}`);
      console.error(`[captcha] ${launch.label} failed: ${msg}`);
    }
  }
  throw new Error(`no browser accepted CDP:\n${errors.join("\n")}`);
}

function parseEvalJson(raw: unknown, fallback: unknown): any {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function solveViaEdge(cfg: FetchedCaptchaConfig): Promise<string> {
  return withSessionLock(async () => {
    try {
      const sess = await getEdgeSession();
      const { ws, cdpId } = sess;

      await cdpCall(ws, cdpId(), "Runtime.evaluate", { expression: BOOT_SCRIPT(cfg) });

      const deadline = Date.now() + SOLVE_TIMEOUT_MS;
      let slid = false;

      while (Date.now() < deadline) {
        await sleep(600);
        const st = await cdpCall(ws, cdpId(), "Runtime.evaluate", { expression: STATE_SCRIPT, returnByValue: true });
        const stInfo = parseEvalJson(st?.result?.value, {});

        if (stInfo.done) {
          const res = stInfo.done;
          if (res.ok) return res.param as string;
          throw new Error(`SDK fail: ${JSON.stringify(res.err)}`);
        }

        if (stInfo.slider && stInfo.imgs >= 2 && !slid) {
          slid = true;
          console.error("[captcha] puzzle slider shown, auto-solving");
          const gap = await cdpCall(ws, cdpId(), "Runtime.evaluate", { expression: GAP_DETECT_SCRIPT, returnByValue: true });
          const gapInfo = parseEvalJson(gap?.result?.value, {});
          if (typeof gapInfo.gapX !== "number" || gapInfo.gapX < 0) {
            throw new Error("gap detection failed: " + JSON.stringify(gapInfo));
          }

          const btn = await cdpCall(ws, cdpId(), "Runtime.evaluate", { expression: BUTTON_POS_SCRIPT, returnByValue: true });
          const btnPos = parseEvalJson(btn?.result?.value, null);
          if (!btnPos || typeof btnPos.x !== "number" || typeof btnPos.y !== "number") {
            throw new Error("no slider button");
          }

          const startX = btnPos.x, startY = btnPos.y;
          const gapX = gapInfo.gapX;
          const steps = 30 + Math.floor(Math.random() * 8);
          const pts: Array<{ x: number; y: number }> = [];
          for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const eased = 1 - Math.pow(1 - t, 3);
            const jitter = (Math.random() - 0.5) * 2.2;
            const yOff = Math.sin(i * 0.55) * 1.8 + (Math.random() - 0.5) * 1.2;
            pts.push({ x: startX + gapX * eased + jitter, y: startY + yOff });
          }
          pts[pts.length - 1] = { x: startX + gapX, y: startY };

          await cdpCall(ws, cdpId(), "Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(startX), y: Math.round(startY) });
          await cdpCall(ws, cdpId(), "Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(startX), y: Math.round(startY), button: "left", clickCount: 1 });
          for (const p of pts) {
            await cdpCall(ws, cdpId(), "Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(p.x), y: Math.round(p.y), button: "left", buttons: 1 });
            await sleep(8 + Math.random() * 18);
          }
          await cdpCall(ws, cdpId(), "Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(pts[pts.length - 1].x), y: Math.round(pts[pts.length - 1].y), button: "left", clickCount: 1 });
          console.error(`[captcha] dragged to gapX=${gapX}`);
        }
      }
      throw new Error("captcha solve timeout");
    } catch (err) {
      await destroySession();
      throw err;
    }
  });
}

export const RETRY_HEADERS = { PARAM: CAPTCHA_HEADER, REGION: REGION_HEADER };