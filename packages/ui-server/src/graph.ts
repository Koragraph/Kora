// @effect-diagnostics globalConsole:off -- the daemon logs to stdout for `vp run` / the desktop wrapper, not through a Logger.
// @effect-diagnostics globalDate:off globalTimers:off -- plain timestamps (and the Windows store-maintenance poll) for wire payloads and logs, produced outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- plain Node APIs: this module is the boundary to the in-process kora runtime, which is not Effect code.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

import { isBlobsCwd } from "./assistantFs.ts";
import { graphDbPath, koraHome, koragraphHome } from "./paths.ts";

/**
 * Read-only view onto the embedded Koragraph SQLite store (`~/.koragraph/graph.db`).
 *
 * This is the data behind the in-chat Graph Explorer: a force-directed picture of
 * the indexed repo's code graph (declarations + call/import/extends edges). We read
 * the store directly with Node 24's built-in `node:sqlite` (no dependency) rather
 * than shelling out to the koragraph CLI, because we need a whole subgraph
 * (nodes + edges) in one shot, not a ranked answer. The store is opened read-only
 * and never written — ingest is owned by kora.
 *
 * The full store spans every repo Koragraph has ever indexed (millions of rows), so
 * we scope to one repository branch and return only the top-N nodes by degree plus
 * the edges among them — a legible, bounded subgraph the client can force-lay-out.
 */

// The engine's own resolution (koragraph/src/db/pool.js): KORAGRAPH_DB, else KORAGRAPH_HOME/graph.db, else
// ~/.koragraph/graph.db. This module used to hard-code the last one, so a daemon started with another store (QA stacks,
// a second profile) drew and reported a DIFFERENT graph from the one its own tools and hooks were using.
const DB_PATH = graphDbPath();

/** Nodes that are live. ARCHIVED rows are soft-deleted declarations (renamed/edited/removed files): never counted, never drawn. */
const LIVE = "n.approval_status <> 'ARCHIVED'";

/** Code-structure node types worth drawing (skip DOC/RATIONALE/DIRECTORY noise). */
const DRAWN_NODE_TYPES = ["METHOD", "CLASS", "CONSTANT", "FILE", "FIELD", "INTERFACE", "TYPE"];

export interface GraphNode {
  readonly id: number;
  readonly label: string;
  readonly file: string;
  readonly kind: string;
  readonly cluster: string;
  readonly degree: number;
}

export interface GraphEdge {
  readonly source: number;
  readonly target: number;
  readonly kind: string;
}

export interface GraphSnapshot {
  readonly repo: string;
  readonly branch: string;
  readonly nodes: ReadonlyArray<GraphNode>;
  readonly edges: ReadonlyArray<GraphEdge>;
  readonly clusters: ReadonlyArray<{ readonly name: string; readonly count: number }>;
  readonly stats: {
    readonly totalNodes: number;
    readonly totalEdges: number;
    readonly shownNodes: number;
    readonly shownEdges: number;
  };
}

/** One folder under two spellings (macOS /var vs /private/var, a symlinked parent)? */
function sameFolder(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/** The `label` a node should carry: FILE nodes are named by full path, so show the basename. */
function nodeLabel(name: string, kind: string): string {
  if (kind === "FILE") return name.split("/").pop() ?? name;
  return name;
}

/** Cluster = the directory segment after `src/` (or the top-level dir), which maps to a color. */
function clusterOf(filePath: string): string {
  // A store written on Windows can hold `\` paths; a macOS file name may contain a backslash, so split on it there only.
  const parts = (filePath || "")
    .split(process.platform === "win32" ? /[\\/]/ : "/")
    .filter(Boolean);
  const srcIdx = parts.indexOf("src");
  if (srcIdx >= 0 && parts[srcIdx + 1]) return parts[srcIdx + 1]!;
  return parts[0] ?? "root";
}

/** The slice of a SQLite connection this module uses: node:sqlite's DatabaseSync and better-sqlite3 both fit it. */
export interface GraphDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  exec(sql: string): unknown;
  close(): unknown;
}

/**
 * How to open the store. Inside the daemon the runtime hands in a better-sqlite3 opener (`UiHost.openGraphDb`): the
 * graph workers write the same file through better-sqlite3, and TWO copies of SQLite in one process on one file is
 * SQLite's documented corruption hazard — POSIX locks are per process, so when one copy's last connection closes it
 * thinks it is alone, checkpoints and unlinks the -wal/-shm, and the other copy keeps reading an orphaned wal-index:
 * the chip and explorer froze on an old snapshot until a daemon restart (pl3 S1-1, 2026-10-11). node:sqlite stays the
 * fallback for tests and a daemon that predates the opener.
 */
let opener: ((file: string) => GraphDb) | null = null;
export function setGraphDbOpener(fn: ((file: string) => GraphDb) | null): void {
  opener = fn;
  resetDb();
}

