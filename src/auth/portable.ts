/**
 * Portable credential bundle shared with zcode-cred-tool.
 * kind = "zcode-proxy-credential" is machine-unlocked JSON (apiKey/jwt inside).
 * Encrypted credentials.json ({encrypted}) is NOT portable and must be rejected.
 */
import type { Credential } from "./types.js";

export const PORTABLE_KIND = "zcode-proxy-credential";
export const PORTABLE_VERSION = 1;

export interface PortableCredentialBundle {
  kind: typeof PORTABLE_KIND;
  version: number;
  exportedAt?: string;
  source?: { homedir?: string; platform?: string; arch?: string; store?: string };
  credential: Credential;
}

export function previewKey(key: string): string {
  if (!key) return "(empty)";
  if (key.length <= 12) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function credentialAccountView(cred: Credential) {
  return {
    provider: cred.provider,
    userId: cred.userId ?? null,
    apiKeyPreview: previewKey(cred.apiKey),
    hasJwt: Boolean(cred.jwt),
    jwtPreview: cred.jwt ? previewKey(cred.jwt) : null,
  };
}

export function toPortableCredential(
  cred: Credential,
  source?: PortableCredentialBundle["source"],
): PortableCredentialBundle {
  return {
    kind: PORTABLE_KIND,
    version: PORTABLE_VERSION,
    exportedAt: new Date().toISOString(),
    ...(source ? { source } : {}),
    credential: cred,
  };
}

/**
 * Accepts:
 * - { kind: "zcode-proxy-credential", credential: {...} }
 * - { bundle: <that> }
 * - { credential: {...} }
 * - a raw Credential object
 * Rejects machine-locked `{ encrypted }` files.
 */
export function unwrapPortableCredential(input: unknown): Credential {
  if (input == null || typeof input !== "object") throw new Error("import body must be JSON");
  const root = input as Record<string, unknown>;
  if (typeof root.encrypted === "string" && root.kind !== PORTABLE_KIND) {
    throw new Error("this is a machine-locked credentials.json; import zcode-proxy-credential.json from the key tool");
  }
  const inner =
    root.kind === PORTABLE_KIND && root.credential && typeof root.credential === "object" ? root.credential
    : root.bundle && typeof root.bundle === "object"
      ? unwrapInnerBundle(root.bundle)
    : root.credential && typeof root.credential === "object" ? root.credential
    : root;
  const cred = inner as Record<string, unknown>;
  const provider = cred.provider;
  if (provider !== "zai" && provider !== "bigmodel") throw new Error("credential.provider must be zai or bigmodel");
  const apiKey = typeof cred.apiKey === "string" ? cred.apiKey.trim() : "";
  const jwt = typeof cred.jwt === "string" ? cred.jwt.trim() : "";
  if (!apiKey && !jwt) throw new Error("credential needs apiKey or jwt");
  const out: Credential = { provider, apiKey: apiKey || jwt };
  if (typeof cred.secret === "string" && cred.secret.trim()) out.secret = cred.secret.trim();
  if (jwt) out.jwt = jwt;
  if (typeof cred.userId === "string" && cred.userId.trim()) out.userId = cred.userId.trim();
  if (typeof cred.expiresAt === "number" && Number.isFinite(cred.expiresAt)) out.expiresAt = cred.expiresAt;
  return out;
}

function unwrapInnerBundle(bundle: unknown): Record<string, unknown> {
  if (bundle == null || typeof bundle !== "object") throw new Error("bundle must be an object");
  const b = bundle as Record<string, unknown>;
  if (typeof b.encrypted === "string" && b.kind !== PORTABLE_KIND) {
    throw new Error("this is a machine-locked credentials.json; import zcode-proxy-credential.json from the key tool");
  }
  if (b.kind === PORTABLE_KIND && b.credential && typeof b.credential === "object") {
    return b.credential as Record<string, unknown>;
  }
  if (b.credential && typeof b.credential === "object") return b.credential as Record<string, unknown>;
  return b;
}
