import { describe, it, expect } from "bun:test";
import { createServer } from "node:net";
import { canListen, isAddrInUse, nextListenPort } from "./listen.js";

describe("listen helpers", () => {
  it("detects EADDRINUSE-style errors", () => {
    expect(isAddrInUse({ code: "EADDRINUSE", message: "listen" })).toBe(true);
    expect(isAddrInUse({ code: "EACCES", message: "Failed to listen at 0.0.0.0" })).toBe(true);
    expect(isAddrInUse(new Error("nope"))).toBe(false);
  });

  it("finds a free port and skips one that is bound", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = blocker.address();
    const bound = typeof addr === "object" && addr ? addr.port : 0;
    expect(bound).toBeGreaterThan(0);
    expect(await canListen(bound, "127.0.0.1")).toBe(false);
    const next = await nextListenPort(bound, "127.0.0.1", 8);
    expect(next).toBeGreaterThan(bound);
    expect(await canListen(next, "127.0.0.1")).toBe(true);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });
});
