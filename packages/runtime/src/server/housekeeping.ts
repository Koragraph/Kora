// Disk housekeeping for a daemon that runs for weeks. Everything Kora appends to gets a cap, every cache and scratch
// area gets an age limit. Policy, per file:
//   server.log, ingest.log, rotate by COPY-THEN-TRUNCATE (<file>.1, .2 …): the daemon's own log stream and every
//   app-launch.log,         detached child (the daemon's stdio, `kora ingest` in the background, kora-runtime.sh run
//   <graph home>/catch-up.log  by the app, the engine's catch-up children) hold the file open with O_APPEND, so a
//                           truncate is safe for them while a rename would strand their writes in .1
//   inject.jsonl,           COMPACT to the newest lines: readers (`kora savings`, the canary, `kora swarm usage`,
//   swarm/outcomes.jsonl    routing) look at recent history, and a half-kept file keeps them working
//   brief-cache, merge-check scratch, pane resume briefs, per-session tmp markers   age out
//   graph.db-wal            the engine checkpoints after every ingest; a WAL still over a cap here (a checkpoint that
//                           lost to a busy reader) gets one PASSIVE checkpoint in a short child process — never on
//                           the daemon's loop, never blocking a writer, no long-lived connection kept open
// The user's chat threads are never touched. Nothing here is on a hot path: it runs at start and hourly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { koraHome } from '../protocol/types';
import { graphStoreDir } from './disk';
import { log } from './log';
import { sweepForks } from '../session/prune';
import { GIT_NO_FSMONITOR, gitEnv } from '../util/safe-path';
import { minimalEnv } from '../util/win-exec';

const MB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface HousekeepingReport {
  rotated: { file: string; bytes: number }[];
  compacted: { file: string; before: number; after: number }[];
  pruned: { what: string; count: number; bytes: number }[];
  /** the graph store whose oversized WAL got a PASSIVE checkpoint started (in a child) */
  checkpointed?: string;
  /** bytes no longer on disk after this run (rotated-away generations, compacted and pruned bytes) */
  reclaimed: number;
}

/**
 * Copy-then-truncate rotation. `<file>` → `<file>.1` → … → `<file>.<keep>` (the oldest generation is dropped). Returns
 * the bytes of the generation that fell off the end (0 when nothing was rotated). `keep` ≥ 1.
 */
export function rotateLog(file: string, maxBytes: number, keep: number): { rotated: boolean; dropped: number } {
  let size = 0; try { size = fs.statSync(file).size; } catch { return { rotated: false, dropped: 0 }; }
  if (size <= maxBytes) return { rotated: false, dropped: 0 };
  let dropped = 0;
  const gen = (n: number) => `${file}.${n}`;
  try { dropped = fs.statSync(gen(keep)).size; fs.rmSync(gen(keep), { force: true }); } catch { /* none */ }
  for (let n = keep - 1; n >= 1; n--) { try { fs.renameSync(gen(n), gen(n + 1)); } catch { /* none */ } }
  fs.copyFileSync(file, gen(1));
  // Writers use O_APPEND: after the truncate their next write lands at the new end (offset 0), never a hole.
  fs.truncateSync(file, 0);
  return { rotated: true, dropped };
}

/**
 * Keep only the newest ~`keepBytes` of a JSON-lines file once it is over `maxBytes` (whole lines, oldest dropped).
 * Written to a temp file and renamed over, so a reader never sees a torn file. Returns sizes, or null when under cap.
 */
export function compactJsonl(file: string, maxBytes: number, keepBytes: number): { before: number; after: number } | null {
  let size = 0; try { size = fs.statSync(file).size; } catch { return null; }
  if (size <= maxBytes) return null;
  const fd = fs.openSync(file, 'r');
  let tail: Buffer;
  try {
    const n = Math.min(size, keepBytes);
    tail = Buffer.alloc(n);
    fs.readSync(fd, tail, 0, n, size - n);
  } finally { fs.closeSync(fd); }
  // Drop the partial first line (unless the cut happened to land exactly on a line start).
  const nl = tail.indexOf(0x0a);
  const kept = size > keepBytes && nl >= 0 ? tail.subarray(nl + 1) : tail;
  const tmp = `${file}.${process.pid}.compact`;
  fs.writeFileSync(tmp, kept);
  fs.renameSync(tmp, file);
  return { before: size, after: kept.length };
}

