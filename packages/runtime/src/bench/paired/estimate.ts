// Project the cost of a full run from a small calibration run: take the tokens each arm used on the calibration tasks,
// re-price them at the target model's list prices, and scale to the full task set and repetition count. Tokens are
// held fixed, which is an assumption (a bigger model may take more or fewer steps): the result carries a stated
// safety factor and says which tasks were extrapolated.
import type { RunRecord, UsageTotals } from './types';
import { requestCostOf } from '../../ledger/transcript';
import { mean } from './stats';

export interface Estimate {
  targetModel: string;
  reps: number;
  armIds: string[];
  taskIds: string[];
  calibratedTasks: string[];
  extrapolatedTasks: string[];
  perArm: Record<string, { perRun: number; perTask: Record<string, number>; wallSecPerRun: number }>;
  runs: number;
  base: number;
  safetyFactor: number;
  padded: number;
  hours: number;
  notes: string[];
}

function repriced(run: RunRecord, target: string): number {
  let cost = 0;
  for (const [model, t] of Object.entries<UsageTotals>(run.usageByModel)) {
    // the model that did the work moves to the target's prices; side-call models keep their own
    cost += requestCostOf(t, model === run.model || run.model.includes(model) || model.includes(run.model) ? target : model);
  }
  return cost + run.sideCost;
}

export function estimateFullRun(runs: RunRecord[], opts: { targetModel: string; reps: number; taskIds: string[]; safetyFactor?: number }): Estimate {
  const valid = runs.filter((r) => !r.invalid);
  const armIds = [...new Set(valid.map((r) => r.arm))];
  const calibratedTasks = [...new Set(valid.map((r) => r.task))];
  const extrapolated = opts.taskIds.filter((t) => !calibratedTasks.includes(t));
  const perArm: Estimate['perArm'] = {};
  const measured: Record<string, Record<string, number>> = {};
  for (const arm of armIds) {
    const mine = valid.filter((r) => r.arm === arm);
    measured[arm] = {};
    for (const t of calibratedTasks) { const rs = mine.filter((r) => r.task === t); if (rs.length) measured[arm][t] = mean(rs.map((r) => repriced(r, opts.targetModel))); }
  }
  // the arm with the most calibrated tasks is the reference: an arm missing a task gets the reference's cost for it, scaled by
  // the arm/reference ratio on the tasks both ran (a plain average would ignore that T4-style tasks cost 50x a bug fix)
  const ref = [...armIds].sort((a, b) => Object.keys(measured[b]).length - Object.keys(measured[a]).length)[0];
  for (const arm of armIds) {
    const mine = valid.filter((r) => r.arm === arm);
    const perTask: Record<string, number> = { ...measured[arm] };
    const shared = Object.keys(measured[arm]).filter((t) => t in measured[ref]);
    const refSum = shared.reduce((x, t) => x + measured[ref][t], 0);
    const ratio = arm === ref || !refSum ? 1 : shared.reduce((x, t) => x + measured[arm][t], 0) / refSum;
    const avg = mean(Object.values(measured[arm]));
    for (const t of opts.taskIds) if (!(t in perTask)) perTask[t] = t in measured[ref] ? measured[ref][t] * ratio : avg;
    const perRun = mean(opts.taskIds.map((t) => perTask[t]));
    perArm[arm] = { perRun, perTask, wallSecPerRun: mean(mine.map((r) => r.wallMs / 1000)) };
  }
  const base = armIds.reduce((s, a) => s + perArm[a].perRun * opts.taskIds.length * opts.reps, 0);
  const safety = opts.safetyFactor ?? 1.5;
  const runs_ = armIds.length * opts.taskIds.length * opts.reps;
  const hours = armIds.reduce((s, a) => s + perArm[a].wallSecPerRun * opts.taskIds.length * opts.reps, 0) / 3600;
  const notes = [
    `Tokens measured on ${opts.taskIds.length - extrapolated.length} calibration task(s) and re-priced at ${opts.targetModel}; ${extrapolated.length ? `${extrapolated.length} task(s) not in the calibration (${extrapolated.join(', ')}) use the arm's average per-task cost.` : 'every task was calibrated by at least one arm.'}`,
    ...armIds.filter((a) => Object.keys(measured[a]).length < opts.taskIds.length - extrapolated.length).map((a) => `Arm ${a} was measured on ${Object.keys(measured[a]).length} task(s) only; its other tasks are the ${ref} arm's cost scaled by the ${a}/${ref} ratio on the shared tasks.`),
    'Assumes the target model takes about the same number of steps and tokens as the calibration model. A larger model may read less and explore less, or think more: the padded figure applies a safety factor for that.',
    'Wall time assumes the calibration model\'s speed.',
  ];
  return { targetModel: opts.targetModel, reps: opts.reps, armIds, taskIds: opts.taskIds, calibratedTasks, extrapolatedTasks: extrapolated, perArm, runs: runs_, base, safetyFactor: safety, padded: base * safety, hours, notes };
}

export function renderEstimate(e: Estimate): string {
  const L: string[] = [];
  L.push(`### Projected cost of the full run (${e.targetModel}, n=${e.reps} per arm per task, ${e.taskIds.length} tasks, ${e.runs} runs)`, '');
  L.push('| arm | mean $ per run | wall per run (calibration model) |', '|---|---:|---:|');
  for (const a of e.armIds) L.push(`| ${a} | $${e.perArm[a].perRun.toFixed(3)} | ${Math.round(e.perArm[a].wallSecPerRun)}s |`);
  L.push('', `**Projected total: $${e.base.toFixed(2)}; with a ×${e.safetyFactor} safety factor: $${e.padded.toFixed(2)}.** About ${e.hours.toFixed(1)} hours of wall time, one run at a time.`, '');
  for (const n of e.notes) L.push(`- ${n}`);
  return L.join('\n') + '\n';
}
