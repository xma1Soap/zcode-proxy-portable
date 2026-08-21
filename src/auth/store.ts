/**
 * Encrypted file-based credential store.
 * @see .omo/plans/zcode-proxy.md Task 14
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Credential } from "./types.js";
import { PORTABLE_KIND, unwrapPortableCredential } from "./portable.js";

const ENV_SECRET = "ZCODE_PROXY_CREDENTIAL_SECRET";
const ENV_STORE_DIR = "ZCODE_PROXY_STORE_DIR";

function getStoreDir(): string {
  const override = process.env[ENV_STORE_DIR]?.trim();
  if (override) return override;
  return join(homedir(), ".zcode-proxy");
}

function getStoreFile(): string {
  return join(getStoreDir(), "credentials.json");
}

function getEncryptionKey() {
  const hash = new Uint8Array(new ArrayBuffer(32));
  const encoder = new TextEncoder();

  const seed = process.env[ENV_SECRET] ?? `${homedir()}-${process.platform}-${process.arch}`;
  const seedBytes = encoder.encode(seed);
  for (let i = 0; i < seedBytes.length; i++) {
    hash[i % 32] ^= seedBytes[i];
  }
  return hash;
}

async function encrypt(plaintext: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    getEncryptionKey(),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return Buffer.from(combined).toString("base64");
}

async function decrypt(ciphertext: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    getEncryptionKey(),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  const combined = Buffer.from(ciphertext, "base64");
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    data,
  );

  return new TextDecoder().decode(decrypted);
}

export async function saveCredentialToDir(dir: string, cred: Credential): Promise<string> {
  const file = join(dir, "credentials.json");
  mkdirSync(dirname(file), { recursive: true });
  const encrypted = await encrypt(JSON.stringify(cred));
  writeFileSync(file, JSON.stringify({ encrypted }), { mode: 0o600 });
  return file;
}

export async function saveCredential(cred: Credential): Promise<void> {
  await saveCredentialToDir(getStoreDir(), cred);
}

/** True when the JSON is a machine-locked credentials.json ({encrypted}), not a portable bundle. */
export function isMachineLockedBlob(input: unknown): boolean {
  if (input == null || typeof input !== "object") return false;
  const root = input as Record<string, unknown>;
  if (typeof root.encrypted === "string" && root.kind !== PORTABLE_KIND) return true;
  const bundle = root.bundle;
  if (bundle && typeof bundle === "object") {
    const b = bundle as Record<string, unknown>;
    return typeof b.encrypted === "string" && b.kind !== PORTABLE_KIND;
  }
  return false;
}

function lockedPayload(input: unknown): { encrypted: string } {
  const root = input as Record<string, unknown>;
  if (typeof root.encrypted === "string") return { encrypted: root.encrypted };
  const bundle = root.bundle as Record<string, unknown> | undefined;
  if (bundle && typeof bundle.encrypted === "string") return { encrypted: bundle.encrypted };
  throw new Error("missing encrypted");
}

/** Decrypt a machine-locked credentials.json using this process's identity. */
export async function decryptEncryptedFile(raw: unknown): Promise<Credential> {
  const { encrypted } = lockedPayload(raw);
  let json: string;
  try {
    json = await decrypt(encrypted);
  } catch {
    throw new Error("decrypt failed (wrong machine identity or secret)");
  }
  const cred = JSON.parse(json) as Credential;
  if (cred.provider !== "zai" && cred.provider !== "bigmodel") {
    throw new Error("decrypted credential.provider must be zai or bigmodel");
  }
  if (!cred.apiKey && !cred.jwt) throw new Error("decrypted credential needs apiKey or jwt");
  return cred;
}

/** Portable JSON, or this-machine encrypted credentials.json. */
export async function credentialFromUnknown(input: unknown): Promise<Credential> {
  if (isMachineLockedBlob(input)) return decryptEncryptedFile(input);
  return unwrapPortableCredential(input);
}

export async function loadCredentialFromDir(dir: string): Promise<Credential | null> {
  const file = join(dir, "credentials.json");
  if (!existsSync(file)) return null;
  try {
    return await decryptEncryptedFile(JSON.parse(readFileSync(file, "utf-8")));
  } catch (e) {
    console.warn(`Ignoring corrupted or stale credentials at ${file}: ${(e as Error).message}`);
    return null;
  }
}

export async function loadCredential(): Promise<Credential | null> {
  return loadCredentialFromDir(getStoreDir());
}

export function clearCredential(): void {
  const file = getStoreFile();
  if (existsSync(file)) {
    unlinkSync(file);
  }
}

export function getStorePath(): string {
  return getStoreFile();
}