/** Remove entries of `dir` (files, or whole directories) whose mtime is older than `maxAgeMs` and that pass `match`. */
export function pruneOld(dir: string, maxAgeMs: number, opts: { match?: (name: string) => boolean; now?: number } = {}): { count: number; bytes: number } {
  const now = opts.now ?? Date.now();
  let names: string[] = []; try { names = fs.readdirSync(dir); } catch { return { count: 0, bytes: 0 }; }
  let count = 0, bytes = 0;
  for (const name of names) {
    if (opts.match && !opts.match(name)) continue;
    const p = path.join(dir, name);
    let st: fs.Stats; try { st = fs.lstatSync(p); } catch { continue; }
    if (now - st.mtimeMs < maxAgeMs) continue;
    const size = st.isDirectory() ? duSync(p) : st.size;
    try { fs.rmSync(p, { recursive: true, force: true }); count++; bytes += size; } catch { /* busy */ }
  }
  return { count, bytes };
}

/** Apparent size of a tree (files only, symlinks not followed). Bounded: stops counting after 200k entries. */
export function duSync(p: string, budget = { left: 200_000 }): number {
  let st: fs.Stats; try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let names: string[] = []; try { names = fs.readdirSync(p); } catch { return 0; }
  for (const n of names) { if (--budget.left < 0) break; total += duSync(path.join(p, n), budget); }
  return total;
}

/**
 * Scratch folders the daemon itself makes in $TMPDIR and removes when it is done; one older than the age limit belongs
 * to a call that was killed. Only these exact prefixes (never the broader `kora-` space: other Kora homes, QA stacks and
 * test runs also live there), and never `kora-haiku-warm-`: a warm Haiku session keeps its folder for as long as it lives.
 */
export const OWN_TEMP_PREFIXES = ['kora-oneshot-', 'kora-haiku-', 'kora-acp-models-', 'kora-union-', 'kora-browser-doctor-'] as const;
export function isOwnStaleTempDir(name: string): boolean {
  return !name.startsWith('kora-haiku-warm-') && OWN_TEMP_PREFIXES.some((p) => name.startsWith(p));
}

export interface HousekeepingLimits {
  serverLogBytes: number; serverLogKeep: number;
  ingestLogBytes: number; ingestLogKeep: number;
  smallLogBytes: number; smallLogKeep: number;
  walBytes: number;
  injectBytes: number; injectKeepBytes: number;
  outcomesBytes: number; outcomesKeepBytes: number;
  briefCacheAgeMs: number; mergeCheckAgeMs: number; paneBriefAgeMs: number; tmpMarkerAgeMs: number;
  undoCopyAgeMs: number; toolOutAgeMs: number;
}
export const DEFAULT_LIMITS: HousekeepingLimits = {
  serverLogBytes: 10 * MB, serverLogKeep: 2,          // ≤ 30 MB of daemon log
  ingestLogBytes: 5 * MB, ingestLogKeep: 1,           // ≤ 10 MB
  smallLogBytes: 2 * MB, smallLogKeep: 1,             // app-launch.log, catch-up.log: ≤ 4 MB each
  walBytes: 64 * MB,                                  // a graph WAL this big after the engine's own checkpoints
  injectBytes: 8 * MB, injectKeepBytes: 4 * MB,       // ~20k injection records kept
  // ~500 B a row: 4 MB keeps ~8k finished swarm tasks — months of history for `kora swarm usage` and routing.
  outcomesBytes: 8 * MB, outcomesKeepBytes: 4 * MB,
  briefCacheAgeMs: 7 * DAY,
  // The merge gate's throwaway checkouts live seconds; one older than an hour belongs to a gate that was killed.
  mergeCheckAgeMs: HOUR,
  paneBriefAgeMs: 7 * DAY,
  tmpMarkerAgeMs: 2 * DAY,
  undoCopyAgeMs: 14 * DAY,
  toolOutAgeMs: 7 * DAY,
};