type FileId = string | null;
const fileId = (p: string): FileId => {
  try {
    const st = fs.statSync(p);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
};
/** db / -wal / -shm identity seen while the connection was healthy. */
let seen: [FileId, FileId, FileId] | null = null;
/**
 * Has the store been swapped under the open connection? A replaced graph.db (moved aside and rebuilt), or a -wal/-shm
 * that vanished or was re-created while we held it, means our connection reads a dead snapshot: reopen. A -wal/-shm that
 * merely appeared (null -> file) is the normal first read.
 */
function storeMoved(): boolean {
  const now: [FileId, FileId, FileId] = [
    fileId(DB_PATH),
    fileId(`${DB_PATH}-wal`),
    fileId(`${DB_PATH}-shm`),
  ];
  const prev = seen;
  seen = now;
  if (!prev) return false;
  return now.some((id, i) => prev[i] !== null && id !== prev[i]);
}

// ---------------------------------------------------------------- slow-SQL visibility
/**
 * Any statement over KORAGRAPH_SLOW_SQL_MS (default 1000 here; the ingest's env var, same meaning) is logged once with its
 * EXPLAIN QUERY PLAN, so the next pathological plan names itself instead of freezing the daemon silently (2026-10-14).
 * Rate-limited: one report per distinct statement per 10 minutes and at most 6 reports a minute.
 */
export function slowSqlThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KORAGRAPH_SLOW_SQL_MS;
  if (raw === undefined || raw === "") return 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
let slowSink: (line: string) => void = (line) => console.error(line);
export function setSlowSqlSink(fn: ((line: string) => void) | null): void {
  slowSink = fn ?? ((line) => console.error(line));
}
const slowSeen = new Map<string, number>();
let slowWindow = { start: 0, count: 0 };
export function resetSlowSqlForTests(): void {
  slowSeen.clear();
  slowWindow = { start: 0, count: 0 };
}
function reportSlow(raw: GraphDb, sql: string, params: unknown[], ms: number): void {
  const now = Date.now();
  const key = sql.replace(/\s+/g, " ").trim();
  const last = slowSeen.get(key);
  if (last !== undefined && now - last < 10 * 60_000) return;
  if (now - slowWindow.start > 60_000) slowWindow = { start: now, count: 0 };
  if (slowWindow.count >= 6) return;
  slowWindow.count += 1;
  slowSeen.set(key, now);
  if (slowSeen.size > 200) slowSeen.delete(slowSeen.keys().next().value as string);
  let plan = "(plan unavailable)";
  try {
    const rows = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail?: string;
    }>;
    plan = rows.map((r) => r.detail ?? JSON.stringify(r)).join(" | ");
  } catch {
    /* best effort */
  }
  slowSink(
    `[graph] slow SQL (${Math.round(ms)} ms): ${key.slice(0, 600)}\n[graph] plan: ${plan.slice(0, 1200)}`,
  );
}
/** Wrap a connection so its reads are timed. `thresholdMs` 0 = off. */
export function instrumentSlowSql(
  raw: GraphDb,
  thresholdMs: number = slowSqlThresholdMs(),
): GraphDb {
  if (thresholdMs <= 0) return raw;
  return {
    prepare(sql: string) {
      const st = raw.prepare(sql);
      const timed =
        <F extends (...p: unknown[]) => unknown>(fn: F) =>
        (...p: unknown[]) => {
          const t0 = performance.now();
          try {
            return fn.apply(st, p);
          } finally {
            const ms = performance.now() - t0;
            if (ms >= thresholdMs) reportSlow(raw, sql, p, ms);
          }
        };
      return { all: timed(st.all) as typeof st.all, get: timed(st.get) as typeof st.get };
    },
    exec: (sql: string) => raw.exec(sql),
    close: () => raw.close(),
  };
}

// ---------------------------------------------------------------- store maintenance (Windows)
/**
 * Windows refuses to rename, replace or vacuum the store while any process holds it open. A maintainer (a `kora ingest`
 * quarantining a damaged store, `kora graph prune --vacuum`) writes `<db>.maintenance`; while it is there this module
 * closes its connection and every read answers busy (`StoreMaintenanceError`), then the next read reopens. The marker is
 * only ever written on Windows, so on macOS this is one failed stat per open. Mirrors the runtime's
 * graph/store-maintenance.ts (separate bundle) — keep the two in step.
 */
export class StoreMaintenanceError extends Error {
  constructor() {
    super("graph store maintenance in progress");
    this.name = "StoreMaintenanceError";
  }
}
const MARKER_STALE_MS = 60_000;
export function storeMaintenanceActive(
  dbFile: string = DB_PATH,
  now: number = Date.now(),
): boolean {
  try {
    return now - fs.statSync(`${dbFile}.maintenance`).mtimeMs < MARKER_STALE_MS;
  } catch {
    return false;
  }
}
let maintenancePoll: ReturnType<typeof setInterval> | null = null;
/** Close the connection if a maintainer is waiting. The Windows poll calls it while a connection is open. */
export function honourStoreMaintenance(): boolean {
  if (!storeMaintenanceActive()) return false;
  resetDb();
  return true;
}
// A maintainer in THIS process (the daemon running an ingest) calls its holders directly: a busy event loop would not run
// the poll. The registry lives on globalThis because the runtime and this bundle are separate module graphs.
{
  const g = globalThis as unknown as Record<symbol, Set<(f: string) => void> | undefined>;
  const key = Symbol.for("kora.graph-store-maintenance.listeners");
  (g[key] ??= new Set()).add(() => resetDb());
}

let db: GraphDb | null = null;
function open(): GraphDb {
  if (honourStoreMaintenance()) throw new StoreMaintenanceError();
  if (db !== null && storeMoved()) resetDb();
  if (db === null) {
    if (opener) {
      db = instrumentSlowSql(opener(DB_PATH));
    } else {
      // NOT read-only: a strictly read-only connection cannot read a WAL-mode database with a large
      // active WAL (readers must touch the -shm/-wal files), which is exactly the state during a big
      // ingest — and that made every graph read fail. Open read-write but PRAGMA query_only so we
      // still never write, and a busy_timeout so a momentary writer lock waits instead of throwing.
      const next = new DatabaseSync(DB_PATH);
      try {
        next.exec("PRAGMA busy_timeout = 4000");
        next.exec("PRAGMA query_only = ON");
      } catch {
        /* pragmas best-effort */
      }
      db = instrumentSlowSql(next as unknown as GraphDb);
    }
    seen = null;
    storeMoved();
    // An idle reader still holds the file: on Windows poll for a maintainer while the connection is open.
    if (process.platform === "win32" && maintenancePoll === null) {
      maintenancePoll = setInterval(honourStoreMaintenance, 250);
      maintenancePoll.unref?.();
    }
  }
  return db;
}
// Drop the cached connection so the next call reopens a fresh one. The reader can enter a bad
// state while a large ingest rewrites graph.db (WAL churn); self-healing beats a stuck 500.
function resetDb(): void {
  try {
    db?.close();
  } catch {
    /* already gone */
  }
  db = null;
  seen = null;
  if (maintenancePoll !== null) {
    clearInterval(maintenancePoll);
    maintenancePoll = null;
  }
}
// Run a read; on any failure drop the (possibly poisoned) connection and return a safe fallback so
// the next poll reopens fresh instead of every request throwing until a restart.
function safeRead<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof StoreMaintenanceError) throw err; // busy, not a failure: the caller answers busy
    console.error("[graph] read failed, resetting connection:", (err as Error)?.message ?? err);
    resetDb();
    return fallback;
  }
}

/**
 * Freshness of the code graph for the repo a `cwd` names — the state the composer's
 * graph chip shows constantly. Read-only, like buildGraphSnapshot: the branch's
 * recorded commit (indexedSha) vs. the checkout's live HEAD (headSha) decides fresh
 * vs. stale. `indexed:false` means the store has no branch for this cwd yet. Worktree
 * status is carried separately by the thread shell, so this reports the MAIN checkout's
 * currency (repoRoot = the indexed full_path), not a worktree's divergence.
 */
