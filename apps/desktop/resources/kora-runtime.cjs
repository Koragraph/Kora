#!/usr/bin/env node
// kora-runtime.cjs: kora-runtime.sh for Windows, where there is no /bin/sh. Shipped as resources\kora-runtime.cjs next
// to resources\runtime (daemon + CLI + hooks + koragraph + a pinned node.exe) and run by the desktop app under that
// bundled node on every launch (ShellKoraRuntime.ts). Same contract as the sh script; read that one for the why:
//
//   kora-runtime.cjs ensure   sync %USERPROFILE%\.kora\app when this build's runtime differs from it (stopping and
//                             restarting a running daemon), write the CLI shim, start the daemon when it is down, wait
//                             for the chat UI port.
//   kora-runtime.cjs sync     only the sync half; restarts the daemon only if it was running.
//
// Not ported yet (macOS-only in the sh script): the signed-manifest integrity check of the copy (Windows builds are
// not code-signed yet) and the quarantine-flag strip. It never kills a process by pattern: the daemon is stopped through
// its socket (`kora server stop`), an unresponsive one only by the exact pid in daemon.pid.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");

const RES = __dirname;
const SRC = path.join(RES, "runtime");
const NODE_NAME = process.platform === "win32" ? "node.exe" : "node";
const env = { ...process.env };
const HOME = os.homedir();

// ── flavor (Kora Dev / Kora QA): its own home, port and CLI name ────────────────────────────────────────────────
let flavor = null;
const flavorFile = path.join(RES, "flavor.env");
if (fs.existsSync(flavorFile)) {
  flavor = {};
  for (const line of fs.readFileSync(flavorFile, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    flavor[m[1]] = v.replace(/\$HOME/g, HOME);
  }
  for (const k of ["KORA_ENV", "KORA_PANE_ID", "KORA_BIN"]) delete env[k];
  env.KORA_HOME = path.join(HOME, flavor.KORA_HOME_NAME);
  env.KORA_SOCKET_PATH = path.join(env.KORA_HOME, "kora.sock");
  env.KORA_UI_PORT = flavor.KORA_PORT;
  env.KORAGRAPH_HOME = path.join(env.KORA_HOME, "koragraph");
  env.KORAGRAPH_DB = path.join(env.KORAGRAPH_HOME, "graph.db");
  env.KORAGRAPH_PRACTICE_DB = path.join(env.KORAGRAPH_HOME, "practice.db");
  if (flavor.KORA_BLOBS_ROOT) env.KORA_BLOBS_ROOT = flavor.KORA_BLOBS_ROOT;
  fs.mkdirSync(env.KORAGRAPH_HOME, { recursive: true });
}
const KHOME = env.KORA_HOME || path.join(HOME, ".kora");
const DST = path.join(KHOME, "app");
const PORT = env.KORA_UI_PORT || "8797";
const BIN_DIR = env.KORA_BIN_DIR || path.join(HOME, ".local", "bin");
const CLI_NAME = (flavor && flavor.KORA_CLI_NAME) || env.KORA_CLI_NAME || "kora";
const MODE = process.argv[2] || "ensure";

const say = (m) =>
  process.stdout.write(`[kora-runtime ${new Date().toTimeString().slice(0, 8)}] ${m}\n`);
const die = (m) => {
  say(m);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A daemon started from Electron must not inherit its markers.
const cleanEnv = { ...env, KORA_UI_PORT: PORT };
for (const k of [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "NODE_OPTIONS",
])
  delete cleanEnv[k];

function koraWith(root, args, timeout = 60_000) {
  return spawnSync(
    path.join(root, "bin", NODE_NAME),
    [path.join(root, "bin", "kora.js"), ...args],
    {
      env: cleanEnv,
      encoding: "utf8",
      timeout,
      windowsHide: true,
      cwd: HOME,
    },
  );
}
const running = () =>
  fs.existsSync(path.join(DST, "bin", NODE_NAME)) &&
  koraWith(DST, ["server", "status"], 15_000).status === 0;

function uiUp(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: Number(PORT), path: "/.well-known/kora/host", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode < 400);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function stopDaemon() {
  koraWith(SRC, ["server", "stop"], 15_000);
  for (let i = 0; i < 40 && (await uiUp(1000)); i++) await sleep(250);
}

const buildId = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, "BUILD_ID"), "utf8").trim();
  } catch {
    return "none";
  }
};

