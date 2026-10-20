// Baseline-aware done-checks for swarm tasks.
//
// A leader's check is usually the repo's test command, and real repos often have tests that already fail (a DB that
// is not running, a network call, a flaky suite). Measured (bench5x, 2026-09-27): `cd meridian_api && npx vitest run`
// exits 1 on the untouched repo (35 files need a database), so three workers that had each fixed their bugs kept
// "failing" the check — Koragent's verify loop tried to fix 35 unrelated test files, the foreman bounced them, and a
// 3-minute task ran 30+ minutes.
//
// So a check is judged against the commit the worker started from: Kora runs it once on that commit (in a throwaway
// worktree, cached per commit + command), and both the worker's own verify loop and the foreman run
// `kora swarm check --baseline <file> -- <command>`, which passes when the command passes OR when every failure it
// reports was already failing at the base. New failures fail it, listed first.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import { GIT_NO_FSMONITOR, gitEnv } from '../util/safe-path';

export interface BaselineResult { state: 'passed' | 'failed' | 'timeout' | 'error'; exitCode: number | null; failures: string[]; at: number }

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;

/**
 * Failing-test identifiers in a test runner's output (vitest/jest, pytest, node --test/TAP, go, cargo, mocha). When the
 * runner prints canonical `FAIL <file> > <test>` lines (vitest/jest summary), only those count: its per-test `×` tree
 * lines carry no file and only appear in full output, so mixing the two made one run look like 128 "new" failures.
 */