export interface GraphStatus {
  readonly indexed: boolean;
  readonly repo: string | null;
  readonly branch: string | null;
  readonly repoRoot: string | null;
  readonly indexedSha: string | null;
  readonly headSha: string | null;
  readonly stale: boolean;
  readonly nodes: number;
  readonly files: number;
  // A live ingest for this repo, if one is running right now (RUNNING ingest_jobs row,
  // recently updated). `pct` is null until file counts are known. Takes visual priority
  // over fresh/stale in the chip — "indexing" is the transient state.
  readonly indexing: { readonly pct: number | null; readonly finalizing?: boolean } | null;
  // A first/full index of this repo died or failed part-way: the store holds a partial graph, so `indexed` is false.
  readonly incomplete?: boolean;
  // The folder this project points at no longer exists (moved / renamed / deleted): the chip says so instead of "Fresh".
  readonly folderMissing?: boolean;
  // The store file itself cannot be read (not a database / malformed): "Not indexed · Index?" here sent every click into
  // a failing ingest. Re-indexing moves the damaged file aside and rebuilds (packages/runtime graph/service.ts).
  readonly storeDamaged?: boolean;
  // Matched only by name to an index built from another folder (this repo was moved / renamed, or a same-named repo was
  // deleted): its file:line answers may not fit this checkout, and it is never re-indexed automatically (a first index
  // of this checkout is click-only). The chip offers "Index moved — re-index?".
  readonly indexedFrom?: string;
  // The last index of this checkout failed (written by the runtime's ingest, removed on its next success): the chip's
  // Index/Re-index runs detached, and without this a failure before the job row existed was invisible.
  readonly ingestError?: { readonly message: string; readonly at: string };
  // What an explicit "Index this repo" would target (the main checkout root), and whether that
  // is a sensible thing to index. Un-indexed folders are never ingested automatically — the chip
  // asks first — so it needs to know where, and to warn on a home dir / fs root / non-repo.
  readonly indexRoot: string | null;
  readonly safeToIndex: boolean;
  // More tracked files than `autoIndexMaxFiles`: safeToIndex is false so opening the project does not start the first
  // index by itself (an explicit "Index anyway" still works). Estimated from .git/index.
  readonly largeRepo?: { readonly files: number; readonly limit: number };
  readonly isGitRepo: boolean;
  // The index target is the home dir, a parent of it, the fs root or a too-shallow path: never indexed from the UI,
  // not even "anyway" (the runtime refuses it too; `kora ingest --force` is the only way).
  readonly systemFolder: boolean;
  // A bare git repository (`repo.git`): no working files, nothing to index — open a checkout of it instead.
  readonly bareRepo?: boolean;
  // The project folder exists but this user may not read it (permissions): nothing here can work until that is fixed.
  readonly folderUnreadable?: boolean;
  // The graph reader did not answer in time (a query is stuck or the store is busy): this is NOT a verdict about the repo.
  // Clients keep whatever they last showed. Set only by the daemon's reader guard (graphReader.ts), never by a real read.
  readonly busy?: boolean;
}

const NOT_INDEXED: GraphStatus = {
  indexed: false,
  repo: null,
  branch: null,
  repoRoot: null,
  indexedSha: null,
  headSha: null,
  stale: false,
  nodes: 0,
  files: 0,
  indexing: null,
  indexRoot: null,
  safeToIndex: false,
  isGitRepo: false,
  systemFolder: false,
};

/** macOS system and app-data trees: never a project, often huge. Kept in step with the runtime's
 *  graph/embedded.ts SYSTEM_ROOTS (a /System/Library project was offered "Index anyway", 2026-10-04). */
const SYSTEM_ROOTS: readonly string[] = [
  "/System",
  "/Library",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/private/etc",
  "/dev",
  "/cores",
  "/Applications",
  "/opt/homebrew",
  "/var/db",
  "/private/var/db",
  "/var/root",
  "/private/var/root",
];
const HOME_SYSTEM_DIRS: readonly string[] =
  process.platform === "win32" ? ["AppData", "$Recycle.Bin"] : ["Library", ".Trash"];
/** Windows' system and program trees. Kept in step with the runtime's graph/embedded.ts windowsSystemRoots. */
function windowsSystemRoots(): string[] {
  const env = process.env;
  const sys = env.SystemRoot || env.windir || "C:\\Windows";
  const drive = path.win32.parse(sys).root;
  return [
    sys,
    env.ProgramFiles || drive + "Program Files",
    env["ProgramFiles(x86)"] || drive + "Program Files (x86)",
    env.ProgramData || drive + "ProgramData",
    drive + "$Recycle.Bin",
    drive + "System Volume Information",
  ];
}

/** The temp and mount roots themselves (`/private/tmp`, `/var/folders/xx/hash/T`, `/Volumes/Disk`); a project below them
 *  is fine. Kept in step with the runtime's graph/embedded.ts tempOrVolumeRoot (pl3 S2-2). */
function tempOrVolumeRoot(root: string): boolean {
  const exact = new Set([
    // oxlint-disable-next-line kora/no-posix-only-paths -- macOS temp/volume roots; os.tmpdir() covers Windows
    "/tmp",
    "/private/tmp",
    "/var/tmp",
    "/private/var/tmp",
    "/var",
    "/private/var",
    "/private",
    "/var/folders",
    "/private/var/folders",
    "/Volumes",
  ]);
  exact.add(path.resolve(os.tmpdir()));
  try {
    exact.add(fs.realpathSync(os.tmpdir()));
  } catch {
    /* gone */
  }
  const forms = [path.resolve(root)];
  try {
    forms.push(fs.realpathSync(root));
  } catch {
    /* not there yet */
  }
  return forms.some((r) => {
    if (exact.has(r)) return true;
    const seg = r.split(path.sep).filter(Boolean);
    if (seg[0] === "Volumes" && seg.length === 2) return true;
    const f = seg.indexOf("folders");
    return (
      f >= 0 &&
      (seg[0] === "var" || (seg[0] === "private" && seg[1] === "var")) &&
      seg.length - f - 1 <= 3
    );
  });
}

/** Never index these without a very deliberate choice: the fs root, the home dir or any
 *  ancestor of it, a too-shallow path, a temp/volume root, or a macOS system / app-data tree. Mirrors kora's unsafeIndexRoot. */
