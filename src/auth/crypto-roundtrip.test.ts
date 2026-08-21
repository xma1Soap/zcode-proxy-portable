import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  saveCredential,
  loadCredential,
  clearCredential,
  getStorePath,
  decryptEncryptedFile,
  credentialFromUnknown,
} from "./store.js";
import { toPortableCredential, unwrapPortableCredential } from "./portable.js";
import type { Credential } from "./types.js";

const SECRET_A = "roundtrip-secret-A";
const SECRET_B = "roundtrip-secret-B";

const sample: Credential = {
  provider: "zai",
  apiKey: "coding-key-abcdef",
  jwt: "eyJhbGciOiJIUzI1NiJ9.payload.sig",
  userId: "42",
};

describe("encrypt/decrypt fusion", () => {
  beforeEach(() => {
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = SECRET_A;
    process.env.ZCODE_PROXY_STORE_DIR = join(process.env.TEMP ?? ".", `cred-rt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    clearCredential();
  });
  afterEach(() => {
    clearCredential();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    delete process.env.ZCODE_PROXY_STORE_DIR;
  });

  it("save encrypts and load decrypts the same fields", async () => {
    await saveCredential(sample);
    const loaded = await loadCredential();
    expect(loaded?.apiKey).toBe(sample.apiKey);
    expect(loaded?.jwt).toBe(sample.jwt);
    expect(loaded?.userId).toBe("42");
    const disk = JSON.parse(readFileSync(getStorePath(), "utf-8")) as { encrypted?: string };
    expect(typeof disk.encrypted).toBe("string");
    expect(disk.encrypted).not.toContain("coding-key");
  });

  it("decryptEncryptedFile unlocks this-machine credentials.json", async () => {
    await saveCredential(sample);
    const blob = JSON.parse(readFileSync(getStorePath(), "utf-8"));
    const cred = await decryptEncryptedFile(blob);
    expect(cred.apiKey).toBe(sample.apiKey);
    expect(cred.jwt).toBe(sample.jwt);
  });

  it("wrong machine secret cannot decrypt", async () => {
    await saveCredential(sample);
    const blob = JSON.parse(readFileSync(getStorePath(), "utf-8"));
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = SECRET_B;
    await expect(decryptEncryptedFile(blob)).rejects.toThrow(/decrypt failed/);
  });

  it("portable JSON survives re-encrypting for another identity", async () => {
    await saveCredential(sample);
    const unlocked = await decryptEncryptedFile(JSON.parse(readFileSync(getStorePath(), "utf-8")));
    const portable = toPortableCredential(unlocked);
    expect(portable.kind).toBe("zcode-proxy-credential");
    const again = unwrapPortableCredential(portable);
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = SECRET_B;
    process.env.ZCODE_PROXY_STORE_DIR = join(process.env.TEMP ?? ".", `cred-rt-b-${Date.now()}`);
    await saveCredential(again);
    const loaded = await loadCredential();
    expect(loaded?.apiKey).toBe(sample.apiKey);
    expect(loaded?.jwt).toBe(sample.jwt);
  });

  it("credentialFromUnknown accepts portable and this-machine encrypted files", async () => {
    await saveCredential(sample);
    const locked = JSON.parse(readFileSync(getStorePath(), "utf-8"));
    const fromLocked = await credentialFromUnknown(locked);
    expect(fromLocked.apiKey).toBe(sample.apiKey);
    const fromPortable = await credentialFromUnknown(toPortableCredential(sample));
    expect(fromPortable.jwt).toBe(sample.jwt);
  });
});