function recoverSwap() {
  if (!fs.existsSync(DST) && fs.existsSync(DST + ".old")) {
    say("restoring the runtime from an interrupted update");
    fs.renameSync(DST + ".old", DST);
  }
}

// ── one ensure/sync at a time per home ─────────────────────────────────────────────────────────────────────────
const LOCK = path.join(KHOME, "runtime.lock");
async function acquireLock() {
  for (let n = 0; ; n++) {
    try {
      fs.mkdirSync(LOCK);
      break;
    } catch {
      /* held */
    }
    let holder = "";
    try {
      holder = fs.readFileSync(path.join(LOCK, "pid"), "utf8").trim();
    } catch {
      /* none yet */
    }
    if (holder) {
      let alive = true;
      try {
        process.kill(Number(holder), 0);
      } catch (e) {
        alive = e.code === "EPERM";
      }
      if (!alive) {
        say(`breaking a stale lock (pid ${holder} is gone)`);
        fs.rmSync(LOCK, { recursive: true, force: true });
        continue;
      }
    } else {
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > 60_000) {
          fs.rmSync(LOCK, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
    }
    if (n > Number(env.KORA_LOCK_WAIT_HALFSEC || 360))
      die(`another kora-runtime run (pid ${holder || "?"}) holds ${LOCK}`);
    await sleep(500);
  }
  fs.writeFileSync(path.join(LOCK, "pid"), `${process.pid}\n`);
  const release = () => {
    try {
      fs.rmSync(LOCK, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  };
  process.on("exit", release);
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(s, () => {
      release();
      process.exit(1);
    });
}

// ── a daemon that is up but not answering: stop the exact pid in daemon.pid, never a pattern ──────────────────
async function recoverUnresponsive() {
  const pidFile = path.join(KHOME, "daemon.pid");
  let pid = 0,
    age = 0;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    age = (Date.now() - fs.statSync(pidFile).mtimeMs) / 1000;
  } catch {
    return;
  }
  if (!pid) return;
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  for (let i = 0; i < Number(env.KORA_HEALTH_TRIES || 3); i++) {
    if (await uiUp(Number(env.KORA_HEALTH_TIMEOUT || 5) * 1000)) return;
    await sleep(1000);
  }
  if (age < Number(env.KORA_UNRESPONSIVE_MIN_AGE_SEC || 120)) {
    say(
      `the daemon (pid ${pid}, ${Math.round(age)}s old) is not answering yet; it is still starting`,
    );
    return;
  }
  say(`the kora daemon (pid ${pid}) is up but not answering on :${PORT}; restarting it`);
  // Windows has no SIGTERM: process.kill() ends that one process and leaves its panes and engine CLIs running.
  // End the exact pid's tree instead (never a name pattern).
  try {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10000,
    });
  } catch {
    /* gone */
  }
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    await sleep(250);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* gone */
  }
  try {
    fs.rmSync(pidFile, { force: true });
  } catch {
    /* fine */
  }
}

// ── sync: 1 = current (nothing done), 0 = replaced and the daemon was running, 2 = replaced ─────────────────────
async function syncRuntime() {
  const want = buildId(SRC),
    have = buildId(DST);
  if (want === have && fs.existsSync(path.join(DST, "bin", NODE_NAME))) return 1;
  say(`runtime ${have} -> ${want}`);
  // Build the new copy completely and prove it works BEFORE touching the live one.
  const NEW = DST + ".new",
    OLD = DST + ".old";
  fs.rmSync(NEW, { recursive: true, force: true });
  try {
    fs.cpSync(SRC, NEW, { recursive: true, verbatimSymlinks: true });
  } catch (e) {
    fs.rmSync(NEW, { recursive: true, force: true });
    die(`copying the runtime failed (the existing runtime is untouched): ${e.message}`);
  }
  const probe = spawnSync(
    path.join(NEW, "bin", NODE_NAME),
    ["-e", "require('better-sqlite3'); require('node-pty')"],
    { cwd: NEW, encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
  if (probe.status !== 0) {
    fs.rmSync(NEW, { recursive: true, force: true });
    die(
      `the new runtime copy does not load its native modules; keeping the existing runtime\n${probe.stderr || ""}`,
    );
  }
  let wasRunning = false;
  if ((await uiUp(1000)) && koraWith(SRC, ["server", "status"], 15_000).status === 0) {
    wasRunning = true;
    say("stopping the running daemon (its code is being replaced)");
    await stopDaemon();
  }
  // Two renames, rolled back on failure. A file the stopped daemon still held can make the first rename fail for a
  // moment on Windows: retry briefly.
  fs.rmSync(OLD, { recursive: true, force: true });
  const renameRetry = async (a, b) => {
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(a, b);
        return;
      } catch (e) {
        if (i >= 20) throw e;
        await sleep(250);
      }
    }
  };
  if (fs.existsSync(DST)) {
    try {
      await renameRetry(DST, OLD);
    } catch {
      fs.rmSync(NEW, { recursive: true, force: true });
      die("cannot move the old runtime aside; keeping it");
    }
  }
  try {
    await renameRetry(NEW, DST);
  } catch {
    if (fs.existsSync(OLD)) fs.renameSync(OLD, DST);
    fs.rmSync(NEW, { recursive: true, force: true });
    die("cannot install the runtime; restored the previous one");
  }
  fs.rmSync(OLD, { recursive: true, force: true });
  fs.writeFileSync(
    path.join(KHOME, "install-source.json"),
    JSON.stringify({
      source: path.dirname(RES),
      build: want,
      node: path.join(DST, "bin", NODE_NAME),
      installedAt: new Date().toISOString(),
    }) + "\n",
  );
  linkCli();
  return wasRunning ? 0 : 2;
}

