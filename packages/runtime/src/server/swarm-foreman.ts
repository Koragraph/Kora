// The swarm FOREMAN: the cheap stage between "a worker finished" and "the Claude leader hears about it". The expensive
// side of Swarm is Claude reviewing and re-dispatching failed cheap work, so nothing reaches the leader unverified:
//
//   worker idle with a report → X2 merge gate (swarm.ts) → optional done-check (a shell command the leader gave
//   kora_spawn, run here in a child process: 90 s budget, 2 at once, never on the event loop) → optional reviewer
//   (a free model reads task + diff, answers VERDICT: PASS|FAIL) → PASS, or an automatic retry in the SAME worktree
//   with a failure digest (a different free model when the failure looks model-related), up to N retries → a short
//   structured escalation.
//
// This file holds the pieces that do not need SwarmService's state: the check runner, the diff, the reviewer call and
// its parsing, the retry digest and the leader-facing text. SwarmService owns the loop (swarm.ts `runForeman`).
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FleetSwarmVerify, SwarmForemanCheck, SwarmForemanFailure, SwarmForemanState, SwarmForemanVerdict } from '../protocol/types';
import { GIT_NO_FSMONITOR, gitEnv } from '../util/safe-path';
import { killTreeWindows, winCommand } from '../util/win-exec';

/** Budget per done-check and per reviewer call (the merge gate's bounded-verify budget). */
export const FOREMAN_BUDGET_MS = 90_000;
/** A baseline-judged check may run the suite twice (flaky re-run) and wait for the baseline: give it room (bench5x B9). */
export const BASELINE_CHECK_BUDGET_MS = 300_000;
/** Done-checks running at once across every task (a test suite per worker ×10 would starve the machine). */
export const FOREMAN_CHECK_CONCURRENCY = 2;
const TAIL_LINES = 20;
const TAIL_CHARS = 1_200;
const OUTPUT_KEEP = 64 * 1024;
/** The diff a reviewer reads (argv-borne, so it is capped well under ARG_MAX). */
const REVIEW_DIFF_CAP = 24_000;
const DIGEST_CAP = 2_000;
const NEW_FILES_CAP = 12_000;

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;

/** The last ≤20 lines / ≤1200 chars of some output, ANSI stripped. */
export function tailOf(text: string, lines = TAIL_LINES, chars = TAIL_CHARS): string {
  const t = text.replace(ANSI_RE, '').replace(/\r\n?/g, '\n').trimEnd();
  const last = t.split('\n').slice(-lines).join('\n');
  return last.length > chars ? `…${last.slice(-chars)}` : last;
}

// ── done-check ────────────────────────────────────────────────────────────────────────────────────────
let checksRunning = 0;
const checkQueue: (() => void)[] = [];
async function checkSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (checksRunning >= FOREMAN_CHECK_CONCURRENCY) await new Promise<void>((r) => checkQueue.push(r));
  checksRunning++;
  try { return await fn(); } finally { checksRunning--; checkQueue.shift()?.(); }
}

/**
 * The environment of a done-check. The daemon is started by the app with launchd's bare PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so
 * `node --test`, `pnpm test`, `cargo test` and the like died with "command not found" and every worker's check failed on a
 * green change (found live 2026-10-14: a Swarm task's worker kept failing over on `node --test`). Widened the way every engine
 * spawn is (detect/engine-binary.ts: Homebrew, nvm, volta, cargo ...).
 */
export function checkEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { engineSpawnEnv } = require('../detect/engine-binary') as typeof import('../detect/engine-binary');
  return { ...engineSpawnEnv(base), CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
}

/**
 * Run `command` with /bin/sh in `cwd`, in its own process group so a timeout kills the whole tree (a `pnpm test`
 * leaves node children behind a bare sh kill). Never throws; never blocks the event loop.
 */
