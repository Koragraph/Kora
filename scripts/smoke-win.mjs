#!/usr/bin/env node
// Windows end-to-end smoke (CI, after scripts/package-win.mjs): silently install the NSIS build for this user, launch
// Kora.exe the way a user would, and wait until the window's client is connected to the daemon it started:
//   1. the installer puts Kora.exe + resources under %LOCALAPPDATA%\Programs\Kora
//   2. on launch the app runs resources\kora-runtime.cjs ensure (copies the runtime to %USERPROFILE%\.kora\app, writes
//      %USERPROFILE%\.local\bin\kora.cmd, starts the daemon)
//   3. the daemon answers http://127.0.0.1:8797/.well-known/kora/host and server.log shows `ws client connected`
// Then `kora.cmd server status` must work from a plain shell, and the CLI is driven against the live daemon (doctor, a
// shell pane read back from its screen, ingest + search_code on a 3-file repo; PASS/FAIL per step, no model calls).
// Everything is stopped again. Windows only.
//   node scripts/smoke-win.mjs [--installer <path>] [--timeout <s>]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const say = (s) => console.log(`[smoke] ${s}`);
const die = (s) => {
  console.error(`[smoke] FAIL: ${s}`);
  dumpLogs();
  stopAll();
  process.exit(1);
};
if (process.platform !== "win32") {
  console.error("smoke-win.mjs runs on Windows only");
  process.exit(2);
}

const HOME = os.homedir();
const KORA_HOME = path.join(HOME, ".kora");
const LOG = path.join(KORA_HOME, "server.log");
const INSTALL_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"),
  "Programs",
  "Kora",
);
const EXE = path.join(INSTALL_DIR, "Kora.exe");
const SHIM = path.join(HOME, ".local", "bin", "kora.cmd");
const TIMEOUT_S = Number(opt("--timeout") ?? 120);
let app = null;

function logFiles(dir, depth = 2) {
  let out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isFile() && d.name.endsWith(".log")) out.push(p);
    else if (d.isDirectory() && depth > 0 && d.name !== "app")
      out = out.concat(logFiles(p, depth - 1));
  }
  return out;
}

function dumpLogs() {
  // server.log first, then whatever else the daemon and the shell wrote (the desktop's own logs live under KORA_HOME too)
  for (const f of [LOG, ...logFiles(KORA_HOME).filter((f) => f !== LOG)]) {
    try {
      const t = fs.readFileSync(f, "utf8");
      console.error(`----- ${f} (last 60 lines)\n${t.split(/\r?\n/).slice(-60).join("\n")}`);
    } catch {
      console.error(`----- ${f}: absent`);
    }
  }
}

function stopAll() {
  if (app?.pid) spawnSync("taskkill", ["/T", "/F", "/PID", String(app.pid)], { stdio: "ignore" });
  if (fs.existsSync(SHIM))
    spawnSync("cmd.exe", ["/d", "/c", SHIM, "server", "stop"], {
      stdio: "inherit",
      timeout: 30_000,
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, seconds = TIMEOUT_S) {
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    try {
      if (await fn()) return;
    } catch {
      /* not yet */
    }
    await sleep(1000);
  }
  die(`timed out after ${seconds} s waiting for ${what}`);
}

// 1. install
const installer =
  opt("--installer") ??
  (() => {
    const dir = path.join(ROOT, "dist", "win");
    const exe = fs.existsSync(dir)
      ? fs.readdirSync(dir).find((f) => /^Kora-Setup-.*\.exe$/.test(f))
      : null;
    return exe
      ? path.join(dir, exe)
      : die(`no Kora-Setup-*.exe in ${dir}; run scripts/package-win.mjs first`);
  })();
say(`installing ${installer} (silent, per-user)`);
const inst = spawnSync(installer, ["/S"], { stdio: "inherit", timeout: 300_000 });
if (inst.status !== 0) die(`installer exited ${inst.status} ${inst.error ?? ""}`);
await until(`Kora.exe at ${EXE}`, () => fs.existsSync(EXE), 60);
for (const rel of [
  "resources\\kora-runtime.cjs",
  "resources\\runtime\\bin\\node.exe",
  "resources\\web\\index.html",
  "resources\\app\\dist-electron\\main.cjs",
])
  if (!fs.existsSync(path.join(INSTALL_DIR, rel))) die(`missing ${rel} in the installed app`);
say(`installed at ${INSTALL_DIR}`);

// 2. launch like a user (no console attached, detached from this shell)
const logStart = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
app = spawn(EXE, [], {
  detached: true,
  stdio: "ignore",
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
});
app.unref();
say(
  `launched Kora.exe (pid ${app.pid}); waiting up to ${TIMEOUT_S} s for the daemon and the window`,
);

// 3. daemon up, then the window's client connected
await until(
  "the daemon on 127.0.0.1:8797",
  async () => (await fetch("http://127.0.0.1:8797/.well-known/kora/host")).ok,
);
say("daemon answers on :8797");
await until("`ws client connected` in server.log", () => {
  const fd = fs.openSync(LOG, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.max(0, size - logStart));
    fs.readSync(fd, buf, 0, buf.length, logStart);
    return /ws client connected/.test(buf.toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
});
say("the window's client is connected");

// 4. the CLI shim works from a plain shell
if (!fs.existsSync(SHIM)) die(`no CLI shim at ${SHIM}`);
const st = spawnSync("cmd.exe", ["/d", "/c", SHIM, "server", "status"], {
  encoding: "utf8",
  timeout: 30_000,
});
process.stdout.write(st.stdout ?? "");
if (st.status !== 0) die(`kora.cmd server status exited ${st.status}: ${st.stderr}`);
say("kora.cmd server status: ok");

// 5. the CLI against the live daemon, every step through the installed kora.cmd with its own timeout. No model calls:
// doctor runs --quick (no provider probes), the pane is a plain shell, the graph is a 3-file repo in %TEMP%.
// Each step prints PASS / FAIL (WARN for doctor, which never fails the run); any FAIL fails the smoke after the rest ran.
// Run from inside a Kora pane (KORA_AGENT set), the daemon refuses the steps below by design: an agent may not spawn a
// shell, type into a pane it does not lead, start a first index or stop the server (server/control-auth.ts,
// graph/index-consent.ts). Say so up front rather than reporting four confusing FAILs. CI runs it from a plain shell.
if (process.env.KORA_AGENT)
  die(
    "KORA_AGENT is set: this shell is a Kora agent pane, and the daemon refuses agents the CLI steps below (pane spawn, first index). Run the smoke from a plain terminal.",
  );
const results = [];
const kora = (argv, timeoutS = 60, cwd = undefined) => {
  const r = spawnSync("cmd.exe", ["/d", "/c", SHIM, ...argv], {
    encoding: "utf8",
    timeout: timeoutS * 1000,
    cwd,
    windowsHide: true,
  });
  const timedOut = r.error?.code === "ETIMEDOUT";
  return { code: timedOut ? null : r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, timedOut };
};
const tail = (t, n = 12) =>
  t
    .trim()
    .split(/\r?\n/)
    .slice(-n)
    .map((l) => `    ${l}`)
    .join("\n");
function report(name, ok, detail = "", soft = false) {
  const tag = ok ? "PASS" : soft ? "WARN" : "FAIL";
  results.push({ name, ok: ok || soft });
  say(`${tag} ${name}${detail ? `\n${detail}` : ""}`);
}
async function poll(timeoutS, fn) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutS * 1000) return null;
    await sleep(1000);
  }
}