/** A value inside a batch file's double quotes: `%` doubled (it would expand a variable), nothing else is live. */
const bat = (s) => String(s ?? "").replace(/%/g, "%%");

// %USERPROFILE%\.local\bin\kora.cmd: absolute paths into the runtime copy. Only replaced when absent or kora-managed.
function linkCli() {
  const shim = path.join(BIN_DIR, CLI_NAME + ".cmd");
  try {
    if (fs.existsSync(shim) && !fs.readFileSync(shim, "utf8").includes("kora-managed-shim")) return;
  } catch {
    return;
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const lines = [
    "@echo off",
    `rem kora-managed-shim (written by ${(flavor && flavor.KORA_APP_NAME) || "Kora"}; points at the runtime copy the app maintains)`,
  ];
  if (flavor) {
    lines.push("set KORA_ENV=", "set KORA_PANE_ID=", "set KORA_BIN=");
    for (const k of [
      "KORA_HOME",
      "KORA_SOCKET_PATH",
      "KORA_UI_PORT",
      "KORAGRAPH_HOME",
      "KORAGRAPH_DB",
      "KORAGRAPH_PRACTICE_DB",
    ])
      lines.push(`set "${k}=${bat(env[k])}"`);
  }
  // Double-quoted, so a profile path with spaces (`C:\Users\First Last`) holds; `%` is the one character still live
  // inside quotes in a batch file.
  lines.push(
    `"${bat(path.join(DST, "bin", NODE_NAME))}" "${bat(path.join(DST, "bin", "kora.js"))}" %*`,
  );
  fs.writeFileSync(shim, lines.join("\r\n") + "\r\n");
}

async function startDaemon() {
  if (running()) return;
  say(`starting the kora daemon (${path.join(DST, "bin", NODE_NAME)})`);
  const r = koraWith(DST, ["server", "start"], 30_000);
  if (r.status !== 0)
    say(
      `kora server start did not confirm (${(r.stderr || r.stdout || "").trim().slice(0, 300)}); waiting for the UI port`,
    );
}

async function waitUi() {
  for (let i = 0; i < 60; i++) {
    if (await uiUp()) {
      say(`ready: chat UI http://127.0.0.1:${PORT}`);
      return;
    }
    await sleep(500);
  }
  die(`chat UI did not come up on :${PORT} within 30s (see ${path.join(KHOME, "server.log")})`);
}

(async () => {
  if (
    !fs.existsSync(path.join(SRC, "bin", NODE_NAME)) ||
    !fs.existsSync(path.join(SRC, "bin", "kora.js"))
  )
    die(`no bundled runtime at ${SRC}`);
  fs.mkdirSync(KHOME, { recursive: true });
  if (MODE !== "sync" && MODE !== "ensure") die("usage: kora-runtime.cjs ensure|sync");
  await acquireLock();
  recoverSwap();
  await recoverUnresponsive();
  const r = await syncRuntime();
  linkCli();
  if (MODE === "sync") {
    if (r === 0) {
      await startDaemon();
      await waitUi();
    }
    if (r === 1) say(`runtime already current (${buildId(DST)})`);
    process.exit(0);
  }
  await startDaemon();
  await waitUi();
  process.exit(0);
})().catch((e) => die(String((e && e.stack) || e)));
