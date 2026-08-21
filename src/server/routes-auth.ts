/**
 * WebUI OAuth login: start a provider login, accept the browser callback on
 * this same proxy, persist credentials, and hot-swap the live AuthManager.
 */
import type { AuthManager } from "../auth/manager.js";
import type { Credential } from "../auth/types.js";
import { KeyResolver } from "../auth/resolver.js";
import { ZaiOAuthClient, BigmodelOAuthClient, type FetchFn } from "../auth/oauth.js";
import { saveCredential as defaultSave, loadCredential as defaultLoad, clearCredential as defaultClear } from "../auth/store.js";
import { detectZcodeProvider, importFromZCodeConfig, peekZcodeLogin } from "../auth/zcode-import.js";
import { credentialAccountView, toPortableCredential } from "../auth/portable.js";
import { credentialFromUnknown, getStorePath } from "../auth/store.js";
import { homedir } from "node:os";
import type { ProviderId } from "../provider/types.js";
import type { ProxyConfig } from "../config/types.js";
import { errorResponse } from "../proxy/handler.js";

const LOGIN_TTL_MS = 300_000;

export interface WebLoginDeps {
  auth: AuthManager;
  config: ProxyConfig;
  fetchImpl?: FetchFn;
  resolveCredential?: (accessToken: string, provider: ProviderId, userId?: string) => Promise<Credential>;
  saveCredential?: (cred: Credential) => Promise<void>;
  loadCredential?: () => Promise<Credential | null>;
  clearCredential?: () => void;
  now?: () => number;
}

interface PendingLogin {
  provider: ProviderId;
  state: string;
  callbackUrl: string;
  authorizeUrl: string;
  startedAt: number;
  client: ZaiOAuthClient | BigmodelOAuthClient;
}

export class WebLoginService {
  private pending: PendingLogin | null = null;
  private lastError: string | null = null;
  private readonly now: () => number;
  private readonly fetchImpl: FetchFn;
  private readonly saveCredential: (cred: Credential) => Promise<void>;
  private readonly loadCredential: () => Promise<Credential | null>;
  private readonly clearCredential: () => void;
  private readonly resolveCredential: (accessToken: string, provider: ProviderId, userId?: string) => Promise<Credential>;

