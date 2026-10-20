// The cheap-model chain behind memory extraction, thread summaries and tidy (docs/bots/ARCH.md section 4 + rulings 2):
//   (1) Claude Haiku 5.5 FIRST when Claude is signed in (launch ruling 2026-10-09: the free models timed out and answered
//       badly, and chat text then went to a third party; Anthropic already sees the chat). <= 150 calls a day, own breaker;
//   (2) a free OpenCode model, gated on the swarm consent (chat text goes to a third-party endpoint). Each model has a
//       circuit breaker: a rate limit rests it >= 15 min (doubling per repeat), a timeout >= 5 min, any other failure
//       >= 1 min - a resting model is never asked, so a dead chain costs nothing instead of one spawn per retry.
//       Without a Claude login the order is free first, then Claude only if the user switched "Use Claude for memory
//       when no free model" on (it always was); always reachable inside the host timeout (extract-budget.ts);
//   (3) nothing: the caller queues the turn and tries again when an extractor appears.
// One call at a time (the free tier is shared with swarm workers). NEVER throws - a missing model is `null`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killTreeWindows, winCommand } from '../util/win-exec';
import type { OneShot } from './types';
import { CLAUDE_ATTEMPT_MS, FREE_ATTEMPTS, FREE_ATTEMPT_MS } from './extract-budget';

export interface OneShotDeps {
  /** The swarm consent the user gave (free models receive chat text). */
  consent(): boolean;
  opencodePath(): string | null;
  /** The next free model + the env its provider needs; `exclude` = ids already tried / cooling / circuit-open. */
  pickFree(exclude: string[]): { id: string; env: Record<string, string> } | null;
  runOpencode(i: { opencode: string; model: string; cwd: string; prompt: string; env: Record<string, string>; budgetMs: number }): Promise<{ text: string; failed: boolean; rateLimited: boolean; error: string | null }>;
  markCooling(model: string): void;
  /** The provider says this model does not exist (any more) / is deprecated: take it off the catalog's rotation for a day. */
  markGone?(model: string): void;
  /** Settings toggle "Use Claude for memory when no free model". */
  claudeFallback(): boolean;
  /** Claude is signed in: Haiku answers first, free models are the fallback. Absent = not signed in. */
  claudeReady?(): boolean;
  runClaude(prompt: string, budgetMs: number): Promise<{ text: string; failed: boolean }>;
  /** A latency-bound call (group routing) on an already-running Haiku session; absent = `runClaude`. */
  prewarmClaude?(): void;
  runClaudeWarm?(prompt: string, budgetMs: number): Promise<{ text: string; failed: boolean }>;
  now?(): number;
  /** Where the daily Claude counter lives (a small json); absent = in memory. The breaker state is kept beside it. */
  counterFile?: string;
  /** An empty scratch dir for the one-shot's cwd. */
  scratchDir?(): string;
  log?(msg: string): void;
}

export const CLAUDE_DAILY_CAP = 150;
/** The background model: Claude Haiku 5.5 (full id; the `haiku` alias still means 4.5 on the installed CLI). */
export const CLAUDE_MODEL_ID = 'claude-haiku-5-5';

function dayKey(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

class DailyCounter {
  private mem = { day: '', n: 0 };
  constructor(private file: string | undefined, private now: () => number) {}
  private read(): { day: string; n: number } {
    if (!this.file) return this.mem;
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (typeof j.day === 'string' && Number.isFinite(j.n)) return j; } catch { /* fresh */ }
    return { day: '', n: 0 };
  }
  used(): number { const r = this.read(); return r.day === dayKey(this.now()) ? r.n : 0; }
  bump(): void {
    const day = dayKey(this.now());
    const v = { day, n: this.used() + 1 };
    if (!this.file) { this.mem = v; return; }
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(v)); } catch { /* advisory */ }
  }
}

// ---- circuit breakers ---------------------------------------------------------------------------------------------
export type BreakerKind = 'rate-limit' | 'timeout' | 'error' | 'gone';
/** Floor + cap per failure kind, in ms. A rate limit matches the swarm's Zen cooldown (15 min); the wait doubles per repeat. */
const BACKOFF: Record<BreakerKind, { base: number; cap: number }> = {
  'rate-limit': { base: 15 * 60_000, cap: 60 * 60_000 },
  timeout: { base: 5 * 60_000, cap: 30 * 60_000 },
  error: { base: 60_000, cap: 15 * 60_000 },
  /** The model is retired / deprecated / unknown to its provider: ask again tomorrow, not in a minute. */
  gone: { base: 6 * 3_600_000, cap: 24 * 3_600_000 },
};