export function runCheck(command: string, cwd: string, budgetMs = FOREMAN_BUDGET_MS, opts: { keepOutput?: boolean } = {}): Promise<SwarmForemanCheck & { output?: string }> {
  return checkSlot(() => new Promise<SwarmForemanCheck & { output?: string }>((resolve) => {
    const t0 = Date.now();
    let out = '';
    let done = false;
    // A baseline run keeps (nearly) everything: a 64 KB tail cut the head of vitest's failure list, and the missing
    // pre-existing failures then read as NEW ones (bench5x B8).
    const cap = opts.keepOutput ? 8 * 1024 * 1024 : OUTPUT_KEEP;
    const keep = (b: Buffer) => { out += b.toString('utf8'); if (out.length > cap) out = out.slice(-cap); };
    const finish = (r: Omit<SwarmForemanCheck, 'durationMs' | 'tail'>, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...r, durationMs: Date.now() - t0, tail: tailOf(extra ? out.trimEnd() + extra : out), ...(opts.keepOutput ? { output: out } : {}) });
    };
    let child: ReturnType<typeof spawn>;
    try {
      // The done-check is a command a lead wrote and nobody approved: it runs under the same credential read-deny as
      // the fenced engines (deep audit 2026-10-13 A1-5), so a check line cannot read ~/.ssh or Kora's control token.
      const fenced = (require('../session/os-sandbox') as typeof import('../session/os-sandbox')).wrapReadDeny('check', '/bin/sh', ['-c', command]);
      child = spawn(fenced.command, fenced.args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: checkEnv(), windowsVerbatimArguments: fenced.windowsVerbatimArguments });
    } catch (e: any) {
      resolve({ state: 'error', exitCode: null, durationMs: 0, tail: `could not start the check: ${e?.message ?? e}` });
      return;
    }
    const timer = setTimeout(() => {
      if (process.platform === 'win32') killTreeWindows(child.pid!);
      else try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      finish({ state: 'timeout', exitCode: null }, `\n[kora] check killed after ${+(budgetMs / 1000).toFixed(1)} s`);
    }, budgetMs);
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (e) => finish({ state: 'error', exitCode: null }, `\n[kora] check did not run: ${e.message}`));
    child.on('close', (code) => finish({ state: code === 0 ? 'passed' : 'failed', exitCode: code }, code === 0 ? '' : fenceHint(out)));
  }));
}

/**
 * The names of what failed in a test/build run, for the leader's one-line answer (kora_verify): node:test/TAP, vitest/jest,
 * pytest, go test, cargo test and tsc, recognised by their own failure lines. Deduped, at most `max` names of ≤120 chars; `total`
 * is the distinct count found. Pure.
 */
export function failingNames(output: string, max = 10): { names: string[]; total: number } {
  const text = (output || '').replace(ANSI_RE, '').replace(/\r\n?/g, '\n');
  const found: string[] = [];
  const add = (n: string) => { const v = n.replace(/\s+\(\d+(?:\.\d+)?m?s\)\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 120); if (v && !found.includes(v)) found.push(v); };
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^[✖✗✕×]\s+(.+)$/.exec(l))) add(m[1]!);                                     // node:test spec, vitest, jest
    else if ((m = /^not ok \d+\s*-?\s*(.+)$/.exec(l))) add(m[1]!);                       // TAP
    else if ((m = /^FAIL\s+(\S.*)$/.exec(l))) add(m[1]!);                                 // vitest / jest file or test
    else if ((m = /^●\s+(.+)$/.exec(l)) && !/^Console\b/.test(m[1]!)) add(m[1]!);         // jest
    else if ((m = /^FAILED\s+(\S+::\S+)/.exec(l))) add(m[1]!);                           // pytest summary
    else if ((m = /^--- FAIL:\s+(\S+)/.exec(l))) add(m[1]!);                              // go test
    else if ((m = /^test\s+(\S+)\s+\.\.\.\s+FAILED/.exec(l))) add(m[1]!);              // cargo test
    else if ((m = /^(\S+?\(\d+,\d+\)|\S+?:\d+:\d+)\s*[:-]\s*error\s+(TS\d+)/.exec(l))) add(`${m[1]} ${m[2]}`); // tsc
  }
  return { names: found.slice(0, max), total: found.length };
}

/**
 * A failed check that looks like it needed a login: say that it runs under the credential fence, so the lead does not
 * read a worker's correct change as broken. npm / pnpm / yarn / git run fine with ~/.npmrc unreadable (checked); what
 * cannot work is a check that authenticates (a private registry, `gh`, an ssh remote). Deep audit 2026-10-13 A3-3.
 */
