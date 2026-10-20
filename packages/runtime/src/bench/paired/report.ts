// Plain-language report for a paired run: one headline per arm, the paired contrast with confidence intervals, and
// the losses spelled out. Never calls a saving a saving when its interval crosses zero.
import type { RunRecord } from './types';
import { type Contrast, type Metric, contrast, makePairs, pct, pp, summarizePoints, mean } from './stats';

const usd = (x: number, d = 3) => (Number.isFinite(x) ? `$${x.toFixed(d)}` : 'n/a');
const ci = (c: { lo: number; hi: number } | null | undefined, f: (x: number) => string) => (c ? `${f(c.lo)} to ${f(c.hi)}` : 'n/a');
const pctRate = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : 'n/a');

export interface ReportOptions { baseline: string; resamples?: number; seed?: number }

export interface ReportData {
  baseline: string;
  armIds: string[];
  validRuns: number;
  invalidRuns: RunRecord[];
  contrasts: { cost: Contrast; coldCost: Contrast }[];
}

export function analyse(runs: RunRecord[], opts: ReportOptions): ReportData {
  const arms = [...new Set(runs.map((r) => r.arm))];
  const baseline = arms.includes(opts.baseline) ? opts.baseline : arms[0];
  const others = arms.filter((a) => a !== baseline);
  const contrasts = others.map((b) => {
    const pairs = makePairs(runs, baseline, b);
    return {
      cost: contrast(pairs, baseline, b, 'cost', { resamples: opts.resamples, seed: opts.seed }),
      coldCost: contrast(pairs, baseline, b, 'coldCost', { resamples: opts.resamples, seed: opts.seed }),
    };
  });
  return { baseline, armIds: arms, validRuns: runs.filter((r) => !r.invalid).length, invalidRuns: runs.filter((r) => r.invalid), contrasts };
}