/** Free models that never answered a single live call (QA #2): never asked, whatever the catalog says. */
export const NEVER_EXTRACT_WITH: readonly string[] = ['opencode/exo-free'];
const GONE_RE = /model[^.\n]{0,60}(not found|does not exist|not available|deprecated|unsupported|retired|no longer)|ProviderModelNotFound|unknown model|invalid model|model_not_found|has been (deprecated|removed|retired)/i;
export interface BreakerInfo { model: string; until: number; kind: BreakerKind; fails: number }

class Breakers {
  private m = new Map<string, BreakerInfo>();
  constructor(private now: () => number, private file: string | undefined) {
    if (!file) return;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as BreakerInfo[];
      for (const b of j) if (b && typeof b.model === 'string' && b.until > this.now() && BACKOFF[b.kind]) this.m.set(b.model, b);
    } catch { /* fresh */ }
  }
  isOpen(model: string): boolean { const b = this.m.get(model); return !!b && b.until > this.now(); }
  open(model: string, kind: BreakerKind): BreakerInfo {
    const prev = this.m.get(model);
    const fails = (prev?.fails ?? 0) + 1;
    const { base, cap } = BACKOFF[kind];
    const b: BreakerInfo = { model, kind, fails, until: this.now() + Math.min(cap, base * 2 ** (fails - 1)) };
    this.m.set(model, b); this.save();
    return b;
  }
  ok(model: string): void { if (this.m.delete(model)) this.save(); }
  openIds(): string[] { return [...this.m.values()].filter((b) => b.until > this.now()).map((b) => b.model); }
  list(): BreakerInfo[] { return [...this.m.values()].filter((b) => b.until > this.now()); }
  private save(): void {
    if (!this.file) return;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify([...this.m.values()])); } catch { /* advisory */ }
  }
}

export interface OneShotStatus {
  /** The model that answered the most recent successful call (what the Memory tab should name), or null. */
  lastModel: string | null;
  lastAt: number | null;
  /** Models currently sitting out after a failure, with when they come back. */
  breakers: BreakerInfo[];
  /** Earliest time a call could reach a model again, or null when one could be reached right now. */
  retryAt: number | null;
  claudeCallsToday: number;
}
export type ChainOneShot = OneShot & { claudeCallsToday(): number; status(): OneShotStatus; prewarm(): void };