/** One pass. Synchronous but bounded (caps above); safe to call at any time, never throws. */
export function runHousekeeping(opts: { home?: string; graphHome?: string; graphDb?: string; tmp?: string; limits?: Partial<HousekeepingLimits>; now?: number } = {}): HousekeepingReport {
  const home = opts.home ?? koraHome();
  // The engine's home (koragraph src/practice/paths.js): catch-up.log sits there; the store may be elsewhere (KORAGRAPH_DB).
  const graphHome = opts.graphHome ?? (process.env.KORAGRAPH_HOME || path.join(os.homedir(), '.koragraph'));
  const graphDb = opts.graphDb ?? (process.env.KORAGRAPH_DB || path.join(graphStoreDir(), 'graph.db'));
  const tmp = opts.tmp ?? os.tmpdir();
  const L = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const rep: HousekeepingReport = { rotated: [], compacted: [], pruned: [], reclaimed: 0 };
  const step = (fn: () => void) => { try { fn(); } catch (e) { log('housekeeping step failed', e); } };

  for (const [file, max, keep] of [
    [path.join(home, 'server.log'), L.serverLogBytes, L.serverLogKeep],
    [path.join(home, 'ingest.log'), L.ingestLogBytes, L.ingestLogKeep],
    [path.join(home, 'app-launch.log'), L.smallLogBytes, L.smallLogKeep],
    [path.join(graphHome, 'catch-up.log'), L.smallLogBytes, L.smallLogKeep],
  ] as const) {
    step(() => {
      const r = rotateLog(file, max, keep);
      if (r.rotated) { rep.rotated.push({ file, bytes: r.dropped }); rep.reclaimed += r.dropped; }
    });
  }
  for (const [rel, max, keepBytes] of [['inject.jsonl', L.injectBytes, L.injectKeepBytes], [path.join('swarm', 'outcomes.jsonl'), L.outcomesBytes, L.outcomesKeepBytes], [path.join('swarm', 'bounded-reads.jsonl'), L.injectBytes, L.injectKeepBytes]] as const) {
    step(() => {
      const file = path.join(home, rel);
      const r = compactJsonl(file, max, keepBytes);
      if (r) { rep.compacted.push({ file, ...r }); rep.reclaimed += r.before - r.after; }
    });
  }
  const prune = (what: string, dir: string, age: number, match?: (n: string) => boolean) => step(() => {
    const r = pruneOld(dir, age, { ...(match ? { match } : {}), ...(opts.now != null ? { now: opts.now } : {}) });
    if (r.count) { rep.pruned.push({ what, ...r }); rep.reclaimed += r.bytes; }
  });
  prune('brief-cache', path.join(home, 'brief-cache'), L.briefCacheAgeMs);
  prune('pane resume briefs', path.join(home, 'panes'), L.paneBriefAgeMs);
  prune('tmp session markers', tmp, L.tmpMarkerAgeMs, (n) => /^kora-(inject|nudge)-/.test(n));
  // Per-thread files from the token-saving work: a compaction's undo copy (a whole transcript) is only useful for a while; spilled Bash
  // output likewise. A deleted thread's are removed at once (session-manager delete); these catch the rest.
  step(() => sweepForks(home, opts.now));
  prune('compact undo copies', path.join(home, 'compact-undo'), L.undoCopyAgeMs);
  step(() => {
    const root = path.join(home, 'tool-out');
    let threads: string[] = []; try { threads = fs.readdirSync(root); } catch { return; } // never spilled: nothing to do, and not an error
    for (const t of threads) {
      const dir = path.join(root, t);
      const r = pruneOld(dir, L.toolOutAgeMs, opts.now != null ? { now: opts.now } : {});
      if (r.count) { rep.pruned.push({ what: 'spilled Bash output', ...r }); rep.reclaimed += r.bytes; }
      try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* fine */ }
    }
  });
  prune('stale temp folders', tmp, L.tmpMarkerAgeMs, isOwnStaleTempDir);
  // The hooks' markers moved into a private per-user folder (util/safe-path.ts privateTmpDir): that is where they pile up now.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  for (const dir of [path.join(tmp, `kora-${uid}`), path.join(home, 'tmp')]) prune('tmp session markers', dir, L.tmpMarkerAgeMs, (n) => /^kora-(inject|nudge)-/.test(n));
  step(() => {
    const r = pruneMergeCheck(path.join(home, 'merge-check'), L.mergeCheckAgeMs, opts.now);
    if (r.count) { rep.pruned.push({ what: 'merge-gate scratch checkouts', ...r }); rep.reclaimed += r.bytes; }
  });
  step(() => { if (checkpointBigWal(graphDb, L.walBytes)) rep.checkpointed = graphDb; });
  return rep;
}

