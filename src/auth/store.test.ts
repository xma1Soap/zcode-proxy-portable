/**
 * Tests for encrypted credential store.
 * @see .omo/plans/zcode-proxy.md Task 14
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { saveCredential, saveCredentialToDir, loadCredential, clearCredential, getStorePath } from "./store.js";
import type { Credential } from "./types.js";

const TEST_SECRET = "test-encryption-secret-for-zcode-proxy";

describe("credential store", () => {
  beforeEach(() => {
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = TEST_SECRET;
    clearCredential();
  });

  afterEach(() => {
    clearCredential();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("returns null when no credential stored", async () => {
    const loaded = await loadCredential();
    expect(loaded).toBeNull();
  });

  it("roundtrips: save → load → matches original", async () => {
    const cred: Credential = {
      apiKey: "testApiKey123",
      secret: "testSecret456",
      provider: "zai",
    };
    await saveCredential(cred);
    const loaded = await loadCredential();
    expect(loaded).not.toBeNull();
    expect(loaded!.apiKey).toBe("testApiKey123");
    expect(loaded!.secret).toBe("testSecret456");
    expect(loaded!.provider).toBe("zai");
  });

  it("roundtrips bigmodel credential (no secret)", async () => {
    const cred: Credential = {
      apiKey: "bmKey789",
      provider: "bigmodel",
    };
    await saveCredential(cred);
    const loaded = await loadCredential();
    expect(loaded).not.toBeNull();
    expect(loaded!.apiKey).toBe("bmKey789");
    expect(loaded!.secret).toBeUndefined();
    expect(loaded!.provider).toBe("bigmodel");
  });

  it("clearCredential removes stored credential", async () => {
    const cred: Credential = { apiKey: "x", provider: "zai" };
    await saveCredential(cred);
    clearCredential();
    const loaded = await loadCredential();
    expect(loaded).toBeNull();
  });

  it("saveCredentialToDir writes credentials.json under that folder", async () => {
    const dir = `${process.env.TEMP ?? "."}/zcode-proxy-dir-test-${Date.now()}`;
    process.env.ZCODE_PROXY_STORE_DIR = dir;
    try {
      const file = await saveCredentialToDir(dir, { apiKey: "dir-key", provider: "zai" });
      expect(file.replaceAll("\\", "/")).toContain("zcode-proxy-dir-test-");
      const loaded = await loadCredential();
      expect(loaded?.apiKey).toBe("dir-key");
    } finally {
      clearCredential();
      delete process.env.ZCODE_PROXY_STORE_DIR;
    }
  });

  it("ZCODE_PROXY_STORE_DIR isolates the credential file", async () => {
    const isolated = `${process.env.TEMP ?? "."}/zcode-proxy-store-test-${Date.now()}`;
    process.env.ZCODE_PROXY_STORE_DIR = isolated;
    try {
      await saveCredential({ apiKey: "isolated-key", provider: "bigmodel" });
      const loaded = await loadCredential();
      expect(loaded?.apiKey).toBe("isolated-key");
      expect(getStorePath().replaceAll("\\", "/")).toContain("zcode-proxy-store-test-");
    } finally {
      clearCredential();
      delete process.env.ZCODE_PROXY_STORE_DIR;
    }
  });

  it("preserves expiresAt field", async () => {
    const cred: Credential = {
      apiKey: "x",
      provider: "zai",
      expiresAt: 9999999999999,
    };
    await saveCredential(cred);
    const loaded = await loadCredential();
    expect(loaded!.expiresAt).toBe(9999999999999);
  });
});
