/**
 * Read official ZCode desktop login from ~/.zcode/v2/config.json
 * and turn it into a proxy Credential (coding-plan apiKey + start-plan JWT).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Credential } from "./types.js";
import type { ProviderId } from "../provider/types.js";

export function zcodeConfigPath(home: string = homedir()): string {
  return join(home, ".zcode", "v2", "config.json");
}

export interface ZcodePeek {
  exists: boolean;
  path: string;
  provider: ProviderId;
  hasApiKey: boolean;
  hasJwt: boolean;
  enabled: boolean;
  apiKeyPreview: string | null;
  jwtPreview: string | null;
}

function preview(key: string): string {
  if (key.length <= 12) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function userIdFromJwt(jwt: string): string | undefined {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return undefined;
    const json = Buffer.from(parts[1]!, "base64url").toString("utf-8");
    const payload = JSON.parse(json) as { user_id?: unknown; sub?: unknown };
    const id = payload.user_id ?? payload.sub;
    return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
  } catch {
    return undefined;
  }
}

function readZcodeProvider(provider: ProviderId, home: string = homedir()): {
  path: string;
  apiKey: string;
  jwt: string;
  enabled: boolean;
} {
  const path = zcodeConfigPath(home);
  if (!existsSync(path)) throw new Error(`ZCode config not found: ${path}. Log in with the ZCode app first.`);
  const config = JSON.parse(readFileSync(path, "utf-8")) as {
    provider?: Record<string, { options?: { apiKey?: string }; enabled?: boolean }>;
  };
  const coding = config.provider?.[`builtin:${provider}-coding-plan`];
  const start = config.provider?.[`builtin:${provider}-start-plan`];
  return {
    path,
    apiKey: coding?.options?.apiKey?.trim() ?? "",
    jwt: start?.options?.apiKey?.trim() ?? "",
    enabled: start?.enabled === true || coding?.enabled === true,
  };
}

export function peekZcodeLogin(provider: ProviderId, home: string = homedir()): ZcodePeek {
  const path = zcodeConfigPath(home);
  if (!existsSync(path)) {
    return {
      exists: false,
      path,
      provider,
      hasApiKey: false,
      hasJwt: false,
      enabled: false,
      apiKeyPreview: null,
      jwtPreview: null,
    };
  }
  try {
    const raw = readZcodeProvider(provider, home);
    return {
      exists: true,
      path,
      provider,
      hasApiKey: Boolean(raw.apiKey),
      hasJwt: Boolean(raw.jwt),
      enabled: raw.enabled,
      apiKeyPreview: raw.apiKey ? preview(raw.apiKey) : null,
      jwtPreview: raw.jwt ? preview(raw.jwt) : null,
    };
  } catch {
    return {
      exists: true,
      path,
      provider,
      hasApiKey: false,
      hasJwt: false,
      enabled: false,
      apiKeyPreview: null,
      jwtPreview: null,
    };
  }
}

/** Prefer an enabled start-plan, otherwise any provider that still has a key. */
export function detectZcodeProvider(home: string = homedir()): ProviderId | null {
  const order: ProviderId[] = ["zai", "bigmodel"];
  for (const provider of order) {
    const peek = peekZcodeLogin(provider, home);
    if (peek.hasJwt && peek.enabled) return provider;
  }
  for (const provider of order) {
    const peek = peekZcodeLogin(provider, home);
    if (peek.hasJwt || peek.hasApiKey) return provider;
  }
  return null;
}

/** Copy ZCode's stored provider keys into a proxy Credential. */
export function importFromZCodeConfig(provider: ProviderId, home: string = homedir()): Credential {
  const raw = readZcodeProvider(provider, home);
  if (!raw.apiKey && !raw.jwt) {
    throw new Error(`No ${provider} API key or start-plan JWT in ${raw.path}`);
  }
  const cred: Credential = { provider, apiKey: raw.apiKey || raw.jwt };
  if (raw.jwt) {
    cred.jwt = raw.jwt;
    const userId = userIdFromJwt(raw.jwt);
    if (userId) cred.userId = userId;
  }
  return cred;
}
