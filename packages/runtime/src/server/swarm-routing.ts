// Pass-rate routing: which worker model is most likely to finish a task right the FIRST time.
//
// Inputs: ~/.kora/swarm/outcomes.jsonl (one line per finished task, SwarmService.logOutcome), turned into per-model
// (and per coarse task type) counts, time-decayed so a model that got worse (or a free tier that started throttling)
// is noticed within days. Two separate signals per model:
//   quality  did an attempt that actually ran end in a report that verified clean with no bounce
//            (a rate-limit / lost model / bad key is NOT a quality failure; a crash, a skipped report or a stall is)
//   supply   did an attempt run at all, or did the provider refuse it (429 / quota / gone)
// Score = quality × supply − time penalty (− a load penalty the picker adds). With real observations the picker draws
// Thompson samples from the Beta posteriors (exploration for free: an under-tried model sometimes wins the draw);
// with none it uses the posterior means, so a fresh install is deterministic and follows the catalog order.
// Cold-start priors: SEED_PRIORS, measured on this project's 118 real OpenCode worker sessions (2026-09-24).
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';

export type SwarmTaskType = 'research' | 'edit' | 'test-fix';
export const SWARM_TASK_TYPES: readonly SwarmTaskType[] = ['research', 'edit', 'test-fix'];

/**
 * Coarse task type from the leader's task text (cheap regexes; checked against the 118 mined prompts). "Verify with
 * `node --test …`" inside an ordinary edit is not a test-fix: code spans and report instructions are dropped first.
 */