export function isSafeToIndex(root: string): boolean {
  const r = path.resolve(root);
  if (r === path.parse(r).root) return false;
  const home = os.homedir();
  if (r === home) return false;
  if ((home + path.sep).startsWith(r + path.sep)) return false;
  // Segments below the filesystem / drive root: `/a` and `C:\a` are both too shallow.
  if (path.relative(path.parse(r).root, r).split(path.sep).filter(Boolean).length < 2) return false;
  const win = process.platform === "win32";
  const fold = (s: string) => (win ? s.toLowerCase() : s); // NTFS is case-insensitive
  const system = [
    ...(win ? windowsSystemRoots() : SYSTEM_ROOTS),
    ...HOME_SYSTEM_DIRS.map((d) => path.join(home, d)),
  ].map(fold);
  // Windows' temp folder lives under AppData; a project below it is as fine as one under macOS's /var/folders/…/T.
  const inTemp = win && fold(r).startsWith(fold(path.resolve(os.tmpdir())) + path.sep);
  if (!inTemp && system.some((s) => fold(r) === s || fold(r).startsWith(s + path.sep)))
    return false;
  if (tempOrVolumeRoot(r)) return false;
  return true;
}

/** Kora's own git runs: no fsmonitor command from a repo's config, never a credential prompt, no optional locks. */
const GIT_SAFE = ["-c", "core.fsmonitor=false"] as const;
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_OPTIONAL_LOCKS: "0",
});

