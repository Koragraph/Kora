// Task fixtures for the paired benchmark: load tasks, build the start-state repo, grade a finished run, and `verify`
// that every task is sound (hidden tests fail on the start state and pass on the reference fix).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AnswerCheck, GradeResult, LoadedTask, TaskSpec } from './types';

/** bench/paired inside the runtime package (works from src/ and from dist/, which sit at the same depth). */
export function pairedRoot(): string {
  return path.resolve(__dirname, '..', '..', '..', 'bench', 'paired');
}

export function loadTasks(root: string = pairedRoot()): LoadedTask[] {
  const dir = path.join(root, 'tasks');
  const tasks: LoadedTask[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name, 'task.json');
    if (!fs.existsSync(file)) continue;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8')) as TaskSpec;
    if (spec.id !== name) throw new Error(`task folder ${name} has id ${spec.id}`);
    const repoDir = path.join(root, 'repos', spec.repo);
    if (!fs.existsSync(repoDir)) throw new Error(`task ${spec.id}: repo ${spec.repo} not found`);
    tasks.push({ ...spec, dir: path.join(dir, name), repoDir });
  }
  return tasks;
}

export function selectTasks(all: LoadedTask[], ids: string | undefined): LoadedTask[] {
  if (!ids || ids === 'all') return all;
  const wanted = ids.split(',').map((s) => s.trim()).filter(Boolean);
  return wanted.map((w) => {
    const hit = all.find((t) => t.id === w || t.id.startsWith(w + '-'));
    if (!hit) throw new Error(`unknown task "${w}" (have: ${all.map((t) => t.id).join(', ')})`);
    return hit;
  });
}

/** Tasks with the same repo and the same start-state overlay share an index, so they share a state key. */
export function stateKeyOf(task: LoadedTask): string {
  return task.startState.overlay ? `${task.repo}@${task.id}` : `${task.repo}@base`;
}

// ---------------------------------------------------------------------------------------------------------------
// files and git

const SKIP = new Set(['.git', 'node_modules']);

export function copyTree(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** Environment for git calls that must not depend on the user's git config. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'bench',
    GIT_AUTHOR_EMAIL: 'bench@example.invalid',
    GIT_COMMITTER_NAME: 'bench',
    GIT_COMMITTER_EMAIL: 'bench@example.invalid',
    GIT_AUTHOR_DATE: '2025-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2025-01-01T00:00:00Z',
  };
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Build the task's start state at `dest`: the repo plus the overlay, as ONE commit with a fixed author and date, so
 *  every copy has the same HEAD (an index built for it stays valid for the next copy). Returns the commit sha. */
export function materialize(task: LoadedTask, dest: string): string {
  fs.rmSync(dest, { recursive: true, force: true });
  copyTree(task.repoDir, dest);
  if (task.startState.overlay) copyTree(path.join(task.dir, task.startState.overlay), dest);
  git(dest, ['init', '-q', '-b', 'main']);
  git(dest, ['add', '-A']);
  git(dest, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture']);
  return git(dest, ['rev-parse', 'HEAD']);
}

export type Snapshot = Map<string, string>;

/** path → content hash of every file (not .git, not node_modules). */
export function snapshotTree(dir: string): Snapshot {
  const out: Snapshot = new Map();
  const walk = (d: string, rel: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else if (entry.isFile()) out.set(r, crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex'));
    }
  };
  walk(dir, '');
  return out;
}

export function changedFiles(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  for (const [p, h] of after) if (before.get(p) !== h) out.push(p);
  for (const p of before.keys()) if (!after.has(p)) out.push(p);
  return out.sort();
}

/** Files an arm installs itself (rulebook block, hooks, MCP config): never counted as the agent's edits. */
export const ARM_INFRA = /^(CLAUDE\.md|AGENTS\.md|GEMINI\.md|\.mcp\.json|\.claude\/|\.kora\/|\.koragraph\/|\.gitnexus\/|\.graphify\/|\.codegraph\/)/;

export function unifiedDiff(dir: string): string {
  const tracked = spawnSync('git', ['diff', '--no-color'], { cwd: dir, env: gitEnv(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).stdout || '';
  const untracked = (spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: dir, env: gitEnv(), encoding: 'utf8' }).stdout || '')
    .split('\n').map((s) => s.trim()).filter((p) => p && !ARM_INFRA.test(p));
  let extra = '';
  for (const p of untracked) { try { extra += `\n+++ new file ${p}\n` + fs.readFileSync(path.join(dir, p), 'utf8').slice(0, 20000); } catch { /* unreadable */ } }
  return tracked + extra;
}

// ---------------------------------------------------------------------------------------------------------------
// grading

function testEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH || '', HOME: process.env.HOME || '', TMPDIR: process.env.TMPDIR || '/tmp', LANG: 'en_US.UTF-8', NODE_ENV: 'test' };
}

