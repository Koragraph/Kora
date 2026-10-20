// `kora swarm usage` — MEASURED swarm economics from three local sources, joined:
//   ~/.kora/swarm/outcomes.jsonl            one line per finished worker task (SwarmService.logOutcome)
//   OpenCode's session DB (opencode.db)     real worker tokens, matched to a task by its worktree + time
//   (Koragent tasks carry their own session totals in outcomes.jsonl `usage.tokens`, from the TaskReport)
//   ~/.kora/chat/<thread>/events.ndjson     the Claude leader's turns: workers spawned per turn, Claude tokens
// It replaces the guessed inputs of the pricing model (jobs per Claude window, workers per job, retries, pass rate,
// worker tokens, free vs paid share) with the user's own numbers. Local only; reads, never writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { koraHome } from '../protocol/types';

export interface OutcomeRow {
  v: 1; ts: number; thread: string; taskId: string; status: string; startedAt: number; durationMs: number; title?: string;
  attempts: { model: string; provider: string; outcome: string; at: number }[];
  verify: { state: string; bounces: number } | null; reportBytes: number | null; worktree: string | null;
  /** WorkerBackend (absent = opencode) and, for Koragent, its own session totals from the TaskReport. */
  backend?: 'opencode' | 'koragent';
  usage?: { steps?: number; costUsd?: number; refCostUsd?: number; tokens?: Record<string, number> };
}

/** A Koragent task's session totals (TaskReport.usage) as one worker-tokens row; null when the report had none. */
export function koragentWorkerTokens(o: OutcomeRow): WorkerTokens | null {
  const t = o.usage?.tokens;
  if (o.backend !== 'koragent' || !t) return null;
  const n = (k: string) => Number(t[k]) || 0;
  return { directory: o.worktree ?? '', created: o.startedAt, input: n('in'), cacheRead: n('cacheRead'), cacheWrite: n('cacheWrite'), output: n('out') + n('reasoning'), requests: Number(o.usage?.steps) || 0 };
}
export interface WorkerTokens {
  directory: string; created: number; input: number; cacheRead: number; cacheWrite: number; output: number; requests: number;
  /** prompt size of the first and the largest request (OpenCode sessions): the task's own content is the difference */
  firstPrompt?: number; maxPrompt?: number;
}
export interface LeaderTurn { thread: string; startedAt: number; workers: number; input: number; cached: number; output: number }

/** Reference worker price for the cost column ($/M): Qwen 3.7 Flash on OpenRouter, 2026-09-24. A label, not a bill. */
export const REF_PRICE = { name: 'Qwen 3.7 Flash (OpenRouter)', input: 0.03, cacheRead: 0.006, output: 0.13 };
const WINDOW_MS = 5 * 60 * 60 * 1000;
/** Symlink-resolved path; itself when it no longer exists (a swept worktree: the /private/var form is also tried). */
const canonical = (p: string): string => {
  try { return fs.realpathSync(p); } catch { /* gone */ }
  return /^\/(var|tmp)\//.test(p) && process.platform === 'darwin' ? `/private${p}` : p;
};

export const isFree = (a: { model: string; provider: string }) => a.provider === 'zen' || /:free$/.test(a.model) || a.provider === 'cerebras';
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

export function readOutcomes(sinceMs: number, file = path.join(koraHome(), 'swarm', 'outcomes.jsonl')): OutcomeRow[] {
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: OutcomeRow[] = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { const r = JSON.parse(line); if (r?.v === 1 && r.ts >= sinceMs) out.push(r); } catch { /* skip */ } }
  return out;
}

/** Worker sessions from OpenCode's DB (root sessions only), with summed assistant-message tokens. [] when unreadable. */
export function readWorkerTokens(sinceMs: number, dbPath = opencodeDbPath()): WorkerTokens[] {
  if (!fs.existsSync(dbPath)) return [];
  const origEmit = process.emitWarning; (process as any).emitWarning = () => {}; // node:sqlite is "experimental" on Node 24
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const sessions = db.prepare('select id, directory, time_created as created from session where parent_id is null and time_created >= ?').all(sinceMs) as any[];
    const msg = db.prepare('select data from message where session_id = ?');
    const out: WorkerTokens[] = [];
    for (const s of sessions) {
      const w: WorkerTokens = { directory: String(s.directory), created: Number(s.created), input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 };
      for (const m of msg.all(s.id) as any[]) {
        let d: any; try { d = JSON.parse(m.data); } catch { continue; }
        if (d?.role !== 'assistant') continue;
        const t = d.tokens || {}; w.requests++;
        w.input += t.input || 0; w.output += (t.output || 0) + (t.reasoning || 0); w.cacheRead += t.cache?.read || 0; w.cacheWrite += t.cache?.write || 0;
        const prompt = (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
        if (prompt > 0) { w.firstPrompt ??= prompt; w.maxPrompt = Math.max(w.maxPrompt ?? 0, prompt); }
      }
      if (w.requests) out.push(w);
    }
    db.close?.();
    return out;
  } catch { return []; } finally { (process as any).emitWarning = origEmit; }
}
export function opencodeDbPath(): string {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');
}

