import { describe, it, expect } from "bun:test";
import { isChromiumFamily, parseDesktopExec, browserSearchPaths } from "./browser-launch.js";

describe("isChromiumFamily", () => {
  it("accepts common Linux browsers", () => {
    expect(isChromiumFamily("/usr/bin/chromium")).toBe(true);
    expect(isChromiumFamily("google-chrome-stable")).toBe(true);
    expect(isChromiumFamily("brave-browser")).toBe(true);
    expect(isChromiumFamily("org.chromium.Chromium")).toBe(true);
  });

  it("rejects Firefox and text browsers", () => {
    expect(isChromiumFamily("firefox")).toBe(false);
    expect(isChromiumFamily("org.mozilla.firefox")).toBe(false);
    expect(isChromiumFamily("epiphany")).toBe(false);
  });
});

describe("parseDesktopExec", () => {
  it("strips desktop field codes", () => {
    const p = parseDesktopExec("/usr/bin/chromium %U");
    expect(p).toEqual({ cmd: "/usr/bin/chromium", prefixArgs: [] });
  });

  it("keeps flatpak wrapper args", () => {
    const p = parseDesktopExec("/usr/bin/flatpak run --branch=stable org.chromium.Chromium @@u %U @@");
    expect(p?.cmd).toBe("/usr/bin/flatpak");
    expect(p?.prefixArgs).toEqual(["run", "--branch=stable", "org.chromium.Chromium"]);
  });
});

describe("browserSearchPaths", () => {
  it("still lists Windows Edge and Linux Chromium locations", () => {
    const paths = browserSearchPaths();
    expect(paths.some((p) => p.includes("msedge.exe"))).toBe(true);
    expect(paths.some((p) => p.includes("chromium") || p.includes("google-chrome"))).toBe(true);
  });
});
