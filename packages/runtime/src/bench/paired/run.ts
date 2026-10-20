// The paired runner. For every task and repetition, every arm runs in its OWN fresh copy of the task repo, with the
// same model, effort, prompts and time limit; the order of the arms inside a pair is randomised (seeded) so cache
// warmth and time-of-day cannot favour one arm. Sequential only: one `claude` at a time.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Arm, ArmContext, GradeResult, LoadedTask, RunRecord, UsageTotals } from './types';
import { buildBaseEnv, parentContextFiles } from './arms';
import { changedFiles, gradeRun, materialize, snapshotTree, stateKeyOf, unifiedDiff } from './fixtures';
import { CallBook, addTotals, coldCostOf, costOfCalls, modelUsageOf, sideCostOf, totalsByModel, totalsOf, turnUsageOf, zeroTotals } from './usage';
import { mulberry32 } from './stats';

export interface RunConfig {
  /** scratch root: repo copies and per-arm caches. Must sit OUTSIDE $HOME (no ~/CLAUDE.md above the copies). */
  root: string;
  outDir: string;
  model: string;
  effort: string;
  reps: number;
  seed: number;
  tasks: LoadedTask[];
  arms: Arm[];
  /** stop starting new pairs once the list-price spend reaches this */
  budgetUsd: number;
  /** kill one run whose own list-price cost passes this (it counts as a failed run, its cost stays) */
  runCapUsd: number;
  claudeBin: string;
  log: (line: string) => void;
  keepClaudeTranscripts?: boolean;
}

export const runFile = (outDir: string, task: string, arm: string, rep: number) => path.join(outDir, 'runs', task, `${arm}.r${rep}.json`);