/** The Claude leader's turns in the given swarm threads: when, how many workers it spawned, what it cost Claude. */
export function readLeaderTurns(threads: string[], sinceMs: number, chatDir = path.join(koraHome(), 'chat')): LeaderTurn[] {
  const out: LeaderTurn[] = [];
  for (const thread of threads) {
    const id = thread.replace(/^chat:/, '');
    let text = ''; try { text = fs.readFileSync(path.join(chatDir, id, 'events.ndjson'), 'utf8'); } catch { continue; }
    let cur: LeaderTurn | null = null;
    for (const line of text.split('\n')) {
      let e: any; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'turn.started') { cur = { thread, startedAt: Number(e.at) || 0, workers: 0, input: 0, cached: 0, output: 0 }; continue; }
      if (!cur) continue;
      if (e.type === 'worker.attached') cur.workers++;
      if (e.type === 'turn.settled') {
        const u = e.usage || {}; cur.input = u.inputTokens || 0; cur.cached = u.cachedInputTokens || 0; cur.output = u.outputTokens || 0;
        if (cur.startedAt >= sinceMs) out.push(cur);
        cur = null;
      }
    }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** Group turns into Claude-style 5-hour windows: a window opens at a turn and holds every turn that starts within 5 h. */
export function windows(turns: LeaderTurn[]): LeaderTurn[][] {
  const out: LeaderTurn[][] = []; let cur: LeaderTurn[] = []; let start = 0;
  for (const t of turns) { if (!cur.length || t.startedAt - start > WINDOW_MS) { if (cur.length) out.push(cur); cur = [t]; start = t.startedAt; } else cur.push(t); }
  if (cur.length) out.push(cur);
  return out;
}

export interface UsageReport {
  sinceMs: number; tasks: number; byStatus: Record<string, number>; attempts: number; retryRate: number; freeShare: number;
  firstTryPass: number; passRate: number; durationMedianMs: number;
  worker: { matched: number; medianInput: number; p90Input: number; medianOutput: number; medianRequests: number; refCostMedian: number; refCostTotal: number; refPrice: typeof REF_PRICE };
  leader: { jobs: number; turns: number; workersPerJob: { median: number; p90: number; max: number }; jobsPerWindow: { median: number; max: number; windows: number }; claudePerJob: { medianCached: number; medianOutput: number } };
  models: { model: string; attempts: number; ok: number }[];
  activeDays: number;
}

/** One task's worker token sessions, joined by worktree (a session's directory is the worktree or a folder inside it). */
export function workerTokensFor(o: OutcomeRow, workers: WorkerTokens[]): WorkerTokens[] {
  // Koragent reports its own totals (no OpenCode session DB to join).
  if (o.backend === 'koragent') { const k = koragentWorkerTokens(o); return k ? [k] : []; }
  if (!o.worktree) return [];
  // OpenCode records its realpath'd cwd (/private/var/… on macOS) while Kora logs the path it created (/var/…).
  const roots = [...new Set([o.worktree, canonical(o.worktree)])];
  return workers.filter((w) => roots.some((wt) => w.directory === wt || w.directory.startsWith(wt + path.sep)) && w.created >= o.startedAt - 60_000);
}

export function buildReport(outcomes: OutcomeRow[], workers: WorkerTokens[], turns: LeaderTurn[], sinceMs: number): UsageReport {
  const byStatus: Record<string, number> = {};
  for (const o of outcomes) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
  const attempts = outcomes.flatMap((o) => o.attempts);
  const passed = outcomes.filter((o) => o.verify?.state === 'passed' || (o.status === 'done' && (!o.verify || o.verify.state === 'skipped')));
  const firstTry = passed.filter((o) => o.attempts.length === 1 && (o.verify?.bounces ?? 0) === 0);
  const matched = outcomes.flatMap((o) => workerTokensFor(o, workers));
  const inputOf = (w: WorkerTokens) => w.input + w.cacheRead + w.cacheWrite;
  const ref = (w: WorkerTokens) => ((w.input + w.cacheWrite) * REF_PRICE.input + w.cacheRead * REF_PRICE.cacheRead + w.output * REF_PRICE.output) / 1e6;
  const jobs = turns.filter((t) => t.workers > 0);
  const wins = windows(jobs);
  const models = new Map<string, { attempts: number; ok: number }>();
  for (const a of attempts) { const m = models.get(a.model) ?? { attempts: 0, ok: 0 }; m.attempts++; if (a.outcome === 'ok') m.ok++; models.set(a.model, m); }
  const days = new Set(outcomes.map((o) => new Date(o.ts).toISOString().slice(0, 10)));
  return {
    sinceMs, tasks: outcomes.length, byStatus, attempts: attempts.length,
    retryRate: outcomes.length ? (attempts.length - outcomes.length) / outcomes.length : 0,
    freeShare: attempts.length ? attempts.filter(isFree).length / attempts.length : 0,
    firstTryPass: outcomes.length ? firstTry.length / outcomes.length : 0,
    passRate: outcomes.length ? passed.length / outcomes.length : 0,
    durationMedianMs: median(outcomes.map((o) => o.durationMs)),
    worker: {
      matched: matched.length, medianInput: median(matched.map(inputOf)), p90Input: pct(matched.map(inputOf), 0.9),
      medianOutput: median(matched.map((w) => w.output)), medianRequests: median(matched.map((w) => w.requests)),
      refCostMedian: median(matched.map(ref)), refCostTotal: matched.reduce((a, w) => a + ref(w), 0), refPrice: REF_PRICE,
    },
    leader: {
      jobs: jobs.length, turns: turns.length,
      workersPerJob: { median: median(jobs.map((j) => j.workers)), p90: pct(jobs.map((j) => j.workers), 0.9), max: Math.max(0, ...jobs.map((j) => j.workers)) },
      jobsPerWindow: { median: median(wins.map((w) => w.length)), max: Math.max(0, ...wins.map((w) => w.length)), windows: wins.length },
      claudePerJob: { medianCached: median(jobs.map((j) => j.cached)), medianOutput: median(jobs.map((j) => j.output)) },
    },
    models: [...models.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.attempts - a.attempts),
    activeDays: days.size,
  };
}

export function usageReport(days: number): UsageReport {
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const outcomes = readOutcomes(sinceMs);
  const threads = [...new Set(outcomes.map((o) => o.thread))];
  return buildReport(outcomes, readWorkerTokens(sinceMs - 60 * 60 * 1000), readLeaderTurns(threads, sinceMs), sinceMs);
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)));
const p100 = (x: number) => `${Math.round(x * 100)}%`;
export function formatReport(r: UsageReport, days: number): string {
  if (!r.tasks) return `No swarm tasks in the last ${days} day(s). Outcomes are logged from this version on — use Swarm, then run this again.\n`;
  const L: string[] = [];
  L.push(`Swarm usage — last ${days} day(s), ${r.activeDays} active day(s), measured (local logs only)`);
  L.push('');
  L.push(`Claude leader   ${r.leader.jobs} jobs (turns that spawned workers) of ${r.leader.turns} swarm turns`);
  L.push(`                workers per job  median ${r.leader.workersPerJob.median} · p90 ${r.leader.workersPerJob.p90} · max ${r.leader.workersPerJob.max}`);
  L.push(`                jobs per 5-h window  median ${r.leader.jobsPerWindow.median} · max ${r.leader.jobsPerWindow.max} (${r.leader.jobsPerWindow.windows} windows)`);
  L.push(`                Claude per job  median ${k(r.leader.claudePerJob.medianCached)} cache-read · ${k(r.leader.claudePerJob.medianOutput)} output tokens`);
  L.push('');
  L.push(`Worker tasks    ${r.tasks} (${Object.entries(r.byStatus).map(([s, n]) => `${n} ${s}`).join(', ')}) · ${r.attempts} attempts · retry rate ${p100(r.retryRate)}`);
  L.push(`                passed ${p100(r.passRate)} · first try ${p100(r.firstTryPass)} · median ${Math.round(r.durationMedianMs / 1000)} s per task`);
  L.push(`                free-model share of attempts ${p100(r.freeShare)}`);
  L.push(`Worker tokens   ${r.worker.matched} sessions matched · median ${k(r.worker.medianInput)} in (p90 ${k(r.worker.p90Input)}) · ${k(r.worker.medianOutput)} out · ${r.worker.medianRequests} requests`);
  L.push(`                at ${r.worker.refPrice.name} rates: ${(r.worker.refCostMedian * 100).toFixed(2)}¢ median per session · $${r.worker.refCostTotal.toFixed(2)} total if all were paid`);
  L.push('');
  L.push('Models (attempts · ok):');
  for (const m of r.models.slice(0, 10)) L.push(`  ${m.model.padEnd(46)} ${String(m.attempts).padStart(4)} · ${m.ok}`);
  return L.join('\n') + '\n';
}