function headline(c: Contrast): string {
  const per = (s: { costPerPass: number; passes: number; runs: number }) => `${usd(s.costPerPass)} per passing task (${s.passes}/${s.runs} passed)`;
  return `**${c.armB} vs ${c.armA}** on ${c.pairs} paired runs over ${c.tasks} tasks: ${c.armA} ${per(c.a)}, ${c.armB} ${per(c.b)}. ${cap(c.verdictText)}.${c.evidence === 'anecdote' ? ' _Too few pairs to rely on: treat as an anecdote._' : c.evidence === 'weak' ? ' _Modest sample: the interval is wide._' : ''}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function renderReport(runs: RunRecord[], opts: ReportOptions, meta: { model?: string; effort?: string; title?: string } = {}): string {
  const data = analyse(runs, opts);
  const L: string[] = [];
  const first = runs.find((r) => !r.invalid);
  const models = [...new Set(runs.filter((r) => !r.invalid).map((r) => r.model))];
  const efforts = [...new Set(runs.filter((r) => !r.invalid).map((r) => r.effort))];
  const modelText = models.length > 1 || efforts.length > 1
    ? `per-arm ${models.length > 1 ? 'models' : 'model'}${efforts.length > 1 ? ' and effort' : ''} (${data.armIds.map((id) => { const r = runs.find((x) => x.arm === id); return `${id}: ${r?.model}/${r?.effort}`; }).join(', ')})`
    : `${first?.model || meta.model || '?'} / ${first?.effort || meta.effort || '?'}`; // what the runs used (an arm may override --model)
  L.push(`# ${meta.title || 'Paired benchmark'} — ${modelText}`, '');
  L.push(`${data.validRuns} valid runs, ${data.invalidRuns.length} invalid (excluded), arms: ${data.armIds.join(', ')}. Baseline: **${data.baseline}**. Cost = list price of every API call (cache writes at the 1-hour rate), all calls including side calls.`, '');
  if (data.contrasts.length === 0) { L.push('_Only one arm has runs: nothing to compare._'); return L.join('\n') + '\n'; }

  L.push('## In plain words', '');
  for (const c of data.contrasts) {
    L.push(`- ${headline(c.cost)}`);
    if (c.coldCost.verdict !== c.cost.verdict) L.push(`  - Priced as if every run started with a cold prompt cache the verdict is different: ${c.coldCost.verdictText}.`);
  }
  L.push('');

  for (const c of data.contrasts) {
    const k = c.cost;
    L.push(`## ${k.armB} vs ${k.armA} — paired contrast (${k.pairs} pairs, 95% bootstrap CI over ${k.tasks} tasks × repetitions)`, '');
    L.push('| measure | ' + k.armA + ' | ' + k.armB + ' | difference (B − A) | 95% CI |', '|---|---:|---:|---:|---|');
    L.push(`| pass rate | ${pctRate(k.a.passRate)} (${k.a.passes}/${k.a.runs}; Wilson ${pctRate(k.a.passRateCi.lo)}–${pctRate(k.a.passRateCi.hi)}) | ${pctRate(k.b.passRate)} (${k.b.passes}/${k.b.runs}; Wilson ${pctRate(k.b.passRateCi.lo)}–${pctRate(k.b.passRateCi.hi)}) | ${pp(k.passDiff.est)} points | ${ci(k.passDiff.ci, pp)} points |`);
    L.push(`| **cost per passing task** | ${usd(k.a.costPerPass)} | ${usd(k.b.costPerPass)} | ${usd(k.diff.est)} (${pct(k.ratio.est - 1)}) | ${k.ratio.ci ? `${pct(k.ratio.ci.lo - 1)} to ${pct(k.ratio.ci.hi - 1)}` : 'n/a'} |`);
    L.push(`| cost per passing task, cold-cache pricing | ${usd(c.coldCost.a.costPerPass)} | ${usd(c.coldCost.b.costPerPass)} | ${usd(c.coldCost.diff.est)} (${pct(c.coldCost.ratio.est - 1)}) | ${c.coldCost.ratio.ci ? `${pct(c.coldCost.ratio.ci.lo - 1)} to ${pct(c.coldCost.ratio.ci.hi - 1)}` : 'n/a'} |`);
    L.push(`| mean cost per run | ${usd(k.a.meanCost)} | ${usd(k.b.meanCost)} | ${usd(k.b.meanCost - k.a.meanCost)} | |`);
    L.push(`| pairs where both passed: mean cost B − A | | | ${usd(k.bothPassedDiff.est)} (n=${k.bothPassedDiff.n}) | ${k.bothPassedDiff.ci ? `${usd(k.bothPassedDiff.ci.lo)} to ${usd(k.bothPassedDiff.ci.hi)}` : 'n/a'} |`);
    L.push(`| API calls per run | ${k.a.meanCalls.toFixed(1)} | ${k.b.meanCalls.toFixed(1)} | ${(k.b.meanCalls - k.a.meanCalls).toFixed(1)} | |`);
    L.push(`| wall time per run | ${k.a.meanWallSec.toFixed(0)}s | ${k.b.meanWallSec.toFixed(0)}s | ${(k.b.meanWallSec - k.a.meanWallSec).toFixed(0)}s | |`);
    L.push('', `Verdict: **${k.verdict}** (${k.evidence} evidence; ${k.bootstrap.usable}/${k.bootstrap.resamples} bootstrap resamples had a passing run in both arms).`, '');

    // per task, descriptive: the losses are published
    const pairs = makePairs(runs, k.armA, k.armB);
    const tasks = [...new Set(pairs.map((p) => p.task))];
    L.push('### Per task (descriptive: a handful of runs each, no interval)', '');
    L.push(`| task | kind | pairs | ${k.armA} pass | ${k.armB} pass | ${k.armA} mean $ | ${k.armB} mean $ | Δ mean $ | |`, '|---|---|---:|---:|---:|---:|---:|---:|---|');
    for (const t of tasks) {
      const ps = pairs.filter((p) => p.task === t);
      const sa = summarizePoints(ps.map((p) => p.a), 'cost');
      const sb = summarizePoints(ps.map((p) => p.b), 'cost');
      const d = sb.meanCost / sa.meanCost - 1;
      const flag = sb.passes < sa.passes ? 'passes fewer' : sb.meanCost > sa.meanCost * 1.1 ? 'costs more' : sb.meanCost < sa.meanCost * 0.9 && sb.passes >= sa.passes ? 'cheaper' : '';
      L.push(`| ${t} | ${ps[0].kind} | ${ps.length} | ${sa.passes}/${sa.runs} | ${sb.passes}/${sb.runs} | ${usd(sa.meanCost)} | ${usd(sb.meanCost)} | ${pct(d)} | ${flag} |`);
    }
    L.push('');
    const kinds = [...new Set(pairs.map((p) => p.kind))];
    L.push('### Per kind of work', '');
    L.push(`| kind | pairs | ${k.armA} pass | ${k.armB} pass | ${k.armA} $/passing | ${k.armB} $/passing |`, '|---|---:|---:|---:|---:|---:|');
    for (const kind of kinds) {
      const ps = pairs.filter((p) => p.kind === kind);
      const sa = summarizePoints(ps.map((p) => p.a), 'cost');
      const sb = summarizePoints(ps.map((p) => p.b), 'cost');
      L.push(`| ${kind} | ${ps.length} | ${sa.passes}/${sa.runs} | ${sb.passes}/${sb.runs} | ${usd(sa.costPerPass)} | ${usd(sb.costPerPass)} |`);
    }
    L.push('');
  }

  // health
  const valid = runs.filter((r) => !r.invalid);
  const side = mean(valid.map((r) => (r.cost ? r.sideCost / r.cost : 0)));
  L.push('## Run health', '');
  L.push(`- Timed out: ${valid.filter((r) => r.timedOut).length}; stopped by the per-run cost cap: ${valid.filter((r) => r.capped).length}; graded runs that crashed: ${valid.filter((r) => r.error && /grading crashed/.test(r.error)).length}.`);
  L.push(`- Side calls (title / summary, outside the transcript) are ${Number.isFinite(side) ? (side * 100).toFixed(1) : '0'}% of cost on average.`);
  const rep = valid.filter((r) => r.reportedCost > 0);
  if (rep.length) L.push(`- Claude Code's own total_cost_usd is ${(rep.reduce((s, r) => s + r.reportedCost, 0) / Math.max(1e-9, rep.reduce((s, r) => s + r.cost, 0))).toFixed(2)}× the list-price cost computed here (it mis-prices some models; only ours is used).`);
  if (data.invalidRuns.length) for (const r of data.invalidRuns.slice(0, 8)) L.push(`- Invalid, excluded: ${r.task} ${r.arm} r${r.rep}: ${r.invalid}`);
  L.push('', '## Method', '',
    `- ${models.length > 1 || efforts.length > 1 ? `The ${[models.length > 1 ? 'model' : '', efforts.length > 1 ? 'effort' : ''].filter(Boolean).join(' and ')} differ${models.length > 1 && efforts.length > 1 ? '' : 's'} by arm (it is what is measured); the same${models.length > 1 ? '' : ' model,'}${efforts.length > 1 ? '' : ' effort,'}` : 'Same model, effort,'} prompts, time limit and tools in every arm; each run in its own fresh copy of the task repo (deterministic git HEAD) outside $HOME, with isolated Kora state and the Kora PATH shims off PATH; the order of the arms inside a pair is randomised.`,
    '- Pass/fail is decided by hidden tests the agent never sees (or, for read-only questions, a mechanical check of the answer and an unchanged repo). A timed-out or cost-capped run fails.',
    '- Cost per passing task = total spend of all runs of an arm (passing and failing) ÷ its passing runs. Intervals: paired bootstrap that resamples tasks, then repetitions inside a task, keeping both arms of a pair together. A saving whose interval crosses zero is not reported as a saving.',
    '- Cost is computed from API usage per call at list prices (cache writes at the 1-hour rate); the cold-cache variant prices each run\'s first prompt as a cache write.', '');
  return L.join('\n');
}

export function metricSummary(runs: RunRecord[], baselineArm: string, variantArm: string, metric: Metric = 'cost') {
  return contrast(makePairs(runs, baselineArm, variantArm), baselineArm, variantArm, metric);
}
