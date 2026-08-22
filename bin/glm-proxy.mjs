#!/usr/bin/env node
/**
 * Remote launcher: downloads the prebuilt coexist runtime from the same
 * GitHub release, then forwards start/stop/list to start.sh / stop.sh.
 */
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir, tmpdir, arch, platform } from "node:os";
import { join } from "node:path";
import https from "node:https";

const HOME = process.env.GLM_PROXY_HOME || join(homedir(), ".glm-proxy-coexist");
const RELEASE = process.env.GLM_PROXY_RELEASE
  || "https://github.com/xma1Soap/zcode-proxy-portable/releases/download/v4";

function die(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

function usage() {
  process.stdout.write(`glm-proxy-coexist

  glm-proxy start [port] [--isolated]
  glm-proxy stop [port|--all]
  glm-proxy list
  glm-proxy serve [port]     same as start

install:
  npm install -g github:xma1Soap/zcode-proxy-portable#glm-proxy
`);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const go = (u, hops = 0) => {
      https.get(u, { headers: { "User-Agent": "glm-proxy-coexist" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 8) {
          res.resume();
          go(res.headers.location, hops + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GET ${url} -> ${res.statusCode}`));
          return;
        }
        const out = createWriteStream(dest);
        res.pipe(out);
        out.on("finish", () => out.close(resolve));
        out.on("error", reject);
      }).on("error", reject);
    };
    go(url);
  });
}

function assetName() {
  const p = platform();
  const a = arch();
  if (p === "linux" && (a === "x64" || a === "arm64")) {
    return `glm-proxy-coexist-linux-${a}.tar.gz`;
  }
  if (p === "win32") return "glm-proxy-coexist.exe";
  return null;
}

function runtimeDir() {
  return join(HOME, "runtime");
}

function linuxBinary() {
  return join(runtimeDir(), "zcode-proxy-login");
}

function winExtractor() {
  return join(HOME, "glm-proxy-coexist.exe");
}

async function extractLinux() {
  if (existsSync(linuxBinary())) return runtimeDir();
  const name = assetName();
  if (!name) die(`unsupported platform ${platform()}/${arch()}`);
  mkdirSync(HOME, { recursive: true });
  const tar = join(tmpdir(), name);
  process.stderr.write(`downloading ${RELEASE}/${name}\n`);
  await download(`${RELEASE}/${name}`, tar);
  const stage = join(HOME, "extract");
  mkdirSync(stage, { recursive: true });
  execFileSync("tar", ["-xzf", tar, "-C", stage], { stdio: "inherit" });
  const unpacked = existsSync(join(stage, "glm-proxy", "zcode-proxy-login"))
    ? join(stage, "glm-proxy")
    : existsSync(join(stage, "zcode-proxy-login"))
      ? stage
      : null;
  if (!unpacked) die("downloaded archive missing zcode-proxy-login");
  mkdirSync(runtimeDir(), { recursive: true });
  execFileSync("cp", ["-a", `${unpacked}/.`, runtimeDir()]);
  try { chmodSync(linuxBinary(), 0o755); } catch { /* ok */ }
  return runtimeDir();
}

function runBash(script, args, cwd) {
  const child = spawn("bash", [script, ...args], {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith("-") && !/^\d+$/.test(argv[0]) ? argv[0] : "start";
  const rest = cmd === argv[0] ? argv.slice(1) : argv;

  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    usage();
    return;
  }

  if (platform() === "win32") {
    mkdirSync(HOME, { recursive: true });
    if (!existsSync(winExtractor())) {
      process.stderr.write("downloading glm-proxy-coexist.exe\n");
      await download(`${RELEASE}/glm-proxy-coexist.exe`, winExtractor());
    }
    const child = spawn(winExtractor(), rest, { stdio: "inherit", detached: true, windowsHide: true });
    child.unref();
    return;
  }

  if (platform() !== "linux") {
    die("prebuilt runtime is Linux/Windows. On this OS clone the glm-proxy branch and use bun.");
  }

  const root = await extractLinux();
  const startSh = join(root, "start.sh");
  const stopSh = join(root, "stop.sh");

  if (cmd === "stop") {
    runBash(stopSh, rest.length ? rest : ["--all"], root);
    return;
  }
  if (cmd === "list" || cmd === "status") {
    runBash(startSh, ["--list"], root);
    return;
  }
  if (cmd === "start" || cmd === "serve") {
    runBash(startSh, rest, root);
    return;
  }
  die(`unknown command: ${cmd}\n`);
}

main().catch((err) => die(err.stack || String(err)));
