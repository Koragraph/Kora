// Statistics for the paired benchmark: cost per PASSING task, pass rate, and paired differences with bootstrap
// confidence intervals. A saving whose interval crosses zero is never reported as a saving.
import type { RunRecord } from './types';

export type Metric = 'cost' | 'coldCost';

export interface Point { cost: number; coldCost: number; passed: boolean; calls: number; wallMs: number }
export interface Pair { task: string; kind: string; rep: number; a: Point; b: Point }
export interface Interval { lo: number; hi: number }
export interface Estimate { est: number; ci: Interval | null }

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pointOf = (r: RunRecord): Point => ({ cost: r.cost, coldCost: r.coldCost, passed: r.passed, calls: r.apiCalls, wallMs: r.wallMs });

/** Pairs: (task, rep) cells where BOTH arms produced a valid run. An invalid run drops its whole pair. */
export function makePairs(runs: RunRecord[], baselineArm: string, variantArm: string): Pair[] {
  const byKey = new Map<string, { a?: RunRecord; b?: RunRecord }>();
  for (const r of runs) {
    if (r.invalid) continue;
    if (r.arm !== baselineArm && r.arm !== variantArm) continue;
    const key = `${r.task}\u0000${r.rep}`;
    const cell = byKey.get(key) || {};
    if (r.arm === baselineArm) cell.a = r; else cell.b = r;
    byKey.set(key, cell);
  }
  const out: Pair[] = [];
  for (const cell of byKey.values()) if (cell.a && cell.b) out.push({ task: cell.a.task, kind: cell.a.kind, rep: cell.a.rep, a: pointOf(cell.a), b: pointOf(cell.b) });
  return out.sort((x, y) => (x.task < y.task ? -1 : x.task > y.task ? 1 : x.rep - y.rep));
}