export function makeOneShot(deps: OneShotDeps): ChainOneShot {
  const now = deps.now ?? Date.now;
  const counter = new DailyCounter(deps.counterFile, now);
  const breakers = new Breakers(now, deps.counterFile ? path.join(path.dirname(deps.counterFile), 'extractor-breakers.json') : undefined);
  let tail: Promise<unknown> = Promise.resolve();
  const log = deps.log ?? (() => {});
  let last: { model: string; at: number } | null = null;

  const claudeFirst = () => deps.claudeReady?.() === true;
  const claudeCapOk = () => counter.used() < CLAUDE_DAILY_CAP && !breakers.isOpen(CLAUDE_MODEL_ID);
  /** Latency-bound routing (fast): Haiku answers first whenever Claude is signed in. */
  const routingUsable = () => claudeFirst() && claudeCapOk();
  /** Memory work (ingest, summaries, tidy): Claude only when the user allowed it (Settings > Blobs "Use Claude for memory"). Never otherwise. */
  const memoryUsable = () => deps.claudeFallback() && claudeCapOk();
  const freeUsable = () => !!(deps.consent() && deps.opencodePath());

  async function tryClaude(prompt: string, claudeBudget: number, fast = false): Promise<{ text: string; model: string } | null> {
    counter.bump();
    const t0 = now();
    const runner = fast && deps.runClaudeWarm ? deps.runClaudeWarm : deps.runClaude;
    const r = await runner(prompt, claudeBudget).catch(() => ({ text: '', failed: true }));
    if (r.text && !r.failed) { breakers.ok(CLAUDE_MODEL_ID); last = { model: CLAUDE_MODEL_ID, at: now() }; return { text: r.text.trim(), model: CLAUDE_MODEL_ID }; }
    // A routing call that merely ran out of its short budget (the warm session was still starting) says nothing about Haiku.
    if (fast && now() - t0 >= claudeBudget - 500) { log(`blobs: fast one-shot on ${CLAUDE_MODEL_ID} ran out of time`); return null; }
    const kind: BreakerKind = now() - t0 >= claudeBudget - 500 ? 'timeout' : 'error';
    const b = breakers.open(CLAUDE_MODEL_ID, kind);
    log(`blobs: one-shot on ${CLAUDE_MODEL_ID} ${kind}; resting until ${new Date(b.until).toISOString()}`);
    return null;
  }

  async function tryFree(prompt: string, freeBudget: number): Promise<{ text: string; model: string } | null> {
    const opencode = deps.opencodePath()!;
    const tried = [...breakers.openIds(), ...NEVER_EXTRACT_WITH]; // a model sitting out is never asked
    let attempts = 0;
    while (attempts < FREE_ATTEMPTS) {
      const m = deps.pickFree(tried);
      if (!m) break;
      tried.push(m.id);
      if (breakers.isOpen(m.id)) continue; // pickFree ignored `exclude`: still do not ask
      attempts++;
      const cwd = deps.scratchDir ? deps.scratchDir() : fs.mkdtempSync(path.join(os.tmpdir(), 'kora-oneshot-'));
      const t0 = now();
      const r = await deps.runOpencode({ opencode, model: m.id, cwd, prompt, env: m.env, budgetMs: freeBudget }).catch((e: any) => ({ text: '', failed: true, rateLimited: false, error: String(e?.message ?? e) }))
        // The folder was made for this one call (a caller's scratchDir is its own to manage): it leaked one per call.
        .finally(() => { if (!deps.scratchDir) { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* tmp */ } } });
      if (r.text && !r.failed) { breakers.ok(m.id); last = { model: m.id, at: now() }; return { text: r.text, model: m.id }; }
      if (r.rateLimited) {
        try { deps.markCooling(m.id); } catch { /* advisory */ }
        const b = breakers.open(m.id, 'rate-limit');
        log(`blobs: one-shot on ${m.id} rate-limited; resting until ${new Date(b.until).toISOString()}`);
        continue;
      }
      const dead = !!r.error && GONE_RE.test(r.error);
      const kind: BreakerKind = dead ? 'gone' : now() - t0 >= freeBudget - 500 ? 'timeout' : 'error';
      if (dead) { try { deps.markGone?.(m.id); } catch { /* advisory */ } }
      const b = breakers.open(m.id, kind);
      log(`blobs: one-shot on ${m.id} ${kind}${r.error ? `: ${r.error}` : ''}; resting until ${new Date(b.until).toISOString()}`);
    }
    return null;
  }

  async function run(prompt: string, o: { budgetMs?: number; fast?: boolean } = {}): Promise<{ text: string; model: string } | null> {
    const freeBudget = o.budgetMs ?? FREE_ATTEMPT_MS;
    const claudeBudget = o.budgetMs ?? CLAUDE_ATTEMPT_MS;
    try {
      if (o.fast && routingUsable()) { const r = await tryClaude(prompt, claudeBudget, true); if (r) return r; return null; /* no time left for a free model */ }
      if (freeUsable()) { const r = await tryFree(prompt, freeBudget); if (r) return r; }
      if (memoryUsable()) { const r = await tryClaude(prompt, claudeBudget); if (r) return r; }
    } catch (e: any) { log(`blobs: one-shot error: ${e?.message ?? e}`); }
    return null;
  }

  const oneShot = ((prompt: string, o?: { budgetMs?: number; json?: boolean; fast?: boolean }) => {
    if (o?.fast) return run(prompt, o); // routing must not wait behind a slow extraction
    // concurrency 1: chain behind whatever is running
    const p = tail.then(() => run(prompt, o ?? {}), () => run(prompt, o ?? {}));
    tail = p.catch(() => {});
    return p;
  }) as ChainOneShot;
  oneShot.claudeCallsToday = () => counter.used();
  oneShot.prewarm = () => { try { if (routingUsable()) deps.prewarmClaude?.(); } catch { /* advisory */ } };
  oneShot.status = () => {
    const list = breakers.list();
    // could a call reach a model right now? (a free model not sitting out, or Claude usable)
    let reachable = memoryUsable();
    if (!reachable && freeUsable()) { try { reachable = !!deps.pickFree(breakers.openIds()); } catch { reachable = false; } }
    const relevant = list.filter((b) => (b.model === CLAUDE_MODEL_ID ? claudeFirst() || deps.claudeFallback() : freeUsable()));
    return {
      lastModel: last?.model ?? null,
      lastAt: last?.at ?? null,
      breakers: list,
      retryAt: reachable || relevant.length === 0 ? null : Math.min(...relevant.map((b) => b.until)),
      claudeCallsToday: counter.used(),
    };
  };
  return oneShot;
}

