import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectZcodeProvider, importFromZCodeConfig, peekZcodeLogin } from "./zcode-import.js";

const root = join(tmpdir(), `zcode-import-test-${Date.now()}`);
const cfgDir = join(root, ".zcode", "v2");

describe("importFromZCodeConfig", () => {
  beforeEach(() => {
    mkdirSync(cfgDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("copies coding-plan apiKey and start-plan JWT", () => {
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({
      provider: {
        "builtin:bigmodel-coding-plan": { options: { apiKey: "id.secret" }, enabled: false },
        "builtin:bigmodel-start-plan": {
          enabled: true,
          options: { apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiNDIiLCJzdWIiOiI0MiJ9.sig" },
        },
      },
    }));
    const cred = importFromZCodeConfig("bigmodel", root);
    expect(cred.apiKey).toBe("id.secret");
    expect(cred.jwt?.startsWith("eyJ")).toBe(true);
    expect(cred.userId).toBe("42");
    expect(cred.provider).toBe("bigmodel");
  });

  it("detects the enabled start-plan provider", () => {
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({
      provider: {
        "builtin:bigmodel-coding-plan": { options: { apiKey: "" }, enabled: false },
        "builtin:bigmodel-start-plan": { options: { apiKey: "" }, enabled: false },
        "builtin:zai-coding-plan": { options: { apiKey: "zai-key-abcdefgh" }, enabled: false },
        "builtin:zai-start-plan": {
          enabled: true,
          options: { apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiNDIiLCJzdWIiOiI0MiJ9.sig" },
        },
      },
    }));
    expect(detectZcodeProvider(root)).toBe("zai");
    const cred = importFromZCodeConfig("zai", root);
    expect(cred.provider).toBe("zai");
    expect(cred.jwt?.startsWith("eyJ")).toBe(true);
  });

  it("peeks without exposing full keys", () => {
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({
      provider: {
        "builtin:bigmodel-coding-plan": { options: { apiKey: "abcdefghijklmnop" }, enabled: true },
        "builtin:bigmodel-start-plan": { options: { apiKey: "jwt-token-value-here" }, enabled: true },
      },
    }));
    const peek = peekZcodeLogin("bigmodel", root);
    expect(peek.exists).toBe(true);
    expect(peek.hasApiKey).toBe(true);
    expect(peek.hasJwt).toBe(true);
    expect(peek.apiKeyPreview).not.toBe("abcdefghijklmnop");
    expect(peek.jwtPreview).not.toBe("jwt-token-value-here");
  });
});