export function loadRuns(outDir: string): RunRecord[] {
  const dir = path.join(outDir, 'runs');
  const out: RunRecord[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const task of fs.readdirSync(dir)) {
    for (const f of fs.readdirSync(path.join(dir, task))) {
      if (!/^.+\.r\d+\.json$/.test(f)) continue;
      try { out.push(JSON.parse(fs.readFileSync(path.join(dir, task, f), 'utf8'))); } catch { /* partial file */ }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// process handling: one child at a time, killed by exact process group

let currentPgid: number | null = null;
let interrupted = false;

function killGroup(signal: NodeJS.Signals): void {
  if (currentPgid == null) return;
  try { process.kill(-currentPgid, signal); } catch { /* already gone */ }
}

export function installInterruptHandler(): void {
  const onSignal = () => { interrupted = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 3000).unref(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
}

export const wasInterrupted = () => interrupted;

interface TurnResult { sessionId: string | null; isError: boolean; text: string; numTurns: number; reported: number; modelUsage: Record<string, UsageTotals>; subtype: string | null }

export function mergeAppendSystemPrompt(args: string[], extra: string): string[] {
  const out = args.slice();
  const i = out.indexOf('--append-system-prompt');
  if (i >= 0 && out[i + 1] !== undefined) out[i + 1] = out[i + 1] + '\n\n' + extra;
  else out.push('--append-system-prompt', extra);
  return out;
}

async function spawnClaude(o: {
  bin: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; deadline: number; streamFile: string;
  onAssistant: () => boolean; book: CallBook; log: (s: string) => void;
}): Promise<{ code: number | null; stderr: string; timedOut: boolean; capped: boolean; result: TurnResult | null }> {
  return new Promise((resolve) => {
    const child = spawn(o.bin, o.args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    currentPgid = child.pid ?? null;
    const sink = fs.createWriteStream(o.streamFile, { flags: 'a' });
    let buf = ''; let stderr = ''; let timedOut = false; let capped = false;
    let result: TurnResult | null = null;
    const remaining = Math.max(1000, o.deadline - Date.now());
    const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 4000).unref(); }, remaining);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        sink.write(line + '\n');
        let ev: any; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'assistant') {
          o.book.foldEvent(ev);
          if (!capped && o.onAssistant()) { capped = true; o.log('  run cap reached: stopping this run'); killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 4000).unref(); }
        } else if (ev.type === 'result') {
          result = { sessionId: ev.session_id || null, isError: !!ev.is_error, text: String(ev.result ?? ''), numTurns: ev.num_turns || 0, reported: Number(ev.total_cost_usd) || 0, modelUsage: modelUsageOf(ev), subtype: ev.subtype || null };
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-10000); });
    child.on('error', (e) => { stderr += String(e); });
    child.on('close', (code) => { clearTimeout(timer); sink.end(); currentPgid = null; resolve({ code, stderr, timedOut, capped, result }); });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// transcripts (the record Claude Code bills from)

function transcriptFor(workdir: string, sessionId: string): string | null {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  const slugs = new Set<string>();
  for (const p of [workdir, (() => { try { return fs.realpathSync(workdir); } catch { return workdir; } })()]) slugs.add(p.replace(/[^a-zA-Z0-9]/g, '-'));
  for (const s of slugs) { const f = path.join(projects, s, `${sessionId}.jsonl`); if (fs.existsSync(f)) return f; }
  try { for (const d of fs.readdirSync(projects)) { const f = path.join(projects, d, `${sessionId}.jsonl`); if (fs.existsSync(f)) return f; } } catch { /* no projects dir */ }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------

const TRANSIENT = /(authentication|not logged in|please run \/login|invalid api key|oauth|rate.?limit|overloaded|ECONN|ENOTFOUND|network|credit balance|usage limit|quota|529|503|socket hang up|fetch failed)/i;

export function invalidReason(r: { apiCalls: number; code: number | null; timedOut: boolean; capped: boolean; interrupted: boolean; result: TurnResult | null; stderr: string; error: string | null }): string | null {
  if (r.interrupted) return 'interrupted';
  if (r.apiCalls === 0) return `no API call was made${r.error ? ': ' + r.error.slice(0, 160) : ''}`;
  if (r.timedOut || r.capped) return null;
  if (r.result?.isError && TRANSIENT.test(r.result.text + ' ' + r.stderr)) return `transient failure: ${r.result.text.slice(0, 160)}`;
  if (!r.result && r.code !== 0) return `claude exited ${r.code} without a result: ${r.stderr.slice(-200)}`;
  return null;
}

export async function runOne(cfg: RunConfig, task: LoadedTask, arm: Arm, rep: number, order: number): Promise<RunRecord> {
  const stateKey = stateKeyOf(task);
  const home = arm.home || arm.id; // model/effort variants share their base arm's repo copy and graph store
  const workdir = path.join(cfg.root, 'work', home, stateKey.replace(/[^A-Za-z0-9._-]+/g, '_'), task.repo);
  const runDir = path.join(cfg.outDir, 'runs', task.id);
  const stem = `${arm.id}.r${rep}`;
  fs.mkdirSync(runDir, { recursive: true });
  const koraHome = path.join(cfg.root, 'arms', arm.id, 'home');
  const koraGraphHome = path.join(cfg.root, 'arms', home, 'graph');
  fs.mkdirSync(koraHome, { recursive: true });
  const baseEnv = buildBaseEnv({ koraHome, koraGraphHome });
  const startedAt = Date.now();

  materialize(task, workdir);
  const leaks = parentContextFiles(workdir);
  if (leaks.length) throw new Error(`context files above the repo copy would leak into the run (move --root outside them): ${leaks.join(', ')}`);

  const model = arm.model || cfg.model;
  const effort = arm.effort || cfg.effort;
  const ctx: ArmContext = { task, rep, workdir, runDir, root: cfg.root, stateKey, model, effort, koraHome, koraGraphHome, baseEnv, log: cfg.log };
  const plan = await arm.prepare(ctx);
  for (const n of plan.notes) cfg.log(`  ${arm.id}: ${n}`);
  const before = snapshotTree(workdir);

  // the run id keeps every run's prompt prefix unique past the static head, so no run rides another's prompt cache
  const nonce = `Benchmark run id ${crypto.randomUUID()} (ignore this line).`;
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...plan.env };
  const emptyMcp = path.join(runDir, 'empty-mcp.json');
  fs.writeFileSync(emptyMcp, '{"mcpServers":{}}\n');
  const hasMcp = plan.args.includes('--mcp-config');
  const hasStrict = plan.args.includes('--strict-mcp-config');

  const book = new CallBook();
  const streamFile = path.join(runDir, `${stem}.stream.jsonl`);
  fs.rmSync(streamFile, { force: true });
  const deadline = Date.now() + task.timeLimitSec * 1000;
  const sessionIds: string[] = [];
  const billed: Record<string, UsageTotals> = {};
  let reportedCost = 0;
  let prevUsage: Record<string, UsageTotals> | null = null; let prevReported = 0; // a resumed session reports cumulatively
  let lastText = '';
  let lastResult: TurnResult | null = null;
  let timedOut = false; let capped = false; let code: number | null = 0; let stderr = '';
  let turnsDone = 0;

  for (let t = 0; t < task.prompts.length; t++) {
    if (interrupted) break;
    let args = ['-p', task.prompts[t], '--model', model, '--effort', effort, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
      '--max-turns', String(task.maxTurns), '--setting-sources', 'project,local', '--disable-slash-commands'];
    if (t > 0 && sessionIds.length) args.push('--resume', sessionIds[sessionIds.length - 1]);
    args.push(...plan.args);
    if (!hasStrict) args.push('--strict-mcp-config');
    if (!hasMcp) args.push('--mcp-config', emptyMcp);
    args = mergeAppendSystemPrompt(args, nonce);
    cfg.log(`  turn ${t + 1}/${task.prompts.length}: ${task.prompts[t].slice(0, 70).replace(/\n/g, ' ')}…`);
    const r = await spawnClaude({
      bin: cfg.claudeBin, args, env, cwd: workdir, deadline, streamFile, book, log: cfg.log,
      onAssistant: () => costOfCalls(book.list()) >= cfg.runCapUsd,
    });
    code = r.code; stderr = r.stderr; timedOut = timedOut || r.timedOut; capped = capped || r.capped;
    if (r.result) {
      lastResult = r.result; lastText = r.result.text;
      const resumed = t > 0 && args.includes('--resume');
      reportedCost += resumed && r.result.reported >= prevReported ? r.result.reported - prevReported : r.result.reported;
      if (r.result.sessionId && !sessionIds.includes(r.result.sessionId)) sessionIds.push(r.result.sessionId);
      for (const [m, u] of Object.entries(turnUsageOf(resumed ? prevUsage : null, r.result.modelUsage))) billed[m] = addTotals(billed[m] || zeroTotals(), u);
      prevUsage = r.result.modelUsage; prevReported = r.result.reported;
      turnsDone++;
    }
    if (r.timedOut || r.capped || (r.result && r.result.isError) || !r.result) break;
  }
  const wallMs = Date.now() - startedAt;

  // transcripts: the record Claude Code bills from; merged per message id, then removed (exact files we caused)
  for (let i = 0; i < sessionIds.length; i++) {
    const f = transcriptFor(workdir, sessionIds[i]);
    if (!f) continue;
    book.foldTranscript(f);
    try { fs.copyFileSync(f, path.join(runDir, `${stem}.transcript${i ? '.' + i : ''}.jsonl`)); } catch { /* evidence is best effort */ }
    if (!cfg.keepClaudeTranscripts) { try { fs.rmSync(f); const d = path.dirname(f); if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch { /* leave it */ } }
  }

  const calls = book.list();
  const seenByModel = totalsByModel(calls);
  const sideCost = sideCostOf(seenByModel, billed);
  const cost = costOfCalls(calls) + sideCost;
  const coldCost = coldCostOf(calls) + sideCost;
  const first = calls[0] || null;
  const usage = totalsOf(calls);

  // evidence and grade
  const edited = changedFiles(before, snapshotTree(workdir));
  const diff = unifiedDiff(workdir);
  fs.writeFileSync(path.join(runDir, `${stem}.diff`), diff);
  fs.writeFileSync(path.join(runDir, `${stem}.answer.md`), lastText);
  let grade: GradeResult | null = null;
  let error: string | null = null;
  try { grade = gradeRun(task, workdir, lastText, before); } catch (e: any) { error = `grading crashed: ${e.message}`; }
  const armTelemetry = arm.collect ? await arm.collect(ctx, { sessionIds, startedAt }).catch(() => ({})) : {};

  const invalid = invalidReason({ apiCalls: calls.length, code, timedOut, capped, interrupted, result: lastResult, stderr, error: error || (lastResult?.isError ? lastResult.text : null) });
  if (!error && lastResult?.isError && !timedOut && !capped) error = lastResult.text.slice(0, 300);
  const passed = !invalid && !timedOut && !capped && !!grade && grade.ok;
  const rec: RunRecord = {
    schema: 1, task: task.id, kind: task.kind, arm: arm.id, rep, order, model, effort,
    startedAt: new Date(startedAt).toISOString(), wallMs, turns: turnsDone, apiCalls: calls.length,
    usage, usageByModel: seenByModel, cost, coldCost, reportedCost, sideCost,
    firstCall: first ? { input: first.input, cacheWrite: first.cacheWrite, cacheRead: first.cacheRead } : null,
    tools: book.tools, passed, grade, timedOut, capped, invalid, error,
    filesChanged: edited.filter((p) => !/^(CLAUDE\.md|AGENTS\.md|\.claude\/|\.mcp\.json)/.test(p)),
    sessionIds, armData: armTelemetry, setupMs: plan.setupMs || 0,
  };
  fs.writeFileSync(runFile(cfg.outDir, task.id, arm.id, rep), JSON.stringify(rec, null, 2));
  return rec;
}

// ---------------------------------------------------------------------------------------------------------------

function shuffled<T>(xs: T[], rand: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export interface PlanItem { task: LoadedTask; rep: number; order: string[] }

/** The full schedule: repetition-major (so stopping early leaves complete repetitions), arm order shuffled per pair. */
export function schedule(tasks: LoadedTask[], arms: Arm[], reps: number, seed: number): PlanItem[] {
  const items: PlanItem[] = [];
  for (let rep = 1; rep <= reps; rep++) {
    for (const task of tasks) {
      const rand = mulberry32((seed ^ hashStr(task.id) ^ Math.imul(rep, 2654435761)) >>> 0);
      items.push({ task, rep, order: shuffled(arms.map((a) => a.id), rand) });
    }
  }
  return items;
}

export async function runBench(cfg: RunConfig): Promise<{ records: RunRecord[]; spent: number; stopped: 'done' | 'budget' | 'interrupted' }> {
  fs.mkdirSync(cfg.outDir, { recursive: true });
  fs.mkdirSync(cfg.root, { recursive: true });
  // never let in-process Kora code touch the real home (explicit assignment, nothing is removed)
  process.env.KORA_TAKEOVER_HOME = '0';
  installInterruptHandler();
  const existing = loadRuns(cfg.outDir);
  let spent = existing.reduce((s, r) => s + r.cost, 0);
  // an invalid run (login failure, network, interrupted) is not a measurement: a resume runs it again
  const have = new Set(existing.filter((r) => !r.invalid).map((r) => `${r.task}|${r.arm}|${r.rep}`));
  const armById = new Map(cfg.arms.map((a) => [a.id, a]));
  const records: RunRecord[] = [...existing];
  fs.writeFileSync(path.join(cfg.outDir, 'config.json'), JSON.stringify({ model: cfg.model, effort: cfg.effort, reps: cfg.reps, seed: cfg.seed, budgetUsd: cfg.budgetUsd, runCapUsd: cfg.runCapUsd, tasks: cfg.tasks.map((t) => t.id), arms: cfg.arms.map((a) => ({ id: a.id, label: a.label, model: a.model || cfg.model, effort: a.effort || cfg.effort })), root: cfg.root, startedAt: new Date().toISOString() }, null, 2));
  for (const item of schedule(cfg.tasks, cfg.arms, cfg.reps, cfg.seed)) {
    const todo = item.order.filter((id) => !have.has(`${item.task.id}|${id}|${item.rep}`));
    if (!todo.length) continue;
    if (interrupted) return { records, spent, stopped: 'interrupted' };
    if (spent >= cfg.budgetUsd) { cfg.log(`budget reached: $${spent.toFixed(2)} of $${cfg.budgetUsd.toFixed(2)} spent; stopping before ${item.task.id} r${item.rep}`); return { records, spent, stopped: 'budget' }; }
    cfg.log(`\n▶ ${item.task.id} rep ${item.rep}/${cfg.reps}  order: ${item.order.join(' → ')}  (${cfg.arms.some((a) => a.model) ? 'per-arm models' : cfg.model}, ${cfg.arms.some((a) => a.effort) ? 'per-arm effort' : cfg.effort})`);
    for (const id of todo) {
      const arm = armById.get(id)!;
      cfg.log(` · ${id}`);
      const rec = await runOne(cfg, item.task, arm, item.rep, item.order.indexOf(id));
      records.push(rec); spent += rec.cost;
      cfg.log(`   ${rec.invalid ? 'INVALID (' + rec.invalid.slice(0, 80) + ')' : rec.passed ? 'PASS' : 'FAIL'} · $${rec.cost.toFixed(4)} (cold $${rec.coldCost.toFixed(4)}) · ${rec.apiCalls} calls · ${Math.round(rec.wallMs / 1000)}s${rec.timedOut ? ' · timed out' : ''}${rec.capped ? ' · run cap' : ''}${rec.grade && !rec.grade.ok ? ' · ' + rec.grade.detail[0] : ''} · spent $${spent.toFixed(3)}`);
      if (interrupted) return { records, spent, stopped: 'interrupted' };
    }
  }
  return { records, spent, stopped: 'done' };
}