const RATE_LIMITED_RE = /429|rate.?limit|too many requests|Free limit reached|Free usage exceeded|FreeUsageLimitError|resource.?exhausted|endpoint is unavailable|overloaded/i;

/**
 * One `opencode run` one-shot for a free model: the shape of swarm-foreman's runOpencodeOneShot (read-only permissions,
 * project config off, `--format json`, caller-chosen empty cwd) with the two things that made EVERY memory extraction
 * hang (found live 2026-10-09):
 *   - stdin is `ignore`d. `opencode run` reads piped stdin when it is not a TTY, and execFile's default open pipe never
 *     ends - the process sat there until the budget killed it, with no output, on every call;
 *   - a rate limit seen in the stream kills the process at once instead of waiting out the budget.
 * Never throws.
 */
export function runOpencodeFast(input: { opencode: string; model: string; cwd: string; prompt: string; env: Record<string, string>; budgetMs: number }): Promise<{ text: string; failed: boolean; rateLimited: boolean; error: string | null }> {
  return new Promise((resolve) => {
    let out = ''; let err = ''; let done = false; let early = false;
    const permission = { '*': 'ask', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' };
    let child: ReturnType<typeof spawn>;
    try {
      const env = { ...process.env, ...input.env, OPENCODE_PERMISSION: JSON.stringify(permission), OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', PWD: input.cwd }; // opencode run works in $PWD
      const w = winCommand(input.opencode, ['run', '--pure', '--format', 'json', '-m', input.model, `Task:\n${input.prompt}`], env);
      child = spawn(w.command, w.args, { cwd: input.cwd, stdio: ['ignore', 'pipe', 'pipe'], env, windowsVerbatimArguments: w.windowsVerbatimArguments, windowsHide: true });
    } catch (e: any) { resolve({ text: '', failed: true, rateLimited: false, error: String(e?.message ?? e).slice(0, 200) }); return; }
    const finish = (timedOut: boolean) => {
      if (done) return; done = true; clearTimeout(timer);
      try { if (process.platform === 'win32' && child.pid) killTreeWindows(child.pid); else child.kill('SIGKILL'); } catch { /* gone */ }
      let parsed = { text: '', error: null as string | null, rateLimited: false };
      try { parsed = (require('../session/drivers/opencode-parse') as typeof import('../session/drivers/opencode-parse')).opencodeOutputText(out); } catch { /* unparsable */ }
      const rateLimited = early || parsed.rateLimited || (!parsed.text && RATE_LIMITED_RE.test(`${out}\n${err}`));
      const text = rateLimited ? '' : parsed.text;
      resolve({ text, failed: !text, rateLimited, error: rateLimited ? 'rate limited' : parsed.error ?? (timedOut ? 'timed out' : text ? null : (err.trim().split('\n').pop() ?? 'no answer').slice(0, 200)) });
    };
    const timer = setTimeout(() => finish(true), input.budgetMs);
    timer.unref();
    const watch = (chunk: string, isErr: boolean) => {
      if (isErr) err = (err + chunk).slice(-4000); else out += chunk;
      // an error event (or stderr line) that says rate limit: no need to wait for the budget
      if (!early && ((isErr && RATE_LIMITED_RE.test(chunk)) || (!isErr && /"type":"error"/.test(chunk) && RATE_LIMITED_RE.test(chunk)))) { early = true; finish(false); }
    };
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => watch(c, false));
    child.stderr?.on('data', (c: string) => watch(c, true));
    child.on('error', (e) => { err += String(e?.message ?? e); finish(false); });
    child.on('close', () => finish(false));
  });
}

/** `claude -p --model claude-haiku-5-5` in an empty temp dir; prompt on stdin. Never throws. */
export function runClaudeHaiku(claudeBin: string, prompt: string, budgetMs: number, env: NodeJS.ProcessEnv = process.env): Promise<{ text: string; failed: boolean }> {
  return new Promise((resolve) => {
    let dir: string;
    try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-haiku-')); } catch { resolve({ text: '', failed: true }); return; }
    // The SDK/daemon markers must not leak in (a "child session" stops saving its transcript - claude-driver.sessionBaseEnv).
    const clean: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined && !/^(CLAUDE_CODE_|CLAUDECODE)/.test(k)) clean[k] = v;
    let out = ''; let done = false;
    const finish = (r: { text: string; failed: boolean }) => { if (done) return; done = true; try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } resolve(r); };
    let child;
    try {
      // no tools, no claude.ai connectors, no auto-memory: measured 34k -> 5.7k tokens per call, $0.085 -> $0.004 (burn.md patch A)
      clean.ENABLE_CLAUDEAI_MCP_SERVERS = 'false'; clean.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      const w = winCommand(claudeBin, ['-p', '--model', CLAUDE_MODEL_ID, '--no-session-persistence', '--disable-slash-commands', '--tools', '', '--output-format', 'text'], clean);
      child = spawn(w.command, w.args, { cwd: dir, env: clean, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, windowsVerbatimArguments: w.windowsVerbatimArguments });
    } catch { finish({ text: '', failed: true }); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ text: out, failed: true }); }, budgetMs);
    timer.unref();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => { out += c; });
    child.on('error', () => { clearTimeout(timer); finish({ text: '', failed: true }); });
    child.on('close', (code) => { clearTimeout(timer); finish({ text: out, failed: code !== 0 }); });
    try { child.stdin?.end(prompt); } catch { /* closed */ }
  });
}