export function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN; }

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number, z = 1.96): Interval {
  if (n === 0) return { lo: NaN, hi: NaN };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export interface ArmSummary {
  runs: number;
  passes: number;
  passRate: number;
  passRateCi: Interval;
  totalCost: number;
  meanCost: number;
  /** total spend (passing and failing runs) divided by the number of passing runs: what one success really costs */
  costPerPass: number;
  meanCalls: number;
  meanWallSec: number;
}

export function summarizePoints(points: Point[], metric: Metric): ArmSummary {
  const passes = points.filter((p) => p.passed).length;
  const total = points.reduce((s, p) => s + p[metric], 0);
  return {
    runs: points.length,
    passes,
    passRate: points.length ? passes / points.length : NaN,
    passRateCi: wilson(passes, points.length),
    totalCost: total,
    meanCost: mean(points.map((p) => p[metric])),
    costPerPass: passes ? total / passes : NaN,
    meanCalls: mean(points.map((p) => p.calls)),
    meanWallSec: mean(points.map((p) => p.wallMs / 1000)),
  };
}

export type Verdict = 'cheaper' | 'costlier' | 'no-clear-difference' | 'cannot-compare';

export interface Contrast {
  metric: Metric;
  armA: string;
  armB: string;
  pairs: number;
  tasks: number;
  a: ArmSummary;
  b: ArmSummary;
  /** costPerPass(B) / costPerPass(A) */
  ratio: Estimate;
  /** costPerPass(B) − costPerPass(A), dollars */
  diff: Estimate;
  /** passRate(B) − passRate(A) */
  passDiff: Estimate;
  /** mean (cost B − cost A) over the pairs where both arms passed */
  bothPassedDiff: Estimate & { n: number };
  verdict: Verdict;
  /** plain-language one-liner */
  verdictText: string;
  /** how much to trust it */
  evidence: 'anecdote' | 'weak' | 'ok';
  bootstrap: { resamples: number; usable: number };
}

interface Cluster { pairs: Pair[] }

function groupByTask(pairs: Pair[]): Cluster[] {
  const m = new Map<string, Pair[]>();
  for (const p of pairs) { if (!m.has(p.task)) m.set(p.task, []); m.get(p.task)!.push(p); }
  return [...m.values()].map((ps) => ({ pairs: ps }));
}

/** Compare arm B against arm A (A is the baseline). Clustered paired bootstrap: tasks are resampled, then the
 *  repetitions inside each drawn task, and both arms of a pair always travel together. */
export function contrast(pairs: Pair[], baselineArm: string, variantArm: string, metric: Metric = 'cost', opts: { resamples?: number; seed?: number } = {}): Contrast {
  const B = opts.resamples ?? 4000;
  const rand = mulberry32(opts.seed ?? 20251015);
  const clusters = groupByTask(pairs);
  const a = summarizePoints(pairs.map((p) => p.a), metric);
  const b = summarizePoints(pairs.map((p) => p.b), metric);

  const stat = (ps: Pair[]) => {
    const sa = ps.reduce((s, p) => s + p.a[metric], 0);
    const sb = ps.reduce((s, p) => s + p.b[metric], 0);
    const pa = ps.filter((p) => p.a.passed).length;
    const pb = ps.filter((p) => p.b.passed).length;
    const both = ps.filter((p) => p.a.passed && p.b.passed);
    return {
      cppA: pa ? sa / pa : NaN,
      cppB: pb ? sb / pb : NaN,
      passDiff: ps.length ? (pb - pa) / ps.length : NaN,
      bothDiff: both.length ? mean(both.map((p) => p.b[metric] - p.a[metric])) : NaN,
    };
  };
  const point = stat(pairs);
  const ratios: number[] = [];
  const diffs: number[] = [];
  const passDiffs: number[] = [];
  const bothDiffs: number[] = [];
  if (clusters.length > 0) {
    for (let i = 0; i < B; i++) {
      const drawn: Pair[] = [];
      for (let t = 0; t < clusters.length; t++) {
        const c = clusters[Math.floor(rand() * clusters.length)];
        for (let j = 0; j < c.pairs.length; j++) drawn.push(c.pairs[Math.floor(rand() * c.pairs.length)]);
      }
      const s = stat(drawn);
      if (Number.isFinite(s.cppA) && Number.isFinite(s.cppB) && s.cppA > 0) { ratios.push(s.cppB / s.cppA); diffs.push(s.cppB - s.cppA); }
      if (Number.isFinite(s.passDiff)) passDiffs.push(s.passDiff);
      if (Number.isFinite(s.bothDiff)) bothDiffs.push(s.bothDiff);
    }
  }
  const ci = (xs: number[]): Interval | null => {
    if (xs.length < Math.max(50, B * 0.5)) return null; // too many resamples had no passing run in an arm
    const s = [...xs].sort((x, y) => x - y);
    return { lo: percentile(s, 0.025), hi: percentile(s, 0.975) };
  };
  const ratioCi = ci(ratios);
  const ratio: Estimate = { est: point.cppB / point.cppA, ci: ratioCi };
  const diff: Estimate = { est: point.cppB - point.cppA, ci: ci(diffs) };
  const passDiff: Estimate = { est: point.passDiff, ci: ci(passDiffs) };
  const both = pairs.filter((p) => p.a.passed && p.b.passed);
  const bothPassedDiff = { est: point.bothDiff, ci: ci(bothDiffs), n: both.length };

  let verdict: Verdict;
  let text: string;
  if (!Number.isFinite(ratio.est) || !ratio.ci) {
    verdict = 'cannot-compare';
    text = pairs.length === 0 ? 'no complete pairs' : 'an arm passed too few tasks to put a confidence interval on cost per passing task';
  } else if (ratio.ci.hi < 1) {
    verdict = 'cheaper';
    text = `${variantArm} is cheaper per passing task: ${pct(ratio.est - 1)} (95% CI ${pct(ratio.ci.lo - 1)} to ${pct(ratio.ci.hi - 1)}, excludes zero)`;
  } else if (ratio.ci.lo > 1) {
    verdict = 'costlier';
    text = `${variantArm} is MORE expensive per passing task: ${pct(ratio.est - 1)} (95% CI ${pct(ratio.ci.lo - 1)} to ${pct(ratio.ci.hi - 1)}, excludes zero)`;
  } else {
    verdict = 'no-clear-difference';
    text = `no clear difference in cost per passing task: ${pct(ratio.est - 1)} (95% CI ${pct(ratio.ci.lo - 1)} to ${pct(ratio.ci.hi - 1)}, crosses zero, so this is NOT a saving)`;
  }
  if (passDiff.ci && passDiff.ci.hi < 0) text += `; ${variantArm} passes fewer tasks (${pp(passDiff.est)} points, CI ${pp(passDiff.ci.lo)} to ${pp(passDiff.ci.hi)})`;
  else if (passDiff.ci && passDiff.ci.lo > 0) text += `; ${variantArm} passes more tasks (+${pp(passDiff.est)} points, CI ${pp(passDiff.ci.lo)} to ${pp(passDiff.ci.hi)})`;
  const evidence: Contrast['evidence'] = pairs.length < 10 || clusters.length < 3 ? 'anecdote' : pairs.length < 30 ? 'weak' : 'ok';
  return { metric, armA: baselineArm, armB: variantArm, pairs: pairs.length, tasks: clusters.length, a, b, ratio, diff, passDiff, bothPassedDiff, verdict, verdictText: text, evidence, bootstrap: { resamples: B, usable: ratios.length } };
}

export function pct(x: number): string {
  if (!Number.isFinite(x)) return 'n/a';
  const v = x * 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%`;
}

export function pp(x: number): string {
  if (!Number.isFinite(x)) return 'n/a';
  const v = x * 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(0)}`;
}
