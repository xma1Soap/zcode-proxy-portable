/**
 * Find a real browser to drive captcha (Chromium CDP) or to open an OAuth URL.
 * Linux often has no Edge — probe PATH, desktop files, xdg, snap, and flatpak.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface BrowserLaunch {
  cmd: string;
  prefixArgs: string[];
  label: string;
}

const CHROMIUM_HINT = /chromium|chrome|brave|vivaldi|opera|msedge|microsoft-edge|thorium|iridium|ungoogled|yandex/i;
const NOT_CHROMIUM = /firefox|librewolf|waterfox|zen-browser|epiphany|gnome-www|midori|falkon|konqueror|qutebrowser|lynx|w3m|links/i;

const LINUX_BIN_NAMES = [
  "chromium",
  "chromium-browser",
  "google-chrome-stable",
  "google-chrome",
  "brave-browser",
  "brave",
  "vivaldi-stable",
  "vivaldi",
  "opera",
  "microsoft-edge-stable",
  "microsoft-edge",
  "thorium-browser",
  "iridium-browser",
  "yandex-browser",
  "ungoogled-chromium",
];

const LINUX_FIXED_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/lib/chromium/chromium",
  "/usr/lib64/chromium/chromium",
  "/snap/bin/chromium",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/opt/google/chrome/google-chrome",
  "/usr/bin/brave-browser",
  "/opt/brave.com/brave/brave-browser",
  "/usr/bin/vivaldi-stable",
  "/opt/vivaldi/vivaldi",
  "/usr/bin/opera",
  "/usr/bin/microsoft-edge-stable",
  "/usr/bin/microsoft-edge",
  "/opt/microsoft/msedge/msedge",
  "/usr/bin/thorium-browser",
];

const FLATPAK_CHROMIUM_APPS = [
  "org.chromium.Chromium",
  "com.google.Chrome",
  "com.brave.Browser",
  "com.vivaldi.Vivaldi",
  "com.opera.Opera",
  "com.microsoft.Edge",
  "io.github.ungoogled_software.ungoogled_chromium",
];

const SNAP_CHROMIUM_APPS = ["chromium", "brave", "opera"];

export function isChromiumFamily(text: string): boolean {
  if (!text) return false;
  if (NOT_CHROMIUM.test(text) && !CHROMIUM_HINT.test(text)) return false;
  return CHROMIUM_HINT.test(text);
}

export function whichOnPath(cmd: string): string | undefined {
  if (!cmd) return undefined;
  if (cmd.includes("/") || cmd.includes("\\")) {
    return existsSync(cmd) ? cmd : undefined;
  }
  const dirs = (process.env.PATH ?? "").split(delimiter);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function parseDesktopExec(execLine: string): { cmd: string; prefixArgs: string[] } | null {
  const cleaned = execLine
    .replace(/@@\S*/g, " ")
    .replace(/%[fFuUdDnNickvm]/g, " ")
    .trim();
  const parts = splitArgs(cleaned).filter((p) => p && !p.startsWith("%"));
  if (parts.length === 0) return null;
  return { cmd: parts[0]!, prefixArgs: parts.slice(1) };
}