/**
 * One `wal_checkpoint(PASSIVE)` on `db` when its -wal is over `maxBytes`, in a child process (copying a big WAL back is
 * seconds of I/O; the daemon's loop must not stall). PASSIVE copies what no reader still needs and never waits for or
 * blocks a writer; the child closes its connection at once. Returns whether a checkpoint was started.
 */
export function checkpointBigWal(db: string, maxBytes: number): boolean {
  let size = 0; try { size = fs.statSync(`${db}-wal`).size; } catch { return false; }
  if (size <= maxBytes) return false;
  let driver: string; try { driver = require.resolve('better-sqlite3'); } catch { return false; }
  const code = "const D=require(process.argv[2]);const d=new D(process.argv[1],{timeout:2000,fileMustExist:true});try{d.pragma('wal_checkpoint(PASSIVE)')}finally{d.close()}";
  execFile(process.execPath, ['-e', code, db, driver], { timeout: 120_000, windowsHide: true, env: minimalEnv() }, (err) => {
    if (err) log(`housekeeping: graph WAL checkpoint failed (${String(err.message).split('\n')[0]})`);
  });
  return true;
}

/**
 * The merge gate materializes each branch ref as a throwaway detached worktree under merge-check/<repo>/ and removes
 * it in a `finally` — which never runs when the gate child is killed on its time budget. What is left is a full
 * checkout per killed gate plus a dangling `.git/worktrees` entry in the user's repo. Remove the directory and prune
 * that entry; empty per-repo directories go too. Never user work: these are detached checkouts of existing commits.
 */
export function pruneMergeCheck(base: string, maxAgeMs: number, now = Date.now()): { count: number; bytes: number } {
  let repos: string[] = []; try { repos = fs.readdirSync(base); } catch { return { count: 0, bytes: 0 }; }
  let count = 0, bytes = 0;
  const roots = new Set<string>();
  for (const repo of repos) {
    const rdir = path.join(base, repo);
    let names: string[] = []; try { if (!fs.statSync(rdir).isDirectory()) continue; names = fs.readdirSync(rdir); } catch { continue; }
    for (const name of names) {
      const dir = path.join(rdir, name);
      let st: fs.Stats; try { st = fs.lstatSync(dir); } catch { continue; }
      if (now - st.mtimeMs < maxAgeMs) continue;
      try { const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, '.git'), 'utf8')); if (m) roots.add(path.resolve(m[1].trim(), '..', '..', '..')); } catch { /* not a worktree */ }
      const size = duSync(dir);
      try { fs.rmSync(dir, { recursive: true, force: true }); count++; bytes += size; } catch { /* busy */ }
    }
    try { if (fs.readdirSync(rdir).length === 0) fs.rmdirSync(rdir); } catch { /* fine */ }
  }
  // `git worktree prune` drops the entries whose directory is gone — async: never a git call on the daemon's loop.
  for (const root of roots) if (fs.existsSync(root)) execFile('git', [...GIT_NO_FSMONITOR, '-C', root, 'worktree', 'prune'], { timeout: 30_000, env: gitEnv() }, () => { /* best effort */ });
  return { count, bytes };
}

/** At start (after `delayMs`) and every `intervalMs`: one housekeeping pass, logged when it did anything. */
export function startHousekeeping(intervalMs = HOUR, delayMs = 20_000): () => void {
  const run = () => {
    const r = runHousekeeping();
    if (r.checkpointed) log(`housekeeping: graph WAL over cap, PASSIVE checkpoint started for ${r.checkpointed}`);
    if (r.rotated.length || r.compacted.length || r.pruned.length) {
      log(`housekeeping: reclaimed ${(r.reclaimed / MB).toFixed(1)} MB — ${[
        ...r.rotated.map((x) => `rotated ${path.basename(x.file)}`),
        ...r.compacted.map((x) => `compacted ${path.basename(x.file)} ${(x.before / MB).toFixed(1)}→${(x.after / MB).toFixed(1)} MB`),
        ...r.pruned.map((x) => `${x.count} ${x.what}`),
      ].join(', ')}`);
    }
  };
  const first = setTimeout(run, delayMs); first.unref();
  const t = setInterval(run, intervalMs); t.unref();
  return () => { clearTimeout(first); clearInterval(t); };
}