  constructor(private readonly deps: WebLoginDeps) {
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.saveCredential = deps.saveCredential ?? defaultSave;
    this.loadCredential = deps.loadCredential ?? defaultLoad;
    this.clearCredential = deps.clearCredential ?? defaultClear;
    this.resolveCredential = deps.resolveCredential ?? (async (accessToken, provider, userId) => {
      const resolver = new KeyResolver(this.fetchImpl);
      return resolver.resolveCodingPlanCredential(accessToken, provider, userId);
    });
  }

  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "GET" && path === "/auth/callback") {
      return this.handleCallback(req);
    }
    if (method === "GET" && path === "/auth/status") {
      return this.status();
    }
    if (method === "POST" && path === "/auth/login") {
      return this.startLogin(req);
    }
    if (method === "POST" && path === "/auth/logout") {
      return this.logout();
    }
    if (method === "POST" && path === "/auth/import-zcode") {
      return this.importFromZcode(req);
    }
    if (method === "POST" && path === "/auth/import-credential") {
      return this.importPortable(req);
    }
    if (method === "POST" && path === "/auth/export-credential") {
      return this.exportPortable();
    }
    return null;
  }

  /** Login UI must work before any proxy API key is entered. */
  static isPublicPath(path: string, method: string): boolean {
    if (path === "/auth/callback" && method === "GET") return true;
    if (path === "/auth/status" && method === "GET") return true;
    if (path === "/auth/login" && method === "POST") return true;
    if (path === "/auth/logout" && method === "POST") return true;
    return false;
  }

  private expirePending(): PendingLogin | null {
    if (!this.pending) return null;
    if (this.now() - this.pending.startedAt > LOGIN_TTL_MS) {
      this.lastError = "Login timed out. Try again.";
      this.pending = null;
      return null;
    }
    return this.pending;
  }

  private publicOrigin(req: Request): string {
    const url = new URL(req.url);
    const xfProto = req.headers.get("x-forwarded-proto");
    const xfHost = req.headers.get("x-forwarded-host");
    const host = (xfHost ?? req.headers.get("host") ?? url.host).split(",")[0]!.trim();
    const proto = (xfProto ?? url.protocol.replace(":", "") ?? "http").split(",")[0]!.trim();
    return `${proto}://${host}`;
  }

  private parseProvider(raw: unknown, fallback: ProviderId): ProviderId {
    if (raw === "zai" || raw === "bigmodel") return raw;
    return fallback;
  }

  async startLogin(req: Request): Promise<Response> {
    let body: { provider?: unknown } = {};
    const text = await req.text();
    if (text.trim()) {
      try {
        body = JSON.parse(text) as { provider?: unknown };
      } catch {
        return errorResponse(400, "invalid_request_error", "Login body must be JSON");
      }
    }
    const provider = this.parseProvider(body.provider, this.deps.config.provider);
    const callbackUrl = `${this.publicOrigin(req)}/auth/callback`;
    const client = provider === "bigmodel"
      ? new BigmodelOAuthClient(this.fetchImpl)
      : new ZaiOAuthClient(this.fetchImpl);
    const prepared = client.prepare(callbackUrl);
    this.pending = {
      provider,
      state: prepared.state,
      callbackUrl,
      authorizeUrl: prepared.authorizeUrl,
      startedAt: this.now(),
      client,
    };
    this.lastError = null;
    return json(200, {
      ok: true,
      provider,
      authorizeUrl: prepared.authorizeUrl,
      callbackUrl,
      expiresIn: Math.floor(LOGIN_TTL_MS / 1000),
    });
  }

  async handleCallback(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("authCode") ?? url.searchParams.get("code") ?? "";
    const pending = this.expirePending();

    if (!pending) {
      return callbackPage(400, false, "No login is in progress. Open /webui and click Log in again.");
    }
    if (!code || state !== pending.state) {
      this.lastError = "OAuth callback state mismatch or missing code.";
      this.pending = null;
      return callbackPage(400, false, this.lastError);
    }

    try {
      const { accessToken, userId, jwt } = await pending.client.exchangeCode(
        code,
        pending.callbackUrl,
        pending.state,
      );
      const cred = await this.resolveCredential(accessToken, pending.provider, userId);
      if (jwt) cred.jwt = jwt;
      await this.saveCredential(cred);
      this.deps.auth.setOAuthCredential(cred);
      this.pending = null;
      this.lastError = null;
      return callbackPage(200, true, "Logged in. You can close this tab and return to zcode-proxy.");
    } catch (err) {
      this.lastError = (err as Error).message;
      this.pending = null;
      return callbackPage(500, false, `Login failed: ${this.lastError}`);
    }
  }

  async status(): Promise<Response> {
    const pending = this.expirePending();
    const stored = await this.loadCredential().catch(() => null);
    if (stored && this.deps.auth.getMode() === "oauth" && !this.deps.auth.peekOAuthCredential()) {
      this.deps.auth.setOAuthCredential(stored);
    }
    const oauth = this.deps.auth.peekOAuthCredential() ?? stored;
    const account = oauth ? credentialAccountView(oauth) : null;

    return json(200, {
      ok: true,
      authMode: this.deps.auth.getMode(),
      provider: this.deps.config.provider,
      plan: this.deps.config.plan,
      live: this.deps.auth.hasLiveCredential(),
      loggedIn: account != null,
      account,
      pending: pending
        ? {
            provider: pending.provider,
            authorizeUrl: pending.authorizeUrl,
            startedAt: pending.startedAt,
            expiresAt: pending.startedAt + LOGIN_TTL_MS,
          }
        : null,
      lastError: this.lastError,
      zcode: {
        selected: detectZcodeProvider() ?? this.deps.config.provider,
        zai: peekZcodeLogin("zai"),
        bigmodel: peekZcodeLogin("bigmodel"),
      },
    });
  }

  async importFromZcode(req: Request): Promise<Response> {
    let body: { provider?: unknown } = {};
    const text = await req.text();
    if (text.trim()) {
      try {
        body = JSON.parse(text) as { provider?: unknown };
      } catch {
        return errorResponse(400, "invalid_request_error", "Import body must be JSON");
      }
    }
    const detected = detectZcodeProvider();
    const provider = body.provider === "zai" || body.provider === "bigmodel"
      ? body.provider
      : (detected ?? this.deps.config.provider);
    try {
      const cred = importFromZCodeConfig(provider);
      await this.saveCredential(cred);
      this.deps.auth.setOAuthCredential(cred);
      this.lastError = null;
      return json(200, {
        ok: true,
        source: "zcode",
        loggedIn: true,
        account: credentialAccountView(cred),
      });
    } catch (err) {
      this.lastError = (err as Error).message;
      return errorResponse(400, "invalid_request_error", this.lastError);
    }
  }

  async applyPortable(raw: unknown): Promise<Credential> {
    const cred = await credentialFromUnknown(raw);
    await this.saveCredential(cred);
    this.deps.auth.setOAuthCredential(cred);
    this.lastError = null;
    return cred;
  }

  async exportPortable(): Promise<Response> {
    const stored = await this.loadCredential().catch(() => null);
    const cred = this.deps.auth.peekOAuthCredential() ?? stored;
    if (!cred) {
      return errorResponse(400, "invalid_request_error", "no credential on this port to export");
    }
    return json(200, {
      ok: true,
      source: "decrypt",
      account: credentialAccountView(cred),
      bundle: toPortableCredential(cred, {
        homedir: homedir(),
        platform: process.platform,
        arch: process.arch,
        store: getStorePath(),
      }),
    });
  }

  async importPortable(req: Request): Promise<Response> {
    let body: unknown = {};
    const text = await req.text();
    if (text.trim()) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return errorResponse(400, "invalid_request_error", "Import body must be JSON");
      }
    }
    try {
      const cred = await this.applyPortable(body);
      return json(200, {
        ok: true,
        source: "portable",
        loggedIn: true,
        account: credentialAccountView(cred),
      });
    } catch (err) {
      this.lastError = (err as Error).message;
      return errorResponse(400, "invalid_request_error", this.lastError);
    }
  }

  async logout(): Promise<Response> {
    this.pending = null;
    this.lastError = null;
    this.deps.auth.clearOAuthCredential();
    this.clearCredential();
    return json(200, { ok: true, loggedIn: false });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function callbackPage(status: number, ok: boolean, message: string): Response {
  const title = ok ? "Login successful" : "Login failed";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;background:#212121;color:#ececec;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{max-width:420px;padding:28px 24px;border:1px solid #3a3a3a;border-radius:16px;background:#2f2f2f;text-align:center}
  h1{font-size:18px;margin:0 0 8px}
  p{color:#9a9a9a;margin:0 0 16px;line-height:1.5}
  a{color:#818cf8}
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
<p><a href="/webui">Return to WebUI</a></p></div>
<script>
try{if(window.opener)window.opener.postMessage({__zcodeOauth:true,ok:${ok ? "true" : "false"}},"*");}catch(e){}
setTimeout(function(){try{window.close()}catch(e){}},1200);
</script></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