export function classifySwarmTask(task: string): SwarmTaskType {
  const t = String(task ?? '').toLowerCase()
    .replace(/`[^`]*`/g, ' ')
    .replace(/\b(write|update|put|save)\b[^.\n]{0,40}\breport\b/g, ' ');
  if (/\b(do not|don't|never) (edit|change|modify|touch|write)( any)? (code|files|anything|the (code|repo|codebase))\b|\bread[- ]only\b|\bno (code )?changes\b/.test(t)) return 'research';
  if (/\b(failing|broken|red|flaky)\s+(\w+\s+)?(tests?|specs?|suite|build|ci|typecheck)\b|\b(tests?|specs?|suite|build|ci|typecheck)\s+(is\s+|are\s+)?(failing|broken|red)\b|\bfix (the |all |these )?(\w+ )?(tests?|build|ci|type ?errors?|lint( errors)?|compile errors?)\b|\bmake (the |all )?(tests?|suite|ci|build) (pass|green)\b/.test(t)) return 'test-fix';
  if (/\b(add|implement|change|rename|refactor|fix|edit|create|replace|remove|delete|modify|migrate|port|wire|extract|move|bump|upgrade)\b/.test(t)) return 'edit';
  if (/\b(find|list|locate|where|which|explain|summari[sz]e|investigate|research|read|look up|what|how|search|count|audit|survey|compare|map|brief|trace|document)\b/.test(t)) return 'research';
  return 'edit';
}

/** Decayed counts for one model (optionally one task type). Fractional: a bounced pass counts half. */
export interface ModelCounts {
  /** Attempts that ran (quality denominator). */ ran: number;
  /** Clean first-try passes among them. */ passed: number;
  /** Attempts that were refused by the provider (rate limit / gone / key). */ refused: number;
  bounced: number; reportSkipped: number; stalled: number;
  /** Durations (ms) of attempts that produced a report — newest last, capped. */ durations: number[];
}
const emptyCounts = (): ModelCounts => ({ ran: 0, passed: 0, refused: 0, bounced: 0, reportSkipped: 0, stalled: 0, durations: [] });

export interface RoutingStats {
  /** model id → all types + per type. */
  models: Map<string, { all: ModelCounts; byType: Partial<Record<SwarmTaskType, ModelCounts>> }>;
  /** Rows read (for `kora swarm models stats`). */
  rows: number;
}

/** The outcomes.jsonl row fields routing reads (a subset of swarm-usage's OutcomeRow, plus the routing additions). */
export interface RoutingOutcomeRow {
  ts: number; status: string; startedAt?: number; durationMs?: number;
  attempts: { model: string; outcome: string; at: number }[];
  verify?: { state: string; bounces: number } | null;
  /** Added with routing (older rows: classified from the title, else 'edit'). */
  type?: SwarmTaskType; title?: string;
}

const QUALITY_HALF_LIFE_MS = 14 * 24 * 3600_000;
/** Free tiers throttle per IP and change week to week: supply forgets faster. */
const SUPPLY_HALF_LIFE_MS = 3 * 24 * 3600_000;
const SUPPLY_FAIL = new Set(['rate-limited', 'model-gone', 'auth-failed']);
const MAX_DURATIONS = 40;

/** Pure: rows → decayed per-model counts. `now` for the decay. */
export function statsFromOutcomes(rows: RoutingOutcomeRow[], now = Date.now()): RoutingStats {
  const models: RoutingStats['models'] = new Map();
  const slot = (model: string, type: SwarmTaskType): ModelCounts[] => {
    let e = models.get(model);
    if (!e) { e = { all: emptyCounts(), byType: {} }; models.set(model, e); }
    const byType = (e.byType[type] ??= emptyCounts());
    return [e.all, byType];
  };
  for (const r of [...rows].sort((a, b) => a.ts - b.ts)) {
    if (!r || !Array.isArray(r.attempts) || !r.attempts.length) continue;
    const type: SwarmTaskType = r.type && SWARM_TASK_TYPES.includes(r.type) ? r.type : classifySwarmTask(r.title ?? '');
    const age = Math.max(0, now - (r.ts || now));
    const wq = 0.5 ** (age / QUALITY_HALF_LIFE_MS);
    const ws = 0.5 ** (age / SUPPLY_HALF_LIFE_MS);
    r.attempts.forEach((a, i) => {
      if (!a || typeof a.model !== 'string') return;
      const last = i === r.attempts.length - 1;
      const cs = slot(a.model, type);
      if (SUPPLY_FAIL.has(a.outcome)) { for (const c of cs) c.refused += ws; return; }
      // It ran: a supply success, and a quality sample.
      for (const c of cs) c.ran += wq;
      if (a.outcome === 'stalled') { for (const c of cs) c.stalled += wq; return; }
      if (a.outcome === 'crashed' || !last) return; // a crash, or a non-final attempt with no report: quality fail
      // The final attempt: its report + verify decide.
      const reported = r.status === 'done' || a.outcome === 'ok';
      if (!reported) { for (const c of cs) c.reportSkipped += wq; return; }
      const v = r.verify ?? null;
      const bounces = v?.bounces ?? 0;
      let credit = 0;
      if (!v || v.state === 'passed' || v.state === 'skipped' || v.state === 'pending') credit = bounces ? 0.5 : 1;
      else if (v.state === 'failed') credit = 0.1; // bounced out: the leader got broken work
      else credit = 0.5;
      if (bounces) for (const c of cs) c.bounced += wq;
      for (const c of cs) c.passed += wq * credit;
      const end = r.ts || now;
      const dur = end - (a.at || r.startedAt || end);
      if (dur > 0) for (const c of cs) { c.durations.push(dur); if (c.durations.length > MAX_DURATIONS) c.durations.shift(); }
    });
  }
  return { models, rows: rows.length };
}

// ---- reading outcomes.jsonl (cached by size + mtime; only the tail, so a big log never stalls the daemon) --------------

const TAIL_BYTES = 2 * 1024 * 1024;
let cached: { file: string; sig: string; at: number; stats: RoutingStats } | null = null;

export function outcomesFile(): string { return path.join(koraHome(), 'swarm', 'outcomes.jsonl'); }

export function readOutcomeRows(file = outcomesFile()): RoutingOutcomeRow[] {
  let text = '';
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const n = Math.min(st.size, TAIL_BYTES);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, st.size - n);
      text = buf.toString('utf8');
      if (n < st.size) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const out: RoutingOutcomeRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r.ts === 'number' && Array.isArray(r.attempts)) out.push(r); } catch { /* skip */ }
  }
  return out;
}

/** Stats for the picker: recomputed when the log changes (and at most once a minute for the decay). Never throws. */
export function loadRoutingStats(file = outcomesFile(), now = Date.now()): RoutingStats {
  let sig = '';
  try { const st = fs.statSync(file); sig = `${st.size}:${st.mtimeMs}`; } catch { /* none */ }
  if (cached && cached.file === file && cached.sig === sig && now - cached.at < 60_000) return cached.stats;
  const stats = sig ? statsFromOutcomes(readOutcomeRows(file), now) : { models: new Map(), rows: 0 };
  cached = { file, sig, at: now, stats };
  return stats;
}

// ---- cold-start priors ---------------------------------------------------------------------------------------------

/**
 * Measured on 118 real OpenCode worker sessions (97 tasks; e2e + live, 2026-09-24; mined from OpenCode's session DB):
 * quality = report written among attempts that ran, supply = attempts not refused by a rate limit, medianSec = time to
 * the report. Keyed by the model's label (the id's last segment, `:free` dropped) so it applies across providers.
 * Worth at most PRIOR_WEIGHT observations — the user's own outcomes take over after a handful of tasks.
 */
export const SEED_PRIORS: Readonly<Record<string, { quality: number; supply: number; medianSec: number }>> = {
  'big-pickle': { quality: 1.0, supply: 0.84, medianSec: 342 },
  'ling-3.0-flash-fin-free': { quality: 0.96, supply: 1.0, medianSec: 209 },
  'space-bunny-free': { quality: 0.95, supply: 1.0, medianSec: 251 },
  'nemotron-3.5-lightning-free': { quality: 1.0, supply: 1.0, medianSec: 343 },
  'mimo-v2.6-flash-free': { quality: 0.83, supply: 0.6, medianSec: 142 },
  'muse-spark-1.2-contributor-free': { quality: 1.0, supply: 0.54, medianSec: 173 },
  'muse-spark-1.3-contributor-free': { quality: 1.0, supply: 0.17, medianSec: 89 },
  'nemotron-3-ultra-free': { quality: 0.67, supply: 0.5, medianSec: 405 },
};
const PRIOR_WEIGHT = 3;
/** Neutral prior for a model nobody measured: Beta(2,1) quality (≈ 0.67), Beta(4,1) supply (≈ 0.8), 4 min. */
const BASE_Q: [number, number] = [2, 1];
const BASE_S: [number, number] = [4, 1];
const DEFAULT_MEDIAN_MS = 4 * 60_000;

const labelOf = (id: string) => id.split('/').slice(-1)[0].replace(/:free$/, '');

// ---- scoring ---------------------------------------------------------------------------------------------------------

export interface ModelScore {
  model: string;
  /** Posterior means. */ quality: number; supply: number;
  medianMs: number;
  /** Real (decayed) observations behind it, for this task type when present. */ n: number;
  /** quality × supply − time penalty (means, or a Thompson draw when `sample`). */ score: number;
}

/** Marsaglia–Tsang gamma(k, 1) (k ≥ 1; boosted for k < 1). */
function gamma(k: number, rnd: () => number): number {
  if (k < 1) return gamma(k + 1, rnd) * rnd() ** (1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      // Box–Muller normal
      const u1 = Math.max(rnd(), 1e-12), u2 = rnd();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.max(rnd(), 1e-12);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
export function sampleBeta(a: number, b: number, rnd: () => number = Math.random): number {
  const x = gamma(a, rnd), y = gamma(b, rnd);
  return x / (x + y);
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/**
 * Score one model for a task type. `type` counts are used when there are ≥ 2 of them, otherwise the model's all-type
 * counts (a model good at edits is probably fine at a test-fix until shown otherwise). `preferFast` quadruples the time
 * penalty (the watchdog's reassignment: the task already burned T2 on a slow model).
 */
export function scoreModel(stats: RoutingStats, model: string, type: SwarmTaskType | null, opts: { sample?: boolean; rnd?: () => number; preferFast?: boolean } = {}): ModelScore {
  const e = stats.models.get(model);
  const typed = type ? e?.byType[type] : undefined;
  const c = typed && typed.ran + typed.refused >= 2 ? typed : e?.all ?? emptyCounts();
  const seed = SEED_PRIORS[labelOf(model)];
  const qa = BASE_Q[0] + (seed ? PRIOR_WEIGHT * seed.quality : 0) + c.passed;
  const qb = BASE_Q[1] + (seed ? PRIOR_WEIGHT * (1 - seed.quality) : 0) + Math.max(0, c.ran - c.passed);
  const sa = BASE_S[0] + (seed ? PRIOR_WEIGHT * seed.supply : 0) + c.ran;
  const sb = BASE_S[1] + (seed ? PRIOR_WEIGHT * (1 - seed.supply) : 0) + c.refused;
  const medianMs = c.durations.length >= 2 ? median(c.durations) : seed ? seed.medianSec * 1000 : c.durations.length ? c.durations[0] : DEFAULT_MEDIAN_MS;
  const quality = qa / (qa + qb), supply = sa / (sa + sb);
  const rnd = opts.rnd ?? Math.random;
  const q = opts.sample ? sampleBeta(qa, qb, rnd) : quality;
  const s = opts.sample ? sampleBeta(sa, sb, rnd) : supply;
  // 0.02 per minute (0.08 when preferring fast), capped at 20 min: a 5-min model concedes 0.1 to a 0-min one.
  const perMin = opts.preferFast ? 0.08 : 0.02;
  const score = q * s - perMin * Math.min(20, medianMs / 60_000);
  return { model, quality, supply, medianMs, n: c.ran + c.refused, score };
}

/**
 * Order `candidates` best-first for a task. Thompson draws when any candidate has real observations (exploration),
 * posterior means otherwise (deterministic cold start). `load(id)` = live workers on the model: each costs 0.15, which
 * keeps new workers spreading across a tier instead of piling onto one free model (the per-IP throttle). Ties keep
 * the input order (the catalog's rank / the user's provider order).
 */
export function rankModels<T extends { id: string }>(candidates: T[], type: SwarmTaskType | null, opts: { stats: RoutingStats; load?: (id: string) => number; rnd?: () => number; preferFast?: boolean }): T[] {
  const sample = candidates.some((m) => (opts.stats.models.get(m.id)?.all.ran ?? 0) + (opts.stats.models.get(m.id)?.all.refused ?? 0) > 0);
  const scored = candidates.map((m, i) => {
    const s = scoreModel(opts.stats, m.id, type, { sample, ...(opts.rnd ? { rnd: opts.rnd } : {}), ...(opts.preferFast ? { preferFast: true } : {}) });
    return { m, i, v: s.score - 0.15 * (opts.load?.(m.id) ?? 0) };
  });
  scored.sort((a, b) => (b.v - a.v) || (a.i - b.i));
  return scored.map((x) => x.m);
}

// ---- the per-model table (`kora swarm models stats`) --------------------------------------------------------------------

export interface ModelStatsRow {
  model: string; type: SwarmTaskType | 'all'; attempts: number;
  firstTryPass: number | null; bounceRate: number | null; reportSkipRate: number | null; stallRate: number | null; refusedRate: number | null;
  medianSec: number | null;
}

/** The measured table (what happened, decayed relative to the newest row; the picker adds priors on top). */
export function modelStatsTable(rows: RoutingOutcomeRow[]): ModelStatsRow[] {
  // Decay measured from the newest row: the table shows what happened, lightly weighted to recent rows.
  const latest = rows.reduce((m, r) => Math.max(m, r.ts || 0), 0);
  const norm = statsFromOutcomes(rows, latest);
  const out: ModelStatsRow[] = [];
  const row = (model: string, type: ModelStatsRow['type'], c: ModelCounts): ModelStatsRow => {
    const pct = (x: number, d: number) => (d > 0 ? Math.round((x / d) * 100) / 100 : null);
    return {
      model, type, attempts: Math.round(c.ran + c.refused),
      firstTryPass: pct(c.passed, c.ran), bounceRate: pct(c.bounced, c.ran), reportSkipRate: pct(c.reportSkipped, c.ran),
      stallRate: pct(c.stalled, c.ran), refusedRate: pct(c.refused, c.ran + c.refused),
      medianSec: c.durations.length ? Math.round(median(c.durations) / 1000) : null,
    };
  };
  for (const [model, e] of [...norm.models].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(row(model, 'all', e.all));
    for (const t of SWARM_TASK_TYPES) if (e.byType[t]) out.push(row(model, t, e.byType[t]!));
  }
  return out;
}
