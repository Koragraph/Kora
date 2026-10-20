"use strict";
// Isolated QA stack N (1..4): its own KORA_HOME, socket, UI port, graph DB and web dev port. Never ~/.kora or :8797.
// Pattern copied from packages/runtime/scripts/swarm-e2e/env.cjs, parameterised by stack number.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../.."); // the kora checkout
const RT = path.join(ROOT, "packages/runtime");
const BIN = path.join(RT, "bin/kora.js");
const QA_BASE = process.env.KORA_QA_DIR || path.join(process.env.TMPDIR || os.tmpdir(), "kora-qa");
const NODE_BIN = path.join(os.homedir(), ".nvm/versions/node/v24.11.1/bin");

// A directory only this user can use: created 0700, refused if it is a symlink, someone else's, or group/world
// accessible in a way we can't fix. Predictable shared /tmp paths let another local user pre-create (or swap) them.
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink())
    throw new Error(`qa: ${dir} is not a plain directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid())
    throw new Error(`qa: ${dir} is owned by uid ${st.uid}, not you`);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return dir;
}

// Daemon sockets live in a per-run mkdtemp dir (0700) instead of fixed /tmp/kora-qa-<n>.sock. Every QA process (stack
// starter, seeder, specs) must agree on it, so its path is recorded in QA_BASE/sockdir and re-validated on each read; a
// missing or unsafe one is replaced. KORA_QA_SOCK_DIR pins it explicitly. The socket path stays short (macOS caps
// sun_path at 104 bytes): mkdtemp under os.tmpdir() (per-user on macOS), not under the deeper QA_BASE.
function sockDir() {
  if (process.env.KORA_QA_SOCK_DIR) return privateDir(process.env.KORA_QA_SOCK_DIR);
  privateDir(QA_BASE);
  const pointer = path.join(QA_BASE, "sockdir");
  try {
    const recorded = fs.readFileSync(pointer, "utf8").trim();
    if (recorded && path.isAbsolute(recorded) && fs.existsSync(recorded))
      return privateDir(recorded);
  } catch {
    /* no pointer yet, or the recorded dir is unusable: make a fresh one */
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-qa-"));
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(pointer, dir + "\n", { mode: 0o600 });
  return dir;
}

function socketPath(n) {
  const p = path.join(sockDir(), `s${n}.sock`);
  if (Buffer.byteLength(p) >= 104)
    throw new Error(`qa: socket path too long for macOS (${p}); set KORA_QA_SOCK_DIR`);
  return p;
}

function stack(n) {
  n = Number(n);
  if (!(n >= 1 && n <= 4)) throw new Error(`stack must be 1..4, got ${n}`);
  const base = path.join(privateDir(QA_BASE), `stack${n}`);
  const home = path.join(base, "home");
  const env = {
    KORA_HOME: home,
    KORA_SOCKET_PATH: socketPath(n), // per-run 0700 dir (see sockDir)
    KORA_UI_PORT: String(8800 + n * 10), // 8810, 8820, 8830, 8840
    KORA_AUTO_INGEST: "0",
    KORAGRAPH_HOME: path.join(base, "kg"),
    KORAGRAPH_DB: path.join(base, "graph.db"),
    KORAGRAPH_PRACTICE_DB: path.join(base, "practice.db"),
    // UI tests never reach a model: empty Claude/Codex homes mean no credentials, so a Send fails fast with an auth
    // error instead of spending tokens. Real model turns run only on the swarm-e2e harness (:8798).
    CLAUDE_CONFIG_DIR: path.join(base, "claude-empty"),
    CODEX_HOME: path.join(base, "codex-empty"),
    // Blobs: each blob's Finder folder lives under this stack's own temp dir (never ~/Blobs), and the memory
    // extractor is a stub so no model is ever called.
    KORA_BLOBS_ROOT: path.join(base, "Blobs"),
    // A deleted blob's folder goes to this stack's own Trash, never the user's ~/.Trash.
    KORA_TRASH_DIR: path.join(base, "Trash"),
    KORA_BLOBS_EXTRACTOR: "stub",
    // No macOS notifications from a QA daemon (blobs settling with the UI closed would otherwise post real ones).
    KORA_NOTIFY: "0",
    // The Claude lane answers from a canned stand-in (packages/runtime/src/session/qa-stub-query.ts): routines, blob chats and
    // approvals run end to end in the real daemon + UI without a model.
    KORA_QA_STUB_ENGINE: "1",
    // Kora (blobs) is coming soon in every build (packages/runtime/src/edition.ts); the QA stacks run with the developer
    // override so qa/e2e/20-blobs keeps testing Kora itself. KORA_QA_SURFACE=coming-soon runs a stack as users see it.
    KORA_SURFACE: process.env.KORA_QA_SURFACE || "on",
    // Group chats: a member that has not answered in 4 s is cut off with a note (the product default is 5 minutes).
    KORA_GROUP_MEMBER_TIMEOUT_MS: "4000",
    // Connected apps keep their secrets in a file in this stack's home, never in the user's macOS Keychain.
    KORA_APPS_VAULT: "file",
    // Extensions: the agents' own config folders (discovery, skill links, Antigravity's MCP file) are this stack's
    // scratch home, never the user's ~/.claude, ~/.codex or ~/.gemini.
    KORA_AGENTS_HOME: path.join(base, "agents-home"),
    // Blob browsers: this stack's own engine cache, never the user's ~/Library/Application Support/Kora/browser. A run that has
    // the headless shell installed once points every stack at it with KORA_QA_BROWSER_DIR (so it is downloaded one time).
    KORA_BROWSER_DIR: process.env.KORA_QA_BROWSER_DIR || path.join(base, "browser"),
  };
  // The blob browser's engine, served from this machine (http://127.0.0.1 only): a spec that drives the real Set up button
  // without a 98 MB download. See `testEngineSource` (packages/runtime/src/blobs/browser/engine.ts).
  if (process.env.KORA_QA_BROWSER_TEST_SOURCE)
    env.KORA_BROWSER_TEST_SOURCE = process.env.KORA_QA_BROWSER_TEST_SOURCE;
  // Connected apps: a spec starts qa/stacks/fake-broker.cjs and restarts the daemon with these (unset = "not set up yet").
  if (process.env.KORA_QA_BROKER_URL) env.KORA_COMPOSIO_BROKER_URL = process.env.KORA_QA_BROKER_URL;
  if (process.env.KORA_QA_COMPOSIO_API)
    env.KORA_COMPOSIO_API_BASE = process.env.KORA_QA_COMPOSIO_API;
  // KORA_QA_REAL_MODELS=1: keep the user's real Claude/Codex logins (live checks that must reach a model —
  // keep those prompts to one-word answers). Everything else stays isolated.
  if (process.env.KORA_WORKER_SLEEP_MS) env.KORA_WORKER_SLEEP_MS = process.env.KORA_WORKER_SLEEP_MS;
  if (process.env.KORA_QA_REAL_MODELS === "1") {
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CODEX_HOME;
  }
  return {
    n,
    base,
    home,
    env,
    repos: path.join(base, "repos"),
    uiPort: Number(env.KORA_UI_PORT),
    webPort: 5700 + n * 10, // 5710, 5720, 5730, 5740
    url: `http://localhost:${5700 + n * 10}`,
  };
}