// 5a. doctor: informational (a CI runner has no Claude login, no OpenCode), so never a hard failure
{
  const r = kora(["doctor", "--quick"], 120);
  report(
    `kora doctor --quick (exit ${r.timedOut ? "timeout" : r.code})`,
    r.code === 0,
    tail(r.out, 25),
    !r.timedOut,
  );
}

// 5b. a plain terminal pane: spawn a shell, type a marker, read it back from the screen, kill it
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-smoke-pane-"));
  const sp = kora(
    ["agent", "spawn", "shell", "--cwd", dir, "--no-worktree", "--name", "smoke"],
    60,
  );
  const id = /\b(p\d+)\b/.exec(sp.out)?.[1];
  if (sp.code !== 0 || !id) report("spawn a shell pane", false, tail(sp.out));
  else {
    report(`spawn a shell pane (${id})`, true);
    const prompt = await poll(30, () =>
      /\S/.test(kora(["agent", "read", id, "--lines", "20"], 20).out),
    );
    report("the pane's screen shows the shell", Boolean(prompt));
    kora(["agent", "prompt", id, "echo KORA_SMOKE_42", "--no-wait"], 30);
    const seen = await poll(30, () => {
      const r = kora(["agent", "read", id, "--lines", "40"], 20);
      return /KORA_SMOKE_42/.test(r.out.replace(/echo KORA_SMOKE_42/g, "")) ? r.out : null;
    });
    report(
      "a typed command's output is read back from the screen",
      Boolean(seen),
      seen ? "" : tail(kora(["agent", "read", id, "--lines", "40"], 20).out),
    );
    const k = kora(["agent", "kill", id], 30);
    report("kill the pane", k.code === 0, k.code === 0 ? "" : tail(k.out));
  }
}

// 5c. the graph: index a 3-file git repo in %TEMP%, then find a known symbol with search_code
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kora-smoke-repo-"));
  fs.writeFileSync(
    path.join(repo, "alpha.js"),
    "function koraSmokeAlpha(n) {\n  return n + 1;\n}\nmodule.exports = { koraSmokeAlpha };\n",
  );
  fs.writeFileSync(
    path.join(repo, "beta.js"),
    "const { koraSmokeAlpha } = require('./alpha');\nfunction koraSmokeBeta() {\n  return koraSmokeAlpha(41);\n}\nmodule.exports = { koraSmokeBeta };\n",
  );
  fs.writeFileSync(path.join(repo, "README.md"), "# smoke\n");
  const git = (...a) =>
    spawnSync("git", ["-c", "user.email=smoke@kora", "-c", "user.name=smoke", ...a], {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
    });
  const g = [git("init", "-q", "-b", "main"), git("add", "-A"), git("commit", "-qm", "smoke")];
  const gitFail = g.find((r) => r.status !== 0);
  if (gitFail) report("make a 3-file git repo", false, tail(`${gitFail.stdout}${gitFail.stderr}`));
  else {
    const ing = kora(["ingest", repo], 240, repo);
    report(
      `kora ingest a 3-file repo (exit ${ing.timedOut ? "timeout" : ing.code})`,
      ing.code === 0,
      tail(ing.out, 8),
    );
    if (ing.code === 0) {
      const sc = kora(["graph", "search_code", "koraSmokeAlpha"], 60, repo);
      report(
        "search_code finds koraSmokeAlpha in alpha.js",
        sc.code === 0 && /koraSmokeAlpha/.test(sc.out) && /alpha\.js/.test(sc.out),
        tail(sc.out, 8),
      );
    }
  }
}

stopAll();
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`[smoke] FAIL: ${failed.map((r) => r.name).join("; ")}`);
  dumpLogs();
  process.exit(1);
}
say("PASS");
process.exit(0);