function git(cwd: string, args: ReadonlyArray<string>): string | null {
  try {
    return (
      execFileSync("git", [...GIT_SAFE, "-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
        maxBuffer: 4 * 1024 * 1024,
        env: gitEnv(),
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * The MAIN checkout root for a cwd — correct from inside a linked worktree (git-common-dir
 * names the shared .git). Shared by the status resolver and the re-index route so both act
 * on the checkout the graph is keyed to, never a worktree.
 */
export function resolveMainRoot(cwd: string): string {
  return mainRootInfo(cwd).root;
}
/**
 * resolveMainRoot plus whether cwd is inside a git checkout at all (one git call in the usual case). The main checkout is
 * the folder holding the common `.git`. A common dir with another name is a BARE repository (`repo.git`: no working
 * files) or a git dir kept elsewhere (`--separate-git-dir`): its parent is NOT the checkout — "Index this repo" on a
 * bare repo used to index the folder it sits in (found 2026-10-04: a `tiny-lib-remote.git` project offered to index
 * every repo beside it). Ask git for the work tree instead; a bare repo has none.
 */
type RootInfo = { root: string; isGit: boolean; bare?: true };
/**
 * The chip polls /api/graph/status every few seconds per open thread, and every poll ran up to three blocking `git`
 * processes on the daemon's event loop (rev-parse twice, HEAD once): measured 46 ms median / 108 ms max per poll on an
 * idle Mac, 100–500 ms per spawn under load — the 2–6 s UI freezes (night 2026-10-04). Where a cwd's checkout lives
 * changes only when a `.git` appears or goes, so the answer is cached per cwd and revalidated with one stat.
 */
const rootCache = new Map<
  string,
  { at: number; value: RootInfo; stamp: string; stampExists: boolean }
>();
const ROOT_TTL_MS = 30_000;
function mainRootInfo(cwd: string): RootInfo {
  const hit = rootCache.get(cwd);
  if (hit && Date.now() - hit.at < ROOT_TTL_MS && fs.existsSync(hit.stamp) === hit.stampExists)
    return hit.value;
  const value = mainRootInfoUncached(cwd);
  // A repo is re-checked when its .git goes; a plain folder when a .git appears in it (`git init`, initGitRepo).
  const stamp = value.isGit ? path.join(value.root, ".git") : path.join(cwd, ".git");
  rootCache.set(cwd, { at: Date.now(), value, stamp, stampExists: fs.existsSync(stamp) });
  if (rootCache.size > 256) rootCache.delete(rootCache.keys().next().value as string);
  return value;
}
/** Test seam: forget cached checkout roots. */
export function resetRootCacheForTests(): void {
  rootCache.clear();
}

/**
 * HEAD of a main checkout read straight from `.git` (HEAD → loose ref → packed-refs): the same answer as
 * `git rev-parse HEAD` without a process per poll. Unusual layouts (a `.git` file, an unborn or odd ref) ask git.
 */
export function readHeadSha(root: string): string | null {
  try {
    const dotGit = path.join(root, ".git");
    if (!fs.statSync(dotGit).isDirectory()) return git(root, ["rev-parse", "HEAD"]);
    const head = fs.readFileSync(path.join(dotGit, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40,64}$/.test(head)) return head;
    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
    if (!ref || ref.includes("..")) return git(root, ["rev-parse", "HEAD"]);
    try {
      const loose = fs.readFileSync(path.join(dotGit, ref), "utf8").trim();
      if (/^[0-9a-f]{40,64}$/.test(loose)) return loose;
    } catch {
      /* packed, or unborn */
    }
    let packed = "";
    try {
      packed = fs.readFileSync(path.join(dotGit, "packed-refs"), "utf8");
    } catch {
      return null; // unborn branch: no commit yet (what `git rev-parse HEAD` reports as nothing)
    }
    for (const line of packed.split("\n")) {
      const [sha, name] = line.trim().split(" ");
      if (name === ref && sha && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
    }
    return null;
  } catch {
    return git(root, ["rev-parse", "HEAD"]);
  }
}

function mainRootInfoUncached(cwd: string): RootInfo {
  const commonDir = git(cwd, ["rev-parse", "--git-common-dir"]);
  if (!commonDir) return { root: realRoot(cwd), isGit: false };
  const common = path.resolve(cwd, commonDir);
  if (path.basename(common) === ".git")
    return { root: realRoot(path.dirname(common)), isGit: true };
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  return top
    ? { root: realRoot(top), isGit: true }
    : { root: realRoot(cwd), isGit: false, bare: true };
}
function realRoot(root: string): string {
  // Symlink-resolved, like git's toplevel and the runtime's ingest root: a project opened through a symlinked path read
  // "Not indexed" here while the agents' graph was fine, and its Index click built a duplicate index under the link.
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}

/** A RUNNING ingest for this repo (by the path it was invoked with), updated in the last
 *  few minutes so a crashed job's stale RUNNING row never shows a permanent spinner. */
function indexingFor(
  database: GraphDb,
  roots: ReadonlyArray<string>,
): { pct: number | null; finalizing?: boolean } | null {
  const distinct = [...new Set(roots.filter(Boolean))];
  if (distinct.length === 0) return null;
  const placeholders = distinct.map(() => "?").join(",");
  const row = database
    .prepare(
      `SELECT files_done AS done, files_total AS total, updated_at AS updated
       FROM ingest_jobs
       WHERE status = 'RUNNING' AND local_path IN (${placeholders})
       ORDER BY id DESC LIMIT 1`,
    )
    .get(...distinct) as
    | { done: number | null; total: number | null; updated: string | null }
    | undefined;
  if (!row) return null;
  const updatedMs = row.updated ? Date.parse(row.updated) : NaN;
  // A RUNNING row is live only while something holds the repo's ingest lock (a killed run leaves the row RUNNING for good;
  // it used to read "Indexing 14%" for minutes). A process that has not taken the lock yet is at most a moment old.
  const quietMs = Number.isFinite(updatedMs) ? Date.now() - updatedMs : Infinity;
  if (quietMs > 15_000 && !liveIngestLock(distinct)) return null;
  if (quietMs > 3 * 60_000) return { pct: 100, finalizing: true };
  const pct =
    row.total && row.total > 0 && row.done != null
      ? Math.min(100, Math.max(0, Math.round((row.done / row.total) * 100)))
      : null;
  // Every file is extracted but the job is still RUNNING: it is resolving edges across the store (minutes on a big
  // repo). "Indexing 100%" for minutes reads as hung; the chip says "Finalizing" instead.
  const finalizing =
    row.total != null && row.total > 0 && row.done != null && row.done >= row.total;
  return finalizing ? { pct, finalizing: true } : { pct };
}

/** Is a live process indexing one of these roots right now? Reads the ingest lock files: kora's under
 *  <KORA_HOME>/locks (`{pid, root}`) and koragraph's own under <KORAGRAPH_HOME>/locks (`{pid, repo}`, held for the whole run
 *  by every ingest path). A lock is stale when its pid is gone. */
function liveIngestLock(roots: ReadonlyArray<string>): boolean {
  const want = new Set(roots.filter(Boolean).map((r) => path.resolve(r)));
  const dirs = [path.join(koraHome(), "locks"), path.join(koragraphHome(), "locks")];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".lock")) continue;
      try {
        const cur = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as {
          pid?: number;
          root?: string;
          repo?: string;
        };
        const at = cur.root ?? cur.repo;
        if (!at || !cur.pid || !want.has(path.resolve(at))) continue;
        try {
          process.kill(cur.pid, 0);
          return true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
        }
      } catch {
        /* unreadable lock: ignore */
      }
    }
  }
  return false;
}

/** The latest full index of exactly this checkout completed (with whatever it found — possibly nothing): the commit it
 *  was taken at (null before the first commit), or null when there is no such index. */
function completedEmptyIndex(
  database: GraphDb,
  root: string,
): { indexedSha: string | null } | null {
  const row = database
    .prepare(
      `SELECT status FROM ingest_jobs WHERE local_path = ? AND COALESCE(job_type, 'FULL') <> 'INCREMENTAL'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(root) as { status: string } | undefined;
  if (row?.status !== "COMPLETE") return null;
  const branch = database
    .prepare(
      `SELECT b.last_commit_sha AS sha FROM repositories r JOIN repository_branches b ON b.repository_id = r.id
       WHERE r.full_path = ? ORDER BY b.id DESC LIMIT 1`,
    )
    .get(root) as { sha: string | null } | undefined;
  return { indexedSha: branch?.sha || null };
}

/** The latest FULL ingest of this checkout failed, or is RUNNING but stopped updating (killed): a partial graph. */
function indexDiedPartWay(database: GraphDb, roots: ReadonlyArray<string>): boolean {
  const distinct = [...new Set(roots.filter(Boolean))];
  if (distinct.length === 0) return false;
  const row = database
    .prepare(
      `SELECT status, job_type AS jobType, updated_at AS updated, started_at AS started
       FROM ingest_jobs WHERE local_path IN (${distinct.map(() => "?").join(",")})
         AND COALESCE(job_type, 'FULL') <> 'INCREMENTAL'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(...distinct) as
    | { status: string; jobType: string | null; updated: string | null; started: string | null }
    | undefined;
  if (!row) return false;
  if (row.status === "FAILED") return true;
  if (row.status !== "RUNNING" && row.status !== "PENDING") return false;
  if (liveIngestLock(roots)) return false; // still working (a long edge-resolution tail writes no progress)
  const t = Date.parse(row.updated ?? row.started ?? "");
  return !Number.isFinite(t) || Date.now() - t > 15_000; // nobody alive behind a RUNNING job
}

/**
 * Resolve which indexed repository a cwd belongs to, the way the graph TOOLS do (koragraph
 * matches by identity/name), not by a raw full_path prefix — so a worktree, or the same repo
 * checked out at another path, resolves to the shared index instead of reading as unindexed.
 * Prefers an exact main-root match, then a full_path prefix, then the repo name. Shared by the
 * status resolver and the graph snapshot so the chip and the picture always agree.
 */
function resolveRepoForCwd(
  database: GraphDb,
  cwd: string,
): { id: number; name: string; full_path: string; moved?: boolean } | null {
  const { root: mainRoot, isGit: inGit } = mainRootInfo(cwd);
  const repoName = path.basename(mainRoot);
  let realCwd = cwd;
  try {
    realCwd = fs.realpathSync(cwd);
  } catch {
    /* keep */
  }
  // Empty repo rows (0 nodes — e.g. a stray ingest of the home dir) are never a match: an
  // indexed `~` with no nodes used to swallow every path under home via the prefix rule
  // below, so every other repo read as "No graph".
  const repos = database
    .prepare(
      `SELECT r.id, r.name, r.full_path FROM repositories r
       WHERE r.is_archived = 0
         AND EXISTS (SELECT 1 FROM repository_branches b CROSS JOIN nodes n ON n.repository_branch_id = b.id
                     WHERE b.repository_id = r.id AND ${LIVE})`,
    )
    .all() as Array<{ id: number; name: string; full_path: string }>;
  return (
    repos.find((r) => r.full_path === mainRoot) ??
    repos
      .filter(
        (r) =>
          r.full_path &&
          [cwd, realCwd].some((c) => c === r.full_path || c.startsWith(r.full_path + path.sep)),
      )
      // Inside a git repo the git root is the boundary: an index rooted ABOVE it is a
      // different (enclosing) tree, never this repo.
      .filter((r) => !inGit || r.full_path.length >= mainRoot.length)
      .sort((a, b) => b.full_path.length - a.full_path.length)[0] ??
    // Same basename but a different checkout that still exists is NOT this repo (two `app` folders): only a row whose
    // recorded folder is gone (this repo was moved / renamed) may answer by name.
    movedMatch(
      repos.find(
        (r) =>
          (r.name || "").toLowerCase() === repoName.toLowerCase() &&
          !(
            r.full_path &&
            path.isAbsolute(r.full_path) &&
            fs.existsSync(r.full_path) &&
            !sameFolder(r.full_path, mainRoot)
          ),
      ),
      mainRoot,
    ) ??
    null
  );
}
/** A name-only match whose recorded folder is not this one: the index was built from another copy (moved / renamed).
 *  The runtime never catches such an index up on its own (audit 2026-10-15 #2: it is a first index of THIS checkout,
 *  which is click-only), so the chip has to say so. */
function movedMatch<T extends { full_path: string }>(
  r: T | undefined,
  mainRoot: string,
): (T & { moved?: boolean }) | undefined {
  if (!r) return undefined;
  return r.full_path && path.isAbsolute(r.full_path) && !sameFolder(r.full_path, mainRoot)
    ? { ...r, moved: true }
    : r;
}

export function buildGraphStatus(cwd: string | undefined): GraphStatus {
  if (!cwd) return NOT_INDEXED;
  // No graph anywhere on the assistant lane: never index (or offer to index) ~/.kora/chats — the chip
  // asks nothing and nothing auto-ingests there. Checked first, ahead of any git/db work.
  if (isBlobsCwd(cwd)) return NOT_INDEXED;
  // The git facts come first and survive a store that can't be read: on a fresh machine there is
  // no ~/.koragraph yet, and falling back to NOT_INDEXED there called every repo "not a git repo"
  // and hid the chip's Index action — the only way the first index starts.
  let target: GitTarget;
  try {
    target = gitTarget(cwd);
  } catch {
    return NOT_INDEXED;
  }
  // A project whose folder was moved / renamed / deleted: say so before anything else ("Fresh" on a folder that is not
  // there is the worst answer, and "Index this repo" on it would fail).
  if (!fs.existsSync(cwd)) return { ...NOT_INDEXED, ...target, folderMissing: true };
  // A folder this user may not read: git fails inside it, which read as "not a git repo" (night 2026-10-04).
  try {
    fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    return {
      ...NOT_INDEXED,
      ...target,
      isGitRepo: false,
      safeToIndex: false,
      folderUnreadable: true,
    };
  }
  let st: GraphStatus;
  try {
    st = buildGraphStatusInner(cwd, target);
  } catch (err) {
    if (err instanceof StoreMaintenanceError) throw err; // the reader answers busy (last known status)
    resetDb(); // the next poll reopens: a store moved aside and rebuilt is picked up
    if (isStoreCorruptError(err)) st = { ...NOT_INDEXED, ...target, storeDamaged: true };
    else {
      // A store with no schema yet (fresh machine: nothing indexed) is the normal first state, not worth a log line per poll.
      if (!/no such table/i.test(String((err as Error)?.message ?? err)))
        console.error("[graph] read failed, resetting connection:", (err as Error)?.message ?? err);
      st = { ...NOT_INDEXED, ...target };
    }
  }
  const ingestError = st.indexing ? undefined : ingestErrorFor([target.indexRoot, cwd]);
  return ingestError ? { ...st, ingestError } : st;
}
/** packages/runtime src/graph/service.ts#ingestErrorFile — same key (sha1 of the resolved root, 16 hex). */
function ingestErrorFor(
  roots: ReadonlyArray<string | null | undefined>,
): { message: string; at: string } | undefined {
  const home = koraHome();
  const seen = new Set<string>();
  for (const r of roots) {
    if (!r) continue;
    const variants = [path.resolve(r)];
    try {
      variants.push(fs.realpathSync(r));
    } catch {
      /* gone */
    }
    for (const v of variants) {
      if (seen.has(v)) continue;
      seen.add(v);
      const key = createHash("sha1").update(v).digest("hex").slice(0, 16);
      try {
        const rec = JSON.parse(
          fs.readFileSync(path.join(home, "ingest-errors", `${key}.json`), "utf8"),
        ) as { error?: string; at?: string };
        if (rec.error) return { message: rec.error, at: rec.at ?? "" };
      } catch {
        /* none */
      }
    }
  }
  return undefined;
}

/** SQLite's "this file is not a usable database" family (garbage/truncated header, corrupt pages). */
function isStoreCorruptError(err: unknown): boolean {
  const e = err as { code?: unknown; errstr?: unknown; message?: unknown } | null;
  const text = `${String(e?.code ?? "")} ${String(e?.errstr ?? "")} ${String(e?.message ?? err)}`;
  return /SQLITE_NOTADB|SQLITE_CORRUPT|file is not a database|database disk image is malformed|malformed database schema/i.test(
    text,
  );
}
type GitTarget = Pick<
  GraphStatus,
  "indexRoot" | "safeToIndex" | "isGitRepo" | "systemFolder" | "bareRepo" | "largeRepo"
>;
/** Tracked-file ceiling for indexing a repo the moment it is opened (config `autoIndexMaxFiles`, env KORA_AUTO_INDEX_MAX_FILES). */
function autoIndexMaxFiles(): number {
  const env = Number(process.env.KORA_AUTO_INDEX_MAX_FILES);
  if (process.env.KORA_AUTO_INDEX_MAX_FILES !== undefined && Number.isFinite(env) && env >= 0)
    return env;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(koraHome(), "config.json"), "utf8")) as {
      autoIndexMaxFiles?: unknown;
    };
    if (typeof cfg.autoIndexMaxFiles === "number" && cfg.autoIndexMaxFiles >= 0)
      return cfg.autoIndexMaxFiles;
  } catch {
    /* default */
  }
  return 20_000;
}
/** Tracked files, estimated from the size of .git/index (one stat, no git process: this runs inside the daemon, per status call). ~110 bytes per entry. */
function estimateTrackedFiles(root: string): number | null {
  try {
    const st = fs.statSync(path.join(root, ".git", "index"));
    return st.isFile() ? Math.round(st.size / 110) : null;
  } catch {
    return null;
  }
}
export function gitTarget(cwd: string): GitTarget {
  const { root: mainRoot, isGit: isGitRepo, bare } = mainRootInfo(cwd);
  const files = isGitRepo && mainRoot ? estimateTrackedFiles(mainRoot) : null;
  const limit = autoIndexMaxFiles();
  // A very large repo is never indexed just because it was opened: it asks first (the chip's "Index anyway").
  const tooBig = files !== null && files > limit;
  return {
    indexRoot: mainRoot,
    safeToIndex: isGitRepo && isSafeToIndex(mainRoot) && !tooBig,
    ...(tooBig ? { largeRepo: { files: files!, limit } } : {}),
    isGitRepo,
    systemFolder: !isSafeToIndex(mainRoot),
    ...(bare ? { bareRepo: true as const } : {}),
  };
}
function buildGraphStatusInner(cwd: string, target: GitTarget): GraphStatus {
  const database = open();
  const mainRoot = target.indexRoot ?? cwd;

  // A first-ever ingest (nothing in the store yet) still shows as "indexing" from the job row.
  const firstIndex = indexingFor(database, [mainRoot, cwd]);

  const match = resolveRepoForCwd(database, cwd);
  if (!match) {
    // A repo with nothing to index yet (a brand-new project: no files, or none the graph reads) finishes its index
    // with 0 declarations, and 0-node rows never resolve (a stray `~` row must not swallow every repo). Without this
    // the chip kept saying "Not indexed · Index?" after a successful Index: the click looked like it did nothing.
    const empty = firstIndex ? null : completedEmptyIndex(database, mainRoot);
    if (empty) {
      const headSha = readHeadSha(mainRoot);
      // Indexed before the first commit (or at an older one) and HEAD has moved since: Stale, as for any repo.
      const stale = !!headSha && headSha !== empty.indexedSha;
      return {
        ...NOT_INDEXED,
        ...target,
        indexed: true,
        indexedSha: empty.indexedSha,
        headSha,
        stale,
      };
    }
    return { ...NOT_INDEXED, ...target, indexing: firstIndex };
  }

  const branch = database
    .prepare(
      `SELECT b.id AS id, b.branch_name AS branch, b.last_commit_sha AS sha,
         (SELECT COUNT(*) FROM nodes n WHERE n.repository_branch_id = b.id AND ${LIVE}) AS nodes,
         (SELECT COUNT(*) FROM files f WHERE f.repository_branch_id = b.id AND f.index_status != 'REMOVED') AS files
       FROM repository_branches b WHERE b.repository_id = ? ORDER BY nodes DESC LIMIT 1`,
    )
    .get(match.id) as
    | { id: number; branch: string; sha: string | null; nodes: number; files: number }
    | undefined;
  if (!branch || branch.nodes === 0) return { ...NOT_INDEXED, ...target, indexing: firstIndex };

  // HEAD of the MAIN checkout (mainRoot), not the caller's cwd: freshness is whether the
  // shared index is current with the branch it was built from. A worktree's own HEAD
  // divergence is surfaced separately (the thread's worktree glyph + the read-side overlay).
  const headSha = readHeadSha(mainRoot);
  const indexedSha = branch.sha ?? null;
  const stale = !!(
    indexedSha &&
    headSha &&
    !headSha.startsWith(indexedSha) &&
    !indexedSha.startsWith(headSha)
  );

  const incomplete = indexDiedPartWay(database, [mainRoot, match.full_path, cwd]);
  const folderMissing = !fs.existsSync(mainRoot);
  return {
    indexed: !incomplete,
    ...(incomplete ? { incomplete: true } : {}),
    ...(folderMissing ? { folderMissing: true } : {}),
    ...(match.moved ? { indexedFrom: match.full_path } : {}),
    repo: match.name,
    branch: branch.branch,
    repoRoot: match.full_path,
    indexedSha,
    headSha,
    stale,
    nodes: branch.nodes,
    files: branch.files,
    indexing: indexingFor(database, [mainRoot, match.full_path, cwd]),
    ...target,
  };
}

