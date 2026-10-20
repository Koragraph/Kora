// @effect-diagnostics globalDate:off globalTimers:off -- plain wall-clock budget for a worker thread, outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- plain Node APIs: worker_threads is the whole point of this module.
import { Worker } from "node:worker_threads";

/**
 * `workspace.grep` off the daemon's event loop.
 *
 * The query is a user-typed regex run over up to 20k files. On the main thread a catastrophic pattern
 * (`(a+)+$` against a long line) or a big tree stalls the loop for seconds, which drops every UI websocket
 * and stalls every agent. Here the walk + match run in a `worker_threads` Worker with:
 *  - a hard wall-clock budget (`timeoutMs`): the worker is terminated (V8 interrupts even a running regex) and
 *    whatever matched so far comes back as `truncated: true`;
 *  - a result cap (`limit`) enforced on both sides;
 *  - cancellation: aborting `signal` (the RPC fiber was interrupted, e.g. the user typed again) terminates it;
 *  - a heap cap, and only regular files opened non-blocking (a FIFO or device in the tree can't wedge the thread
 *    in a syscall that `terminate()` cannot interrupt);
 *  - at most `MAX_CONCURRENT` workers; later searches wait (abortably) for a slot.
 *
 * The worker source is a self-contained JS string (eval worker) so it survives bundling into ui-server.cjs.
 * Same matching semantics as the old in-process loop: JS RegExp, `g`/`gi`, `\b…\b` for whole word, literal
 * fallback + `regexFallbackError` on an invalid pattern, ≤100 ranges and ≤2000 chars per line, ≤1 MiB files,
 * NUL-containing files skipped as binary.
 */

export interface GrepOptions {
  readonly cwd: string;
  readonly query: string;
  readonly limit: number;
  readonly useRegex: boolean;
  readonly wholeWord: boolean;
  readonly caseSensitive: boolean;
}

export interface GrepMatch {
  readonly path: string;
  readonly lineNumber: number;
  readonly lineContent: string;
  readonly matchRanges: Array<{ start: number; end: number }>;
}

export interface GrepResult {
  readonly matches: Array<GrepMatch>;
  readonly truncated: boolean;
  readonly regexFallbackError?: string;
  /** The wall-clock budget ran out (the worker was terminated); `matches` is what was found before. */
  readonly timedOut: boolean;
}

export const GREP_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT = 3;
const MAX_WALK_FILES = 20_000;
const MAX_CONTENT_FILE_BYTES = 1024 * 1024;

const WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const o = workerData;
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", ".jj", ".DS_Store"]);
const esc = (s) => s.replace(/[.*+?^${"$"}{}()|[\]\\]/g, "\\$&");
const flags = o.caseSensitive ? "g" : "gi";
let source = o.useRegex ? o.query : esc(o.query);
if (o.wholeWord) source = "\\b(?:" + source + ")\\b";
let regex;
try {
  regex = new RegExp(source, flags);
} catch (err) {
  parentPort.postMessage({ type: "fallback", error: err && err.message ? String(err.message) : String(err) });
  let lit = esc(o.query);
  if (o.wholeWord) lit = "\\b(?:" + lit + ")\\b";
  regex = new RegExp(lit, flags);
}
const files = [];
const stack = [o.cwd];
outer: while (stack.length > 0) {
  const dir = stack.pop();
  let dirents;
  try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
  for (const d of dirents) {
    if (SKIP_DIRS.has(d.name)) continue;
    const abs = path.join(dir, d.name);
    const rel = path.relative(o.cwd, abs).split(path.sep).join("/");
    if (rel === "") continue;
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try { isDir = fs.statSync(abs).isDirectory(); } catch { continue; }
    }
    if (isDir) stack.push(abs);
    else if (d.isFile() || d.isSymbolicLink()) files.push(rel);
    if (files.length >= o.maxFiles) break outer;
  }
}
const nonblock = fs.constants.O_NONBLOCK || 0;
function readText(abs) {
  let fd;
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | nonblock); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > o.maxFileBytes) return null;
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) break;
      read += n;
    }
    const b = buf.subarray(0, read);
    if (b.includes(0)) return null;
    return b.toString("utf8");
  } catch { return null; } finally { try { fs.closeSync(fd); } catch {} }
}
let count = 0;
let truncated = false;
for (const rel of files) {
  if (count >= o.limit) { truncated = true; break; }
  const content = readText(path.join(o.cwd, rel));
  if (content === null) continue;
  const lines = content.split("\n");
  const batch = [];
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln] || "";
    regex.lastIndex = 0;
    const ranges = [];
    let m;
    while ((m = regex.exec(line)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) regex.lastIndex++;
      if (ranges.length >= 100) break;
    }
    if (ranges.length > 0) {
      batch.push({ path: rel, lineNumber: ln + 1, lineContent: line.slice(0, 2000), matchRanges: ranges });
      count++;
      if (count >= o.limit) { truncated = true; break; }
    }
  }
  if (batch.length > 0) parentPort.postMessage({ type: "matches", items: batch });
}
parentPort.postMessage({ type: "done", truncated });
`;

// --- concurrency slots -------------------------------------------------------------------------------------------
let running = 0;
const waiters: Array<() => void> = [];

function acquire(signal: AbortSignal | undefined): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const grant = () => {
      signal?.removeEventListener("abort", onAbort);
      running++;
      resolve();
    };
    const onAbort = () => {
      const i = waiters.indexOf(grant);
      if (i >= 0) waiters.splice(i, 1);
      reject(signal?.reason ?? new Error("aborted"));
    };
    waiters.push(grant);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function release(): void {
  running--;
  const next = waiters.shift();
  if (next) next();
}

/**
 * Run `source` in an eval worker with `workerData`, feeding each message to `onMessage` until it returns a result
 * (`{ done: value }`). Resolves `onTimeout()` at the wall-clock budget, rejects on abort or a worker crash. The worker
 * is always terminated when this settles.
 */
async function runInWorker<R>(
  source: string,
  workerData: unknown,
  run: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined },
  onMessage: (msg: any) => { done: R } | undefined,
  onTimeout: () => R,
): Promise<R> {
  const { signal } = run;
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
  await acquire(signal);
  try {
    return await new Promise<R>((resolve, reject) => {
      let settled = false;
      const worker = new Worker(source, {
        eval: true,
        workerData,
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
        stdout: false,
        stderr: false,
      });
      const finish = (outcome: { ok: R } | { err: unknown }) => {
        if (settled) return;
        clearTimeout(timer);
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        void worker.terminate().catch(() => {});
        if ("ok" in outcome) resolve(outcome.ok);
        else reject(outcome.err);
      };
      const timer = setTimeout(() => finish({ ok: onTimeout() }), run.timeoutMs ?? GREP_TIMEOUT_MS);
      const onAbort = () => finish({ err: signal?.reason ?? new Error("aborted") });
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.on("message", (msg) => {
        const r = onMessage(msg);
        if (r) finish({ ok: r.done });
      });
      worker.on("error", (err) => finish({ err }));
      worker.on("exit", (code) => {
        if (!settled) finish({ err: new Error(`search worker exited (${code})`) });
      });
    });
  } finally {
    release();
  }
}

/** Run one grep in a worker thread. Rejects only on abort or a worker crash; a timeout resolves with what it has. */
export function grepInWorker(
  opts: GrepOptions,
  run: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<GrepResult> {
  const matches: Array<GrepMatch> = [];
  let regexFallbackError: string | undefined;
  const result = (truncated: boolean, timedOut: boolean): GrepResult => ({
    matches: matches.slice(0, opts.limit),
    truncated: truncated || matches.length > opts.limit,
    ...(regexFallbackError !== undefined ? { regexFallbackError } : {}),
    timedOut,
  });
  return runInWorker(
    WORKER_SOURCE,
    { ...opts, maxFiles: MAX_WALK_FILES, maxFileBytes: MAX_CONTENT_FILE_BYTES },
    run,
    (msg: { type: string; items?: Array<GrepMatch>; error?: string; truncated?: boolean }) => {
      if (msg.type === "fallback") regexFallbackError = msg.error;
      else if (msg.type === "matches" && msg.items) {
        for (const m of msg.items) if (matches.length <= opts.limit) matches.push(m);
      } else if (msg.type === "done") return { done: result(msg.truncated === true, false) };
      return undefined;
    },
    () => result(true, true),
  );
}

// --- workspace.find: the same capped walk, off the event loop --------------------------------------------------------

export interface FindOptions {
  readonly cwd: string;
  readonly query: string;
  readonly limit: number;
  readonly kind?: "file" | "directory" | undefined;
  readonly imageOnly?: boolean | undefined;
}
export interface FindResult {
  readonly entries: Array<{ path: string; kind: "file" | "directory"; ignored?: boolean }>;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

const FIND_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const o = workerData;
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", ".jj", ".DS_Store"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif"]);
const includeDirs = o.kind !== "file";
const entries = [];
let truncated = false;
const stack = [o.cwd];
outer: while (stack.length > 0) {
  if (entries.length >= o.maxFiles) { truncated = true; break; }
  const dir = stack.pop();
  let dirents;
  try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
  for (const d of dirents) {
    if (SKIP_DIRS.has(d.name)) continue;
    const abs = path.join(dir, d.name);
    const rel = path.relative(o.cwd, abs).split(path.sep).join("/");
    if (rel === "") continue;
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try { isDir = fs.statSync(abs).isDirectory(); } catch { continue; }
    }
    if (isDir) {
      if (includeDirs) entries.push({ rel, kind: "directory" });
      stack.push(abs);
    } else if (d.isFile() || d.isSymbolicLink()) {
      entries.push({ rel, kind: "file" });
    }
    if (entries.length >= o.maxFiles) { truncated = true; break outer; }
  }
}
const needle = o.query.trim().toLowerCase();
const out = [];
let capped = truncated;
for (const e of entries) {
  if (o.kind && e.kind !== o.kind) continue;
  if (o.imageOnly && !IMAGE_EXT.has(path.extname(e.rel).toLowerCase())) continue;
  if (needle !== "" && !e.rel.toLowerCase().includes(needle)) continue;
  const base = e.rel.split("/").pop() || e.rel;
  const row = { path: e.rel, kind: e.kind };
  if (base.startsWith(".")) row.ignored = true;
  out.push(row);
  if (out.length >= o.limit) { capped = true; break; }
}
parentPort.postMessage({ type: "done", entries: out, truncated: capped });
`;

/** The file/dir picker's walk + filter in a worker (same results as the old in-process `walk`). */
export function findInWorker(
  opts: FindOptions,
  run: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<FindResult> {
  return runInWorker<FindResult>(
    FIND_SOURCE,
    { ...opts, maxFiles: MAX_WALK_FILES },
    run,
    (msg: { type: string; entries?: FindResult["entries"]; truncated?: boolean }) =>
      msg.type === "done"
        ? {
            done: {
              entries: msg.entries ?? [],
              truncated: msg.truncated === true,
              timedOut: false,
            },
          }
        : undefined,
    () => ({ entries: [], truncated: true, timedOut: true }),
  );
}
