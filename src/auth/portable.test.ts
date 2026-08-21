import { describe, it, expect } from "bun:test";
import { unwrapPortableCredential, toPortableCredential, PORTABLE_KIND } from "./portable.js";

describe("unwrapPortableCredential", () => {
  it("accepts the zcode-cred-tool bundle", () => {
    const cred = unwrapPortableCredential({
      kind: PORTABLE_KIND,
      version: 1,
      exportedAt: "2026-08-22T00:00:00.000Z",
      credential: {
        provider: "zai",
        apiKey: "coding-key",
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoi7".padEnd(20, "x"),
        userId: "42",
      },
    });
    expect(cred.provider).toBe("zai");
    expect(cred.apiKey).toBe("coding-key");
    expect(cred.jwt?.startsWith("eyJ")).toBe(true);
    expect(cred.userId).toBe("42");
  });

  it("accepts { bundle } wrappers and raw credentials", () => {
    const raw = { provider: "bigmodel" as const, apiKey: "bm", jwt: "jwt-token" };
    expect(unwrapPortableCredential(raw).apiKey).toBe("bm");
    expect(unwrapPortableCredential({ bundle: toPortableCredential(raw) }).jwt).toBe("jwt-token");
    expect(unwrapPortableCredential({ credential: raw }).provider).toBe("bigmodel");
  });

  it("rejects machine-locked credentials.json", () => {
    expect(() => unwrapPortableCredential({ encrypted: "abc" })).toThrow(/machine-locked/);
  });

  it("rejects missing provider or keys", () => {
    expect(() => unwrapPortableCredential({ provider: "zai" })).toThrow(/apiKey or jwt/);
    expect(() => unwrapPortableCredential({ apiKey: "x" })).toThrow(/provider/);
  });
});