interface CacheEntry {
  readonly at: number;
  readonly snapshot: GraphSnapshot;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60_000;

// Hard ceiling on drawn nodes. Full repos are the goal (meridian ~20k), but an unbounded
// draw of the largest stores (~100k) would blow the payload and the layout; above this we
// keep the highest-degree core. The renderer (lib/forceGraph) is Barnes-Hut + batched, so
// tens of thousands lay out and paint smoothly.
const MAX_NODES = 30000;

/**
 * Build the drawable subgraph for one repo. `limit` 0/absent means the FULL graph (every
 * drawable node with an edge, capped at MAX_NODES by degree); a positive `limit` keeps the
 * top-N by degree. Degree is computed in ONE aggregation pass (the old per-node correlated
 * subquery was O(nodes·edges) — the reason this was capped at 600). Edges come from a
 * nodes-driven join (uses idx_edges_from_node, ~100ms for a full repo) then filtered to the
 * drawn set in JS. Cached per (branch, limit) for a few minutes.
 */
export function buildGraphSnapshot(opts?: {
  readonly cwd?: string;
  readonly limit?: number;
}): GraphSnapshot | null {
  return safeRead(() => buildGraphSnapshotInner(opts), null);
}
function buildGraphSnapshotInner(opts?: {
  readonly cwd?: string;
  readonly limit?: number;
}): GraphSnapshot | null {
  const requested = opts?.limit ?? 0;
  const limit = requested > 0 ? Math.min(requested, MAX_NODES) : MAX_NODES;
  const database = open();
  if (!opts?.cwd) return null;
  // Same resolver as the freshness chip, so the picture matches what the chip reports.
  const match = resolveRepoForCwd(database, opts.cwd);
  if (match === null) return null;
  // A half-built index would draw a misleading fragment ("0 of 135 declarations"): same verdict as the chip.
  if (indexDiedPartWay(database, [match.full_path, opts.cwd])) return null;
  const top = database
    .prepare(
      `SELECT b.id AS id, b.branch_name AS branch,
         (SELECT COUNT(*) FROM nodes n WHERE n.repository_branch_id = b.id AND ${LIVE}) AS nodes
       FROM repository_branches b WHERE b.repository_id = ? ORDER BY nodes DESC LIMIT 1`,
    )
    .get(match.id) as { id: number; branch: string; nodes: number } | undefined;
  if (!top || top.nodes === 0) return null;
  const branchId = top.id;
  const repo = match.name;
  const branch = top.branch;

  const cacheKey = `${branchId}:${limit}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.snapshot;

  const typeList = DRAWN_NODE_TYPES.map((t) => `'${t}'`).join(",");
  // Degree per node in one pass: count edge endpoints touching this branch, grouped.
  const rows = database
    .prepare(
      `WITH deg AS (
         SELECT node_id, COUNT(*) AS d FROM (
           SELECT e.from_node_id AS node_id FROM nodes nf CROSS JOIN edges e ON e.from_node_id = nf.id WHERE nf.repository_branch_id = ?
           UNION ALL
           SELECT e.to_node_id AS node_id FROM nodes nt CROSS JOIN edges e ON e.to_node_id = nt.id WHERE nt.repository_branch_id = ?
         ) GROUP BY node_id
       )
       SELECT n.id, n.name, n.node_type, f.path, dg.d AS degree
       FROM deg dg
       JOIN nodes n ON n.id = dg.node_id
       JOIN files f ON f.id = n.file_id
       WHERE n.repository_branch_id = ? AND ${LIVE} AND n.node_type IN (${typeList})
       ORDER BY degree DESC LIMIT ?`,
    )
    .all(branchId, branchId, branchId, limit) as Array<{
    id: number;
    name: string;
    node_type: string;
    path: string;
    degree: number;
  }>;

  const nodes: GraphNode[] = rows.map((r) => ({
    id: r.id,
    label: nodeLabel(r.name, r.node_type),
    file: r.path,
    kind: r.node_type,
    cluster: clusterOf(r.path),
    degree: r.degree,
  }));
  const drawn = new Set(nodes.map((n) => n.id));

  // Every edge whose BOTH endpoints are nodes of this branch (driven from nodes so the
  // from_node index is used), then keep only those among the drawn set.
  const branchEdges =
    nodes.length === 0
      ? []
      : (database
          .prepare(
            `SELECT e.from_node_id AS a, e.to_node_id AS b, e.edge_type AS t
             FROM nodes nf
             CROSS JOIN edges e ON e.from_node_id = nf.id
             CROSS JOIN nodes nt ON nt.id = e.to_node_id
             WHERE nf.repository_branch_id = ? AND nt.repository_branch_id = ?
               AND nf.approval_status <> 'ARCHIVED' AND nt.approval_status <> 'ARCHIVED'
               AND e.from_node_id <> e.to_node_id`,
          )
          .all(branchId, branchId) as Array<{ a: number; b: number; t: string }>);
  const edges: GraphEdge[] = [];
  for (const e of branchEdges)
    if (drawn.has(e.a) && drawn.has(e.b)) edges.push({ source: e.a, target: e.b, kind: e.t });

  const clusterCounts = new Map<string, number>();
  for (const n of nodes) clusterCounts.set(n.cluster, (clusterCounts.get(n.cluster) ?? 0) + 1);
  const clusters = [...clusterCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const totalNodes = (
    database
      .prepare(`SELECT COUNT(*) AS c FROM nodes n WHERE n.repository_branch_id = ? AND ${LIVE}`)
      .get(branchId) as { c: number }
  ).c;

  const snapshot: GraphSnapshot = {
    repo,
    branch,
    nodes,
    edges,
    clusters,
    stats: {
      totalNodes,
      totalEdges: branchEdges.length,
      shownNodes: nodes.length,
      shownEdges: edges.length,
    },
  };
  cache.set(cacheKey, { at: Date.now(), snapshot });
  return snapshot;
}

// The repo report (repoReport.ts) reads the same store with the same rules as the chip and the explorer: one connection,
// the same repo resolver, the same "an index that died part-way is no graph" verdict, the same busy-on-maintenance guard.
export { open as openGraphStore, safeRead as reportSafeRead, resolveRepoForCwd, indexDiedPartWay };

/** The `.gitignore` written when Kora turns a plain folder into a repo and none exists: the usual heavy, generated dirs. */
const DEFAULT_GITIGNORE = [
  "node_modules/",
  ".DS_Store",
  ".venv/",
  "venv/",
  "__pycache__/",
  "dist/",
  "build/",
  ".next/",
  "target/",
  ".kora/",
  "",
].join("\n");

function gitAsync(
  cwd: string,
  args: ReadonlyArray<string>,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...GIT_SAFE, "-C", cwd, ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: gitEnv() },
      (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout ?? ""}${stderr ?? ""}`.trim() }),
    );
  });
}