export function runNode(cwd: string, args: string[], timeoutMs = 120_000): { code: number | null; tail: string } {
  const r = spawnSync(process.execPath, args, { cwd, env: testEnv(), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const fails = text.split('\n').filter((l) => /^\s*not ok /.test(l)).slice(0, 8);
  const summary = text.split('\n').filter((l) => /^# (tests|pass|fail)/.test(l));
  return { code: r.status, tail: [...fails, ...summary].join('\n').slice(0, 1200) || text.slice(-600) };
}

export function checkAnswer(check: AnswerCheck, answer: string): { ok: boolean; detail: string[] } {
  const detail: string[] = [];
  const text = answer.toLowerCase();
  for (const need of check.all || []) if (!text.includes(need.toLowerCase())) detail.push(`answer is missing "${need}"`);
  const except = check.exceptLine ? new RegExp(check.exceptLine, 'i') : null;
  for (const bad of check.none || []) {
    const lines = answer.split('\n').filter((l) => l.toLowerCase().includes(bad.toLowerCase()));
    const offending = lines.filter((l) => !(except && except.test(l)));
    if (offending.length) detail.push(`answer names "${bad}" as if it were a caller`);
  }
  return { ok: detail.length === 0, detail };
}

function applyHidden(task: LoadedTask, workdir: string): void {
  const hidden = task.grade.hidden;
  if (!hidden) return;
  if (task.grade.hiddenMode === 'replace-test-dir') fs.rmSync(path.join(workdir, 'test'), { recursive: true, force: true });
  copyTree(path.join(task.dir, hidden), workdir);
}

/** Grade a finished run. `before` is the snapshot taken right before the agent started (after the arm's setup). */
export function gradeRun(task: LoadedTask, workdir: string, answer: string, before: Snapshot): GradeResult {
  const res: GradeResult = { ok: true, detail: [], commands: [], answerOk: null, editedOk: null };
  const edited = changedFiles(before, snapshotTree(workdir)).filter((p) => !ARM_INFRA.test(p));
  if (task.grade.mustNotEdit) {
    res.editedOk = edited.length === 0;
    if (!res.editedOk) { res.ok = false; res.detail.push(`read-only task, but these files changed: ${edited.slice(0, 5).join(', ')}`); }
  }
  if (task.grade.answer) {
    const a = checkAnswer(task.grade.answer, answer);
    res.answerOk = a.ok;
    if (!a.ok) { res.ok = false; res.detail.push(...a.detail); }
  }
  if (task.grade.hidden) {
    applyHidden(task, workdir);
    for (const args of task.grade.commands || [['--test']]) {
      const r = runNode(workdir, args);
      res.commands.push({ cmd: `node ${args.join(' ')}`, code: r.code, tail: r.tail });
      if (r.code !== 0) { res.ok = false; res.detail.push(`hidden tests failed (exit ${r.code}): ${r.tail.split('\n')[0] || ''}`); }
    }
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------------------
// verify: every task is sound before a single token is spent

export interface VerifyReport { task: string; problems: string[]; notes: string[] }

export function verifyTask(task: LoadedTask, scratch: string): VerifyReport {
  const problems: string[] = [];
  const notes: string[] = [];
  const dir = path.join(scratch, task.id);
  materialize(task, dir);
  const noEdits = snapshotTree(dir);

  // 1. the visible suite in the start state
  const visible = runNode(dir, ['--test']);
  const visiblePass = visible.code === 0;
  if (task.startState.visibleTests === 'pass' && !visiblePass) problems.push(`start state: the visible suite should pass but exits ${visible.code}: ${visible.tail.split('\n')[0]}`);
  if (task.startState.visibleTests === 'fail' && visiblePass) problems.push('start state: the visible suite should fail but passes');
  notes.push(`start state visible suite: ${visiblePass ? 'pass' : 'fail'}`);

  // 2. a run that changes nothing and answers nothing must not pass (the hidden tests / answer check carry weight)
  const untouched = gradeRun(task, dir, '', noEdits);
  if (untouched.ok) problems.push('an untouched repo with an empty answer PASSES the grade (nothing is being tested)');
  notes.push(`untouched start state: ${untouched.ok ? 'PASS (bad)' : 'fail (good)'}`);

  // 3. the reference solution must pass
  const refDir = path.join(scratch, task.id + '.reference');
  materialize(task, refDir);
  const before = snapshotTree(refDir);
  for (const rel of task.reference.revert || []) fs.copyFileSync(path.join(task.repoDir, rel), path.join(refDir, rel));
  if (task.reference.overlay) copyTree(path.join(task.dir, task.reference.overlay), refDir);
  const answer = task.reference.answer ? fs.readFileSync(path.join(task.dir, task.reference.answer), 'utf8') : '';
  if (!task.reference.revert && !task.reference.overlay && !task.reference.answer) problems.push('no reference solution declared');
  const ref = gradeRun(task, refDir, answer, task.grade.mustNotEdit ? snapshotTree(refDir) : before);
  if (!ref.ok) problems.push(`the reference solution FAILS the grade: ${ref.detail.join(' | ')}`);
  notes.push(`reference solution: ${ref.ok ? 'pass' : 'FAIL'}`);

  // 4. hidden files are not inside the repo the agent sees
  if (task.grade.hidden) {
    for (const f of snapshotTree(path.join(task.dir, task.grade.hidden)).keys()) {
      if (fs.existsSync(path.join(task.repoDir, f)) && !/^test\//.test(f)) notes.push(`hidden file ${f} shadows a repo file`);
    }
    for (const f of snapshotTree(path.join(task.dir, task.grade.hidden)).keys()) if (/hidden/i.test(f) && noEdits.has(f)) problems.push(`hidden test ${f} is visible in the start state`);
  }
  if (!Number.isFinite(task.timeLimitSec) || task.prompts.length === 0) problems.push('task needs prompts and a time limit');
  return { task: task.id, problems, notes };
}