export function fenceHint(out: string): string {
  const denied = out.split('\n').some((l) => /Operation not permitted|EPERM|EACCES|Permission denied/i.test(l) && /\.(npmrc|netrc|pypirc|git-credentials|ssh|aws|docker|kube|gnupg)\b|\.config\/(gh|gcloud|op)\b/i.test(l));
  const auth = /\b(E?401|E?403)\b|Unauthorized|authentication required|gh auth login|Permission denied \(publickey/i.test(out);
  return denied || auth
    ? '\n[kora] this check runs under Kora\'s credential fence (~/.npmrc, ~/.netrc, ~/.ssh, ~/.config/gh and other logins are unreadable to it). A failure that needs a login is not the worker\'s fault: run that check yourself.'
    : '';
}

// ── diff ──────────────────────────────────────────────────────────────────────────────────────────────
const git = (cwd: string, args: string[], maxBuffer = 8 << 20) => new Promise<string | null>((resolve) => {
  execFile('git', [...GIT_NO_FSMONITOR, ...args], { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer, env: gitEnv() }, (err, out) => resolve(err ? null : String(out ?? '')));
});

/**
 * The worker's change against the commit it forked from (committed + uncommitted), plus untracked files. The fork
 * point is the merge-base with the main checkout's HEAD; without a worktree it is the checkout's own HEAD.
 */
export async function worktreeDiff(dir: string, mainRoot: string | null): Promise<{ stat: string; patch: string; untracked: string[] }> {
  let base = 'HEAD';
  if (mainRoot && mainRoot !== dir) {
    const mainHead = (await git(mainRoot, ['rev-parse', 'HEAD']))?.trim();
    const mb = mainHead ? (await git(dir, ['merge-base', 'HEAD', mainHead]))?.trim() : null;
    if (mb) base = mb;
  }
  const { isManaged } = require('./worktree') as typeof import('./worktree');
  const [stat, patch, others] = await Promise.all([
    git(dir, ['diff', '--stat=100', base]),
    git(dir, ['diff', base], 32 << 20),
    git(dir, ['ls-files', '--others', '--exclude-standard']),
  ]);
  const untracked = (others ?? '').split('\n').map((l) => l.trim()).filter((f) => f && !isManaged(f));
  // New files are invisible to `git diff`: the reviewer gets their heads (bounded) so it can judge them too.
  let budget = NEW_FILES_CAP;
  const heads: string[] = [];
  for (const f of untracked.slice(0, 20)) {
    if (budget <= 0) break;
    try {
      const fh = await fs.promises.open(path.join(dir, f), 'r');
      try {
        const buf = Buffer.alloc(Math.min(4_096, budget));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const text = buf.subarray(0, bytesRead).toString('utf8');
        if (text.includes('\u0000')) continue; // binary
        heads.push(`+++ ${f} (new file)\n${text}`);
        budget -= bytesRead;
      } finally { await fh.close(); }
    } catch { /* vanished or unreadable */ }
  }
  return { stat: (stat ?? '').trimEnd(), patch: [patch ?? '', ...heads].filter(Boolean).join('\n'), untracked };
}

/** `3 files changed, 40 insertions(+), 2 deletions(-); 1 new file` — the diff stat's summary line (+ untracked). */
export function diffSummary(d: { stat: string; untracked: string[] }): string {
  const last = d.stat.split('\n').filter(Boolean).at(-1)?.trim() ?? '';
  const parts = [/changed/.test(last) ? last : '', d.untracked.length ? `${d.untracked.length} new file${d.untracked.length === 1 ? '' : 's'} (${d.untracked.slice(0, 5).join(', ')}${d.untracked.length > 5 ? ', …' : ''})` : ''].filter(Boolean);
  return parts.join('; ') || 'no changes';
}

// ── reviewer ──────────────────────────────────────────────────────────────────────────────────────────
export function reviewPrompt(task: string, diff: { patch: string; untracked: string[] }, checkLine: string | null): string {
  const patch = diff.patch.length > REVIEW_DIFF_CAP ? `${diff.patch.slice(0, REVIEW_DIFF_CAP)}\n…diff truncated` : diff.patch;
  return [
    'You are a strict code reviewer. Do not edit files or run tools: read the task and the diff below and judge whether the diff does what the task asks, completely and without obvious bugs.',
    `## Task\n${task.slice(0, 6_000)}`,
    `## Diff\n${patch.trim() || '(empty diff)'}`,
    diff.untracked.length ? `## New files\n${diff.untracked.slice(0, 40).join('\n')}` : '',
    checkLine ? `## Done-check\n${checkLine}` : '',
    'Answer with ONE line `VERDICT: PASS` or `VERDICT: FAIL`, then at most 5 short bullet reasons. FAIL only for a concrete problem (task not done, wrong behaviour, broken code), never for style.',
  ].filter(Boolean).join('\n\n');
}

/** The reviewer's answer → verdict. No VERDICT line = error (a garbled answer never fails a worker). */
export function parseReview(output: string): { verdict: 'pass' | 'fail' | 'error'; reasons: string } {
  const text = output.replace(ANSI_RE, '');
  const all = [...text.matchAll(/VERDICT:\s*\**\s*(PASS|FAIL)\b/gi)];
  if (!all.length) return { verdict: 'error', reasons: `no verdict in the reviewer's answer: ${tailOf(text, 4, 300) || '(empty)'}` };
  const m = all[all.length - 1];
  const after = text.slice((m.index ?? 0) + m[0].length).trim();
  return { verdict: m[1].toUpperCase() === 'PASS' ? 'pass' : 'fail', reasons: tailOf(after, 8, 600) };
}

/**
 * The reviewer's permissions: read-only tools allowed, everything else `ask` — which `run` auto-rejects. NOT
 * `{'*': 'deny'}`: a denied tool is dropped from the request, and Zen refuses a tool-less request ("OpenCode's free
 * tier can only be used from within OpenCode", found live 2026-09-26 for opencode 1.18.32 and koragent alike), so the
 * reviewer never produced a verdict on Zen.
 */
export const REVIEWER_PERMISSION: Record<string, string> = { '*': 'ask', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' };

/**
 * `opencode run --pure -m <model> <prompt>` — or `koragent run --pure -m <model> <prompt>` for the koragent backend —
 * with every write refused (the reviewer only reads). Never throws.
 */
export function runReviewer(input: { opencode: string; model: string; cwd: string; prompt: string; env: Record<string, string>; budgetMs?: number; backend?: 'opencode' | 'koragent' }): Promise<{ output: string; failed: boolean }> {
  const deny = JSON.stringify(REVIEWER_PERMISSION);
  // Project config off: the reviewer runs in the WORKER's worktree, and a prompt-injected worker could have written a
  // koragent.json / opencode.json there that loosens this read-only permission (or adds instructions). The task and
  // diff travel in the prompt, so the reviewer needs nothing from the project's config.
  const permEnv = input.backend === 'koragent'
    ? { KORAGENT_PERMISSION: deny, KORAGENT_DISABLE_PROJECT_CONFIG: '1' }
    : { OPENCODE_PERMISSION: deny, OPENCODE_DISABLE_PROJECT_CONFIG: '1' };
  return new Promise((resolve) => {
    // `opencode run` works in $PWD, not its spawn cwd: without this it reviews the folder the daemon started in.
    const env = { ...process.env, ...input.env, ...permEnv, PWD: input.cwd };
    const w = winCommand(input.opencode, ['run', '--pure', '-m', input.model, input.prompt], env); // opencode.cmd on Windows
    const c = execFile(w.command, w.args, {
      cwd: input.cwd, encoding: 'utf8', timeout: input.budgetMs ?? FOREMAN_BUDGET_MS, killSignal: 'SIGKILL', maxBuffer: 4 << 20,
      env, windowsHide: true, windowsVerbatimArguments: w.windowsVerbatimArguments,
    }, (err, stdout, stderr) => resolve({ output: `${stdout ?? ''}\n${stderr ?? ''}`, failed: !!err }));
    c.stdin?.end(); // opencode reads a piped stdin when it is not a TTY: an open pipe hangs the call forever
  });
}

/**
 * A one-shot call to a free OpenCode model for Kora's own small jobs (Blobs memory extraction, routing): the reviewer's
 * shape (`run --pure`, read-only permissions, project config off, caller-chosen EMPTY cwd) but with `--format json`, so
 * the answer is the assistant's text alone and a rate limit is recognised from the error event. Never throws.
 */
export function runOpencodeOneShot(input: { opencode: string; model: string; cwd: string; prompt: string; env: Record<string, string>; budgetMs?: number }): Promise<{ text: string; failed: boolean; rateLimited: boolean; error: string | null }> {
  const { opencodeOutputText } = require('../session/drivers/opencode-parse') as typeof import('../session/drivers/opencode-parse');
  return new Promise((resolve) => {
    // "Task:" first: a prompt that began with `-` would be parsed as a flag.
    const env = { ...process.env, ...input.env, OPENCODE_PERMISSION: JSON.stringify(REVIEWER_PERMISSION), OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', PWD: input.cwd };
    const w = winCommand(input.opencode, ['run', '--pure', '--format', 'json', '-m', input.model, `Task:\n${input.prompt}`], env);
    const c = execFile(w.command, w.args, {
      cwd: input.cwd, encoding: 'utf8', timeout: input.budgetMs ?? FOREMAN_BUDGET_MS, killSignal: 'SIGKILL', maxBuffer: 8 << 20,
      env, windowsHide: true, windowsVerbatimArguments: w.windowsVerbatimArguments,
    }, (err, stdout, stderr) => {
      const parsed = opencodeOutputText(String(stdout ?? ''));
      const rateLimited = parsed.rateLimited || (!parsed.text && RATE_LIMITED_RE.test(`${stdout ?? ''}\n${stderr ?? ''}`));
      resolve({ text: parsed.text, failed: !!err || !parsed.text, rateLimited, error: parsed.error ?? (err ? String(err.message).slice(0, 200) : null) });
    });
    c.stdin?.end(); // see runReviewer
  });
}
const RATE_LIMITED_RE = /429|rate.?limit|too many requests|Free limit reached|Free usage exceeded|FreeUsageLimitError|resource.?exhausted/i;

// ── what the worker and the leader read ───────────────────────────────────────────────────────────────
const FAILURE_WORDS: Record<SwarmForemanFailure, string> = {
  check: 'the done-check failed',
  gate: 'the merge gate still finds broken callers',
  'no-report': 'no report was written',
  crashed: 'the worker exited before reporting',
  reviewer: 'the reviewer rejected the change',
  report: 'the worker\'s own report says the task is not done',
  'no-change': 'the task asked for a change and the worktree has none',
};

/** Report statuses that are never a pass (D19: a `blocked (failed)` report with no diff was "foreman: PASS"). */
export const NOT_DONE_STATUSES = new Set(['failed', 'partial', 'blocked', 'budget']);

/**
 * The status a worker's report claims: Koragent's TaskReport.status when there is one, else the first word under the
 * `.md` report's `## Status` heading (both backends write one). Lower-cased; null when there is none.
 */
export function reportStatus(kgStatus: string | null | undefined, md: string | null | undefined): string | null {
  if (kgStatus) return String(kgStatus).toLowerCase();
  const m = /^#{1,3}\s*status\s*\n+\s*[-*]?\s*\**([a-z-]+)/im.exec(md ?? '');
  return m ? m[1].toLowerCase() : null;
}

/** An empty change: no diff against the fork point and no untracked (non-managed) file. */
export function isEmptyDiff(d: { stat: string; patch: string; untracked: string[] } | null): boolean {
  return !!d && !d.patch.trim() && !d.stat.trim() && d.untracked.length === 0;
}

/** Failures that say more about the model than the task: the next attempt goes to a different free model. */
export function looksModelRelated(failure: SwarmForemanFailure, sameModelFailures: number): boolean {
  return failure === 'no-report' || failure === 'crashed' || failure === 'gate' || failure === 'no-change' || sameModelFailures >= 2;
}

/** One verdict as a line: `#2 big-pickle: check failed (exit 1), gate passed, reviewer FAIL`. */
export function verdictLine(v: SwarmForemanVerdict): string {
  const bits = [
    v.check ? `check ${v.check.state}${v.check.exitCode != null && v.check.state === 'failed' ? ` (exit ${v.check.exitCode})` : ''}` : '',
    v.gate ? `gate ${v.gate}` : '',
    v.review ? `reviewer ${v.review.verdict.toUpperCase()}` : '',
    v.failure && v.failure !== 'check' && v.failure !== 'gate' && v.failure !== 'reviewer' ? FAILURE_WORDS[v.failure] : '',
  ].filter(Boolean);
  return `#${v.attempt} ${v.model.split('/').pop()!.replace(/:free$/, '')}: ${bits.join(', ') || 'ok'}${v.failure ? ` → ${v.failure}` : ' → pass'}`;
}

/** The excerpt that explains a failed verdict (check tail, gate findings, reviewer reasons, screen tail). */
export function failureExcerpt(v: SwarmForemanVerdict, gateSummary: string | null, extra = ''): string {
  const parts: string[] = [];
  if (v.check && v.check.state !== 'passed') parts.push(`check ${v.check.state}${v.check.exitCode != null ? ` (exit ${v.check.exitCode})` : ''}:\n${v.check.tail || '(no output)'}`);
  if (v.gate === 'failed' && gateSummary) parts.push(`merge gate:\n${gateSummary}`);
  if (v.review?.verdict === 'fail') parts.push(`reviewer (${v.review.model ?? '?'}): FAIL\n${v.review.reasons}`);
  if (extra.trim()) parts.push(extra.trim());
  const text = parts.join('\n\n') || FAILURE_WORDS[v.failure ?? 'check'];
  return text.length > DIGEST_CAP ? `${text.slice(0, DIGEST_CAP)}\n…` : text;
}

/** The prompt a retry gets (same pane, or a fresh model in the same worktree). */
export function retryDigest(v: SwarmForemanVerdict, excerpt: string, opts: { check: string | null; reportPath: string; attempt: number; maxAttempts: number; newModel: boolean }): string {
  return [
    `KORA FOREMAN — attempt ${opts.attempt} of ${opts.maxAttempts}. The previous attempt (${v.model}) was not accepted: ${FAILURE_WORDS[v.failure ?? 'check']}.`,
    excerpt,
    opts.newModel ? 'Its work is still in this worktree: run `git status` and `git diff` first, keep what is right, fix what is wrong.' : '',
    `Fix it${opts.check ? `, then run \`${opts.check}\` yourself until it passes` : ''}, and write a fresh report to ${opts.reportPath}.`,
  ].filter(Boolean).join('\n\n');
}

/**
 * The foreman's verdict for kora_wait, SHORT: a pass line (+ diff stat + check tail), or an escalation (what was tried,
 * per-attempt verdicts, the last failure excerpt, the worktree). Null while the foreman is still at work.
 */
export function formatForeman(fm: SwarmForemanState | null | undefined): string | null {
  const r = fm?.result;
  if (!fm || !r) return null;
  if (r.kind === 'pass') {
    return [
      `foreman: PASS on attempt ${r.attempts} of ${fm.maxAttempts}${fm.check ? ` (check \`${fm.check}\` passed)` : ''}${fm.review ? ', reviewer PASS' : ''}`,
      r.diffStat ? `diff: ${r.diffStat}` : '',
    ].filter(Boolean).join('\n'); // a PASS needs no log tail: the check exit code is the verdict (bench5x: ~2K chars of noise)
  }
  return [
    `foreman: ESCALATED after ${r.attempts} attempt${r.attempts === 1 ? '' : 's'} — not accepted, needs your call`,
    ...fm.verdicts.map((v) => `  ${verdictLine(v)}`),
    r.lastFailure ? `last failure:\n${r.lastFailure.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')}` : '',
    r.worktree ? `worktree: ${r.worktree} (partial work is there; fix it yourself, re-spawn with a sharper task, or kora_kill)` : '',
  ].filter(Boolean).join('\n');
}

/** The gate part of a verdict: the X2 state that counts (pending/bounced never reach the foreman). */
export function gateOf(v: FleetSwarmVerify | null): SwarmForemanVerdict['gate'] {
  return v ? v.state : null;
}