/**
 * KORA_BLOBS_EXTRACTOR=stub (QA / e2e only): deterministic replies in the memory module's JSON shapes, no model.
 * "remember <x>" / "my name is <x>" become a `you` fact; a conversation becomes a one-line summary; anything else {}.
 */
export function stubExtractor(prompt: string): string {
  // A group chat's responder picker (groups/router.ts pickPrompt): the QA stack picks the member named in "[pick:Name]", else "none"
  // (so the lead answers), which makes the auto rule deterministic without a model.
  if (prompt.startsWith('You route messages in a group chat')) {
    const newest = /Newest message:\n([\s\S]*)$/.exec(prompt)?.[1] ?? '';
    const name = /\[pick:([^\]]+)\]/.exec(newest)?.[1]?.trim();
    return JSON.stringify({ pick: name ?? 'none' });
  }
  const user = /USER said:\n([\s\S]*?)\n\nASSISTANT/.exec(prompt)?.[1] ?? '';
  if (user) {
    const m = /remember(?: that)?\s+(.{4,160}?)[.!]?$/im.exec(user) ?? /\b(my [a-z ]{2,30} (?:is|are) .{2,80}?)[.!]?$/im.exec(user) ?? /\bI (live in|work at|work for|moved to) (.{2,60}?)[.!]?$/im.exec(user);
    if (!m) return JSON.stringify({ ops: [] });
    // an explicit subject, the way the real extractor is told to write ("You live in Dallas.", "Your favorite color is teal.")
    const text = m[2] ? `You ${m[1].toLowerCase()} ${m[2]}` : m[1].replace(/^my\b/i, 'Your').replace(/^I\b/, 'You');
    return JSON.stringify({ ops: [{ op: 'add', scope: 'you', text: text.charAt(0).toUpperCase() + text.slice(1) + '.', confidence: 0.9, explicit: true }] });
  }
  if (/Conversation:\n/.test(prompt)) return JSON.stringify({ summary: 'A short conversation between the user and a blob (stub summary for tests).' });
  return '{}';
}

/**
 * "Is Claude signed in?" for the background chain, answered without waiting: the last `claude auth status --json` result
 * (refreshed in the background at most every `ttlMs`). An API key counts. Unknown until the first probe lands = not ready.
 */