function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function pushLaunch(out: BrowserLaunch[], seen: Set<string>, launch: BrowserLaunch): void {
  const key = `${launch.cmd}\0${launch.prefixArgs.join("\0")}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(launch);
}

function fileLaunch(path: string, label?: string): BrowserLaunch | null {
  if (!path || !existsSync(path)) return null;
  return { cmd: path, prefixArgs: [], label: label ?? path };
}

function runQuiet(cmd: string, args: string[], timeoutMs = 1500): string {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function desktopDirs(): string[] {
  return [
    join(homedir(), ".local/share/applications"),
    "/usr/share/applications",
    "/usr/local/share/applications",
    "/var/lib/snapd/desktop/applications",
    "/var/lib/flatpak/exports/share/applications",
    join(homedir(), ".local/share/flatpak/exports/share/applications"),
  ];
}

function launchesFromDesktopFile(file: string): BrowserLaunch[] {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  if (!isChromiumFamily(file) && !isChromiumFamily(text.slice(0, 2000))) return [];
  const execLine = text.split(/\r?\n/).find((l) => l.startsWith("Exec="));
  if (!execLine) return [];
  const parsed = parseDesktopExec(execLine.slice(5));
  if (!parsed) return [];
  const resolved = whichOnPath(parsed.cmd) ?? parsed.cmd;
  if (parsed.cmd !== "flatpak" && parsed.cmd !== "snap" && !existsSync(resolved) && !whichOnPath(parsed.cmd)) {
    return [];
  }
  return [{
    cmd: existsSync(resolved) ? resolved : parsed.cmd,
    prefixArgs: parsed.prefixArgs,
    label: file,
  }];
}

function launchesFromXdgDefault(): BrowserLaunch[] {
  const desktop =
    runQuiet("xdg-settings", ["get", "default-web-browser"]) ||
    runQuiet("xdg-mime", ["query", "default", "x-scheme-handler/https"]);
  if (!desktop || !desktop.endsWith(".desktop")) return [];
  if (!isChromiumFamily(desktop)) return [];
  for (const dir of desktopDirs()) {
    const file = join(dir, desktop);
    if (existsSync(file)) return launchesFromDesktopFile(file);
  }
  return [];
}

function launchesFromAlternatives(): BrowserLaunch[] {
  const out: BrowserLaunch[] = [];
  for (const link of ["/etc/alternatives/x-www-browser", "/etc/alternatives/gnome-www-browser", "/usr/bin/x-www-browser"]) {
    try {
      const target = existsSync(link) ? readlinkSync(link, { encoding: "utf8" }) : "";
      const abs = target.startsWith("/") ? target : (target ? join("/usr/bin", target) : "");
      const resolved = abs && existsSync(abs) ? abs : whichOnPath(link);
      if (resolved && isChromiumFamily(resolved) && existsSync(resolved)) {
        out.push({ cmd: resolved, prefixArgs: [], label: `alt:${link}` });
      }
    } catch { /* skip */ }
  }
  return out;
}

function launchesFromFlatpak(): BrowserLaunch[] {
  if (!whichOnPath("flatpak")) return [];
  const listed = runQuiet("flatpak", ["list", "--app", "--columns=application"], 2500);
  const found = new Set(
    listed
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const out: BrowserLaunch[] = [];
  for (const app of FLATPAK_CHROMIUM_APPS) {
    if (found.size > 0 && !found.has(app)) continue;
    if (found.size === 0) {
      // list failed — still try the common ids; flatpak run will fail fast if missing
    }
    out.push({ cmd: "flatpak", prefixArgs: ["run", app], label: `flatpak:${app}` });
  }
  return out;
}

function launchesFromSnap(): BrowserLaunch[] {
  const snapBin = whichOnPath("snap");
  const out: BrowserLaunch[] = [];
  for (const app of SNAP_CHROMIUM_APPS) {
    const direct = `/snap/bin/${app}`;
    if (existsSync(direct)) {
      out.push({ cmd: direct, prefixArgs: [], label: `snap:${app}` });
      continue;
    }
    if (snapBin) out.push({ cmd: snapBin, prefixArgs: ["run", app], label: `snap-run:${app}` });
  }
  return out;
}

function envOverrideLaunch(): BrowserLaunch | null {
  const raw = process.env.ZCODE_EDGE_PATH?.trim();
  if (!raw) return null;
  if (existsSync(raw)) return { cmd: raw, prefixArgs: [], label: "ZCODE_EDGE_PATH" };
  const parsed = parseDesktopExec(raw);
  if (!parsed) return null;
  const resolved = whichOnPath(parsed.cmd) ?? parsed.cmd;
  return { cmd: resolved, prefixArgs: parsed.prefixArgs, label: "ZCODE_EDGE_PATH" };
}

/** Chromium-family launches that can speak CDP (captcha). */
export function listCaptchaBrowserLaunches(): BrowserLaunch[] {
  const out: BrowserLaunch[] = [];
  const seen = new Set<string>();

  const override = envOverrideLaunch();
  if (override) pushLaunch(out, seen, override);

  if (process.platform === "win32") {
    for (const p of [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ]) {
      const launch = fileLaunch(p);
      if (launch) pushLaunch(out, seen, launch);
    }
  }

  if (process.platform === "darwin") {
    for (const p of [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ]) {
      const launch = fileLaunch(p);
      if (launch) pushLaunch(out, seen, launch);
    }
  }

  for (const p of LINUX_FIXED_PATHS) {
    const launch = fileLaunch(p);
    if (launch) pushLaunch(out, seen, launch);
  }

  for (const name of LINUX_BIN_NAMES) {
    const p = whichOnPath(name);
    if (p) pushLaunch(out, seen, { cmd: p, prefixArgs: [], label: name });
  }

  if (process.platform !== "win32") {
    for (const launch of launchesFromXdgDefault()) pushLaunch(out, seen, launch);
    for (const launch of launchesFromAlternatives()) pushLaunch(out, seen, launch);
    for (const dir of desktopDirs()) {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".desktop")) continue;
        for (const launch of launchesFromDesktopFile(join(dir, name))) {
          pushLaunch(out, seen, launch);
        }
      }
    }
    for (const launch of launchesFromFlatpak()) pushLaunch(out, seen, launch);
    for (const launch of launchesFromSnap()) pushLaunch(out, seen, launch);
  }

  return out;
}

/** Absolute paths still used by older callers / tests. */
export function browserSearchPaths(): string[] {
  const paths = listCaptchaBrowserLaunches()
    .filter((l) => l.prefixArgs.length === 0)
    .map((l) => l.cmd);
  return [...new Set([
    process.env.ZCODE_EDGE_PATH,
    ...paths,
    ...LINUX_FIXED_PATHS,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter((p): p is string => Boolean(p)))];
}

export function pickCaptchaBrowser(): BrowserLaunch {
  const launches = listCaptchaBrowserLaunches();
  const usable = launches.filter((l) => l.cmd === "flatpak" || l.cmd === "snap" || existsSync(l.cmd) || Boolean(whichOnPath(l.cmd)));
  if (usable[0]) return usable[0];
  throw new Error(
    "No Chromium-based browser found (Chrome / Chromium / Brave / Edge / Vivaldi / Opera). " +
    "Install one, or set ZCODE_EDGE_PATH to the binary (or `flatpak run org.chromium.Chromium`).",
  );
}

/** Open a URL in whatever the desktop considers a browser (Firefox is fine here). */
export function openSystemBrowser(url: string, spawnFn: typeof import("node:child_process").spawn): void {
  const attempts: Array<{ cmd: string; args: string[] }> = [];
  if (process.platform === "win32") {
    attempts.push({ cmd: "cmd.exe", args: ["/c", "start", "", url] });
  } else if (process.platform === "darwin") {
    attempts.push({ cmd: "open", args: [url] });
  } else {
    const envBrowser = process.env.BROWSER?.trim();
    if (envBrowser) {
      const parsed = parseDesktopExec(envBrowser);
      if (parsed) attempts.push({ cmd: parsed.cmd, args: [...parsed.prefixArgs, url] });
    }
    attempts.push({ cmd: "xdg-open", args: [url] });
    attempts.push({ cmd: "gio", args: ["open", url] });
    attempts.push({ cmd: "sensible-browser", args: [url] });
    attempts.push({ cmd: "x-www-browser", args: [url] });
    attempts.push({ cmd: "gnome-open", args: [url] });
    attempts.push({ cmd: "kde-open", args: [url] });
    for (const name of ["firefox", "chromium", "google-chrome", "brave-browser"]) {
      attempts.push({ cmd: name, args: [url] });
    }
  }

  for (const a of attempts) {
    const resolved = a.cmd.includes("/") || a.cmd.includes("\\") ? a.cmd : (whichOnPath(a.cmd) ?? a.cmd);
    if (a.cmd !== "cmd.exe" && a.cmd.includes("/") && !existsSync(resolved) && !whichOnPath(a.cmd)) continue;
    try {
      const child = spawnFn(resolved, a.args, {
        detached: true,
        stdio: "ignore",
        ...(process.platform === "win32" ? { windowsHide: true, windowsVerbatimArguments: true } : {}),
      });
      child.unref();
      return;
    } catch { /* try next */ }
  }
}