function childEnv(s) {
  const e = { ...process.env };
  for (const k of Object.keys(e))
    if (/^(KORA_|KORAGRAPH_|CLAUDE_CODE_|CLAUDECODE|ANTHROPIC_)/.test(k)) delete e[k];
  e.PATH = `${NODE_BIN}:${e.PATH}`;
  return { ...e, ...s.env };
}

/**
 * Folder trust lives only in `<KORA_HOME>/trust.json` (runtime trust/store.ts); `trustedRoots` no longer implies it,
 * and the daemon's one-time trust migration runs before the seed makes any repo. Without this every stack repo shows
 * "Trust this folder?" and runs without its own agent config. Trusting the repos folder covers each repo under it and
 * Kora's worktrees of them (they resolve to their main checkout). Entries are realpaths (`/tmp` → `/private/tmp`), as
 * the store compares them; other entries (a spec's own trust/revoke) are kept.
 */
function trustStackRepos(s) {
  fs.mkdirSync(s.repos, { recursive: true });
  const root = fs.realpathSync.native(s.repos);
  const file = path.join(s.home, "trust.json");
  let data = { version: 1, folders: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed?.folders)) data = { version: 1, folders: parsed.folders };
  } catch {
    /* no store yet */
  }
  if (data.folders.some((entry) => entry?.path === root)) return;
  data.folders.push({ path: root, trustedAt: Date.now(), source: "cli" });
  fs.mkdirSync(s.home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function prepareHome(s, { swarmConsent = true } = {}) {
  fs.mkdirSync(path.join(s.home, "tools"), { recursive: true });
  if (s.env.CLAUDE_CONFIG_DIR) fs.mkdirSync(s.env.CLAUDE_CONFIG_DIR, { recursive: true });
  if (s.env.CODEX_HOME) fs.mkdirSync(s.env.CODEX_HOME, { recursive: true });
  const oc = path.join(s.home, "tools", "opencode");
  // KORA_QA_FRESH_SWARM=1: a user who never set up Swarm — no consent and no OpenCode in THIS stack's home (only the
  // stack's own link or copy is removed; the shared ~/.kora/tools/opencode it points at is never touched).
  const freshSwarm = process.env.KORA_QA_FRESH_SWARM === "1";
  if (freshSwarm) {
    let st = null;
    try {
      st = fs.lstatSync(oc);
    } catch {
      /* nothing there */
    }
    if (st?.isSymbolicLink()) fs.unlinkSync(oc);
    else if (st?.isDirectory()) fs.rmSync(oc, { recursive: true, force: true });
  } else if (!fs.existsSync(oc)) {
    fs.symlinkSync(path.join(os.homedir(), ".kora", "tools", "opencode"), oc);
  }
  const cfgPath = path.join(s.home, "config.json");
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
  if (freshSwarm) {
    if (cfg.swarm) delete cfg.swarm.consent;
  } else if (swarmConsent)
    cfg.swarm = { ...(cfg.swarm || {}), consent: { noticeVersion: 1, acceptedAt: Date.now() } };
  cfg.trustedRoots = [s.repos, path.join(s.home, "worktrees")];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  trustStackRepos(s);
  // Antigravity has no isolated home: a stack would run `agy models` / `agy -p /usage` against the user's real Google
  // login at boot (agy opens sign-in tabs when its refresh fails). Point the stack at a missing agy unless real models
  // were asked for (deep audit A3).
  const engPath = path.join(s.home, "engines.json");
  if (process.env.KORA_QA_REAL_MODELS !== "1" && !fs.existsSync(engPath))
    fs.writeFileSync(
      engPath,
      JSON.stringify({ executables: { antigravity: path.join(s.base, "no-agy", "agy") } }, null, 2),
    );
}

module.exports = {
  ROOT,
  RT,
  BIN,
  QA_BASE,
  NODE_BIN,
  stack,
  childEnv,
  prepareHome,
  trustStackRepos,
  privateDir,
  sockDir,
  socketPath,
};