export function failureIds(output: string): string[] {
  const canonical = new Set<string>();
  const other = new Set<string>();
  for (const raw of output.replace(ANSI, '').split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(?:FAIL|FAILED)\s+(.+)$/))) canonical.add(norm(m[1]));
    else if ((m = line.match(/^(?:✗|×|✖)\s+(.+)$/))) other.add(norm(m[1]));
    else if ((m = line.match(/^not ok \d+\s*-?\s*(.+)$/))) canonical.add(norm(m[1]));
    else if ((m = line.match(/^--- FAIL:\s+(\S+)/))) canonical.add(m[1]);
    else if ((m = line.match(/^test (\S+) \.\.\. FAILED$/))) canonical.add(m[1]);
  }
  return [...(canonical.size ? canonical : other)].filter(Boolean).sort();
}
function norm(s: string): string {
  return s
    .replace(/\s*\[[^\]]*\]\s*$/, '')
    .replace(/\s*\(retry x\d+\)\s*$/, '')
    .replace(/\s*\(?\d+(\.\d+)?\s*m?s\)?\s*$/, '')
    .replace(/\s+-\s+.*$/, (x) => (/::/.test(s) ? x : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Verdict of a check run against its baseline. */
export function judge(after: { exitCode: number | null; output: string }, base: BaselineResult | null): { pass: boolean; summary: string } {
  if (after.exitCode === 0) return { pass: true, summary: 'check passed' };
  if (!base || base.state === 'passed') return { pass: false, summary: `check failed (exit ${after.exitCode})${base ? '; it passes at the base commit' : ''}` };
  const now = failureIds(after.output);
  if (!now.length) return { pass: false, summary: `check failed (exit ${after.exitCode}); no failing tests could be read from its output to compare with the base commit` };
  const was = new Set(base.failures);
  const fresh = now.filter((f) => !was.has(f));
  if (!fresh.length) return { pass: true, summary: `check passed against the base commit: ${now.length} failing test(s), all already failing before this change (none new)` };
  return { pass: false, summary: `check failed: ${fresh.length} NEW failing test(s) (not failing at the base commit):\n${fresh.slice(0, 20).map((f) => `  ${f}`).join('\n')}${fresh.length > 20 ? `\n  … +${fresh.length - 20}` : ''}` };
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const KORA_BIN = path.resolve(__dirname, '../../bin/kora.js');

/** The check command both the worker and the foreman run. */
export function wrapCheck(command: string, baselineFile: string): string {
  return `${q(process.execPath)} ${q(KORA_BIN)} swarm check --baseline ${q(baselineFile)} -- ${q(command)}`;
}

function run(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  // git: never prompt for credentials, no fsmonitor hook from the repo's config, no optional index locks.
  const git = cmd === 'git';
  return new Promise((resolve) => execFile(cmd, git ? [...GIT_NO_FSMONITOR, ...args] : args, { cwd, encoding: 'utf8', timeout: 120_000, ...(git ? { env: gitEnv() } : {}) }, (e, stdout, stderr) => resolve({ ok: !e, out: `${stdout}${stderr}`.trim() })));
}

const pending = new Map<string, Promise<void>>();

/**
 * The baseline file for `command` at `mainRoot`'s current HEAD, computed once (in a detached throwaway worktree with the
 * main checkout's dependencies linked) and cached on disk. Returns the path at once; the file appears when ready.
 */
export async function ensureBaseline(mainRoot: string, command: string, runCheck: (cmd: string, cwd: string, budgetMs: number) => Promise<{ state: BaselineResult['state']; exitCode: number | null; output?: string; tail: string }>): Promise<string> {
  const head = (await run('git', ['rev-parse', 'HEAD'], mainRoot)).out.split('\n')[0];
  const key = crypto.createHash('sha1').update(`${fs.realpathSync(mainRoot)}\n${head}\n${command}`).digest('hex').slice(0, 16);
  const dir = path.join(koraHome(), 'swarm', 'baselines');
  const file = path.join(dir, `${key}.json`);
  if (fs.existsSync(file) || pending.has(key)) return file;
  const job = (async () => {
    const wt = path.join(dir, `wt-${key}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      await fs.promises.rm(wt, { recursive: true, force: true }); // a leftover tree: never a sync delete on the loop
      const add = await run('git', ['worktree', 'add', '--detach', '-f', wt, head], mainRoot);
      if (!add.ok) throw new Error(add.out);
      try { await (require('./worktree') as typeof import('./worktree')).linkDependenciesAsync(mainRoot, wt); } catch { /* best effort */ }
      const cmd = command.split(mainRoot).join(wt);
      const r = await runCheck(cmd, wt, 300_000);
      const res: BaselineResult = { state: r.state, exitCode: r.exitCode, failures: failureIds(r.output ?? r.tail), at: Date.now() };
      fs.writeFileSync(file, JSON.stringify(res));
    } catch (e: any) {
      fs.writeFileSync(file, JSON.stringify({ state: 'error', exitCode: null, failures: [], at: Date.now(), error: String(e?.message ?? e) }));
    } finally {
      await run('git', ['worktree', 'remove', '--force', wt], mainRoot);
      await fs.promises.rm(wt, { recursive: true, force: true }).catch(() => {});
      pending.delete(key);
    }
  })();
  pending.set(key, job);
  return file;
}

/** `kora swarm check --baseline <file> -- <command>`: run it, judge it against the baseline, exit 0/1. */
export async function checkCommand(baselineFile: string, command: string, io: { out: (s: string) => void; waitMs?: number } = { out: (s) => process.stdout.write(s) }): Promise<number> {
  const first = await runShell(command, io.out);
  if (first.code === 0) return 0;
  const base = await readBaseline(baselineFile, io.waitMs ?? 300_000);
  let v = judge({ exitCode: first.code, output: first.text }, base);
  // Suites time out under load (three workers + a test run on one laptop): a failure that is not in the baseline gets
  // one more run, and only failures new in BOTH runs count (bench5x B8: 3 "new" failures were 5 s timeouts).
  if (!v.pass && base && failureIds(first.text).length) {
    io.out('\n[kora] new failures: re-running the check once to rule out flaky tests\n');
    const second = await runShell(command, () => {});
    if (second.code === 0) v = { pass: true, summary: 'check passed on the re-run (the first run\'s failures were flaky)' };
    else {
      const again = new Set(failureIds(second.text));
      const both = failureIds(first.text).filter((f) => again.has(f));
      v = judge({ exitCode: second.code, output: both.map((f) => `FAIL ${f}`).join('\n') }, base);
      if (v.pass) v = { pass: true, summary: `${v.summary}; failures seen in only one of two runs were treated as flaky` };
    }
  }
  io.out(`\n[kora] ${v.summary}\n`);
  return v.pass ? 0 : 1;
}

async function readBaseline(file: string, waitMs: number): Promise<BaselineResult | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const b = JSON.parse(fs.readFileSync(file, 'utf8')) as BaselineResult;
      return b.state === 'error' ? null : b;
    } catch { /* not ready yet */ }
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function runShell(command: string, onOut: (s: string) => void): Promise<{ code: number | null; text: string }> {
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  return new Promise((resolve) => {
    let text = '';
    // Under the credential read-deny, like the done-check itself (swarm-foreman.ts).
    const fenced = (require('../session/os-sandbox') as typeof import('../session/os-sandbox')).wrapReadDeny('check', '/bin/sh', ['-c', command]);
    const child = spawn(fenced.command, fenced.args, { stdio: ['ignore', 'pipe', 'pipe'], env: (require('./swarm-foreman') as typeof import('./swarm-foreman')).checkEnv(), windowsVerbatimArguments: fenced.windowsVerbatimArguments });
    const keep = (b: Buffer) => { const s = b.toString('utf8'); onOut(s); text += s; if (text.length > 8 * 1024 * 1024) text = text.slice(-8 * 1024 * 1024); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('close', (code) => resolve({ code, text }));
    child.on('error', (e) => resolve({ code: 127, text: String(e) }));
  });
}