/**
 * Turn a plain folder into a git repo with a first commit (Swarm's "Set up git here"): `git init`, a default
 * `.gitignore` when none exists, `git add -A`, commit. Refuses a home dir / filesystem root / shallow path (the same
 * rule as indexing); a folder that is already a repo is left as it is. Async — never blocks the daemon's event loop.
 */
export async function initGitRepo(
  cwd: string,
): Promise<{ ok: true; created: boolean } | { ok: false; reason: string }> {
  const root = path.resolve(cwd);
  try {
    if (!fs.statSync(root).isDirectory()) return { ok: false, reason: "not a folder" };
  } catch {
    return { ok: false, reason: "folder not found" };
  }
  if ((await gitAsync(root, ["rev-parse", "--is-inside-work-tree"], 5000)).ok)
    return { ok: true, created: false };
  if (!isSafeToIndex(root)) return { ok: false, reason: "unsafe-root" };
  const init = await gitAsync(root, ["init", "-q"]);
  if (!init.ok) return { ok: false, reason: `git init failed: ${init.out}` };
  const ignore = path.join(root, ".gitignore");
  if (!fs.existsSync(ignore)) {
    try {
      fs.writeFileSync(ignore, DEFAULT_GITIGNORE);
    } catch {
      /* commit without it */
    }
  }
  const add = await gitAsync(root, ["add", "-A"]);
  if (!add.ok) return { ok: false, reason: `git add failed: ${add.out}` };
  // No user.name/email configured: commit as Kora rather than fail (the user can amend the author later).
  let commit = await gitAsync(root, ["commit", "-q", "--allow-empty", "-m", "Initial commit"]);
  if (!commit.ok && /user\.(name|email)|identity/i.test(commit.out)) {
    commit = await gitAsync(root, [
      "-c",
      "user.name=Kora",
      "-c",
      "user.email=kora@localhost",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "Initial commit",
    ]);
  }
  if (!commit.ok) return { ok: false, reason: `git commit failed: ${commit.out}` };
  return { ok: true, created: true };
}