export function makeClaudeSignedIn(run: () => Promise<boolean>, ttlMs = 10 * 60_000, now: () => number = Date.now): () => boolean {
  let ready = false; let at = -Infinity; let inflight = false;
  const refresh = () => {
    if (inflight) return;
    inflight = true; at = now();
    run().then((v) => { ready = v; }, () => { /* keep the last answer */ }).finally(() => { inflight = false; });
  };
  return () => { if (now() - at >= ttlMs) refresh(); return ready; };
}

/**
 * A long-lived `claude -p` stream-json session on Haiku 5.5 for latency-bound one-shots (group routing). A cold `claude -p`
 * costs 6 s of start-up; a running session answers the next prompt without it. It has no tools, runs in an empty
 * scratch dir, and is closed after `idleMs` without use and after `maxPrompts` (its history is not needed and would only
 * grow). The first ask after a close starts it and, if it is not ready within the caller's budget, fails (the caller falls
 * back); the process keeps starting, so the next ask is fast. Never throws.
 */
export function makeWarmClaude(claudeBin: string, o: { model?: string; idleMs?: number; maxPrompts?: number; env?: NodeJS.ProcessEnv } = {}): { ask(prompt: string, budgetMs: number): Promise<{ text: string; failed: boolean }>; close(): void; warm(): void } {
  const model = o.model ?? CLAUDE_MODEL_ID;
  const idleMs = o.idleMs ?? 5 * 60_000;
  const maxPrompts = o.maxPrompts ?? 30;
  let child: ReturnType<typeof spawn> | null = null;
  let dir: string | null = null;
  let buf = '';
  let used = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let waiter: { resolve: (r: { text: string; failed: boolean }) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const settle = (r: { text: string; failed: boolean }) => { if (!waiter) return; const w = waiter; waiter = null; clearTimeout(w.timer); w.resolve(r); };
  const close = () => {
    if (idle) { clearTimeout(idle); idle = null; }
    const c = child; child = null; buf = ''; used = 0;
    if (c) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } dir = null; }
    settle({ text: '', failed: true });
  };
  const start = (): ReturnType<typeof spawn> | null => {
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-haiku-warm-'));
      const clean: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(o.env ?? process.env)) if (v !== undefined && !/^(CLAUDE_CODE_|CLAUDECODE)/.test(k)) clean[k] = v;
      clean.ENABLE_CLAUDEAI_MCP_SERVERS = 'false'; clean.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      const w = winCommand(claudeBin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model, '--no-session-persistence', '--disable-slash-commands', '--tools', ''], clean);
      const c = spawn(w.command, w.args, { cwd: dir, env: clean, stdio: ['pipe', 'pipe', 'ignore'], windowsVerbatimArguments: w.windowsVerbatimArguments, windowsHide: true });
      c.stdout?.setEncoding('utf8');
      c.stdout?.on('data', (d: string) => {
        buf += d;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          try { const j = JSON.parse(line); if (j?.type === 'result') settle({ text: typeof j.result === 'string' ? j.result : '', failed: j.is_error === true || typeof j.result !== 'string' }); } catch { /* not a json line */ }
        }
      });
      c.on('error', () => { if (child === c) close(); });
      c.on('close', () => { if (child === c) close(); });
      return c;
    } catch { close(); return null; }
  };

  const ask = (prompt: string, budgetMs: number): Promise<{ text: string; failed: boolean }> => {
    const run = () => new Promise<{ text: string; failed: boolean }>((resolve) => {
      if (used >= maxPrompts) close();
      if (!child) child = start();
      const c = child;
      if (!c) { resolve({ text: '', failed: true }); return; }
      if (idle) clearTimeout(idle);
      idle = setTimeout(close, idleMs); idle.unref?.();
      used++;
      // out of time: give up on this prompt only; its late answer would be read as the NEXT prompt's, so the session restarts
      const timer = setTimeout(() => { settle({ text: '', failed: true }); close(); child = start(); }, budgetMs);
      timer.unref?.();
      waiter = { resolve, timer };
      try { c.stdin?.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n'); } catch { settle({ text: '', failed: true }); }
    });
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  };
  /** Start the session and push one tiny prompt through it so the first real ask finds it ready. Cheap, once: a no-op while it runs. */
  const warm = (): void => { if (child) return; void ask('Reply with the single word: ready', 30_000); };
  return { ask, close, warm };
}
