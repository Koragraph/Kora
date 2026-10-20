#!/usr/bin/env node
// Paired benchmark CLI.   node dist/bench/paired/cli.js <list|verify|run|report|estimate> [flags]
// Documentation: docs/bench/PAIRED-HARNESS.md
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinArms, loadArmFile, modelAlias, resolveArm, resolveClaudeBin } from './arms';
import { loadTasks, selectTasks, verifyTask } from './fixtures';
import { loadRuns, runBench, runFile, schedule } from './run';
import { repriceRecord } from './usage';
import { analyse, renderReport } from './report';
import { estimateFullRun, renderEstimate } from './estimate';
import type { Arm } from './types';

const PRESETS: Record<string, { tasks: string; reps: number; model: string; effort: string; runCapUsd: number }> = {
  // tiny run that proves the pipeline end to end: two repositories, three kinds of work, n=2, the cheap model
  calibrate: { tasks: 'T2,T1,M3', reps: 2, model: 'claude-haiku-5-5', effort: 'medium', runCapUsd: 0.5 },
  // the real thing: every task, n=10 per arm per task, the model users actually run
  full: { tasks: 'all', reps: 10, model: 'claude-sonnet-5-5', effort: 'medium', runCapUsd: 2 },
  // multi-file work where planning with the graph should matter: the four P tasks plus the two biggest older ones
  planning: { tasks: 'P1,P2,P3,P4,L2,M1', reps: 5, model: 'claude-sonnet-5-5', effort: 'medium', runCapUsd: 2 },
};

const USAGE = `Usage: node dist/bench/paired/cli.js <command> [flags]

  list                         the tasks and arms
  verify [--tasks ids]         check every task without spending a token: the hidden tests fail on the start state and
                               pass on the reference fix, the visible suite behaves as declared
  run    [flags]               run the paired benchmark (resumable: finished runs are skipped)
  report <out> [--baseline plain]     statistics + plain-language report for a finished or partial run
  estimate <out> [--model sonnet] [--reps 10] [--tasks all] [--safety 1.5]     project the cost of a full run from a calibration run
  reprice <out> [--write]      recompute each run's side cost from its stream file (multi-turn runs recorded before
                               2026-10-16 counted a resumed session's cumulative usage once per turn); --write updates the records

run flags:
  --preset calibrate|full|planning   calibrate: 3 tasks x n=2, Haiku 5.5. full: all tasks x n=10, Sonnet 5.5 (needs --budget-usd).
                               planning: P1-P4 + L2 + M1 x n=5, Sonnet 5.5 (needs --budget-usd)
  --tasks a,b|all              task ids or id prefixes (default: all)
  --arms plain,kora            arms to run (default: plain,kora); more with --arm-file. <arm>@<model> runs that arm on
                               its own model: --arms plain@sonnet,plain@haiku (any arm, model id or sonnet|haiku|opus)
  --baseline <arm>             the arm every other arm is compared with (default: plain, else the first of --arms)
  --arm-file path.mjs          load an extra arm (repeatable); see docs/bench/PAIRED-HARNESS.md
  --model <id|sonnet|haiku>    --effort <low|medium|high>   --reps N   --seed N
  --budget-usd N               stop before the next pair once this much list-price spend is reached
  --run-cap-usd N              kill one run that passes this (it counts as failed)
  --out <dir>                  results (default ./bench-out/paired-<time>)
  --root <dir>                 scratch for repo copies (default <tmp>/kora-bench-paired; must be outside $HOME)
  --dry-run                    print the schedule, run nothing
`;

function parse(argv: string[]) {
  const flags: Record<string, string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) (flags[name] ||= []).push('true');
      else { (flags[name] ||= []).push(next); i++; }
    } else positional.push(a);
  }
  const get = (k: string, d?: string) => (flags[k] ? flags[k][flags[k].length - 1] : d);
  return { flags, positional, get, has: (k: string) => k in flags };
}

const log = (s: string) => process.stdout.write(s + '\n');

export async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  const [command] = args.positional;
  const all = loadTasks();
  if (!command || command === 'help' || args.has('help')) { log(USAGE); return command ? 0 : 2; }

  if (command === 'list') {
    log('Tasks:');
    for (const t of all) log(`  ${t.id.padEnd(24)} ${t.kind.padEnd(18)} ${t.repo.padEnd(10)} ${t.prompts.length} turn(s)  ${t.title}`);
    log('\nArms: plain, kora (built in); more via --arm-file');
    return 0;
  }

  if (command === 'verify') {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-paired-verify-'));
    let bad = 0;
    try {
      for (const t of selectTasks(all, args.get('tasks'))) {
        const r = verifyTask(t, scratch);
        log(`${r.problems.length ? 'FAIL' : 'ok  '} ${t.id}`);
        for (const n of r.notes) log(`       ${n}`);
        for (const p of r.problems) { log(`     ! ${p}`); bad++; }
      }
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    log(bad ? `\n${bad} problem(s)` : '\nall tasks verified');
    return bad ? 1 : 0;
  }

  if (command === 'report') {
    const out = args.positional[1];
    if (!out) { log(USAGE); return 2; }
    const runs = loadRuns(path.resolve(out));
    if (!runs.length) { log(`no runs under ${out}`); return 1; }
    const cfg = readConfig(out);
    const md = renderReport(runs, { baseline: args.get('baseline', 'plain')! }, { model: cfg?.model, effort: cfg?.effort });
    fs.writeFileSync(path.join(out, 'report.md'), md);
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(analyse(runs, { baseline: args.get('baseline', 'plain')! }), null, 2));
    log(md);
    return 0;
  }

  if (command === 'reprice') {
    const out = args.positional[1];
    if (!out) { log(USAGE); return 2; }
    const runs = loadRuns(path.resolve(out));
    let changed = 0;
    for (const r of runs) {
      const stream = path.join(path.resolve(out), 'runs', r.task, `${r.arm}.r${r.rep}.stream.jsonl`);
      if (!fs.existsSync(stream)) continue;
      const next = repriceRecord(r, fs.readFileSync(stream, 'utf8'));
      if (Math.abs(next.cost - r.cost) < 1e-9 && Math.abs(next.reportedCost - r.reportedCost) < 1e-9) continue;
      changed++;
      log(`${r.task} ${r.arm} r${r.rep}: $${r.cost.toFixed(4)} -> $${next.cost.toFixed(4)} (side $${r.sideCost.toFixed(4)} -> $${next.sideCost.toFixed(4)})`);
      if (args.has('write')) fs.writeFileSync(runFile(path.resolve(out), r.task, r.arm, r.rep), JSON.stringify({ ...r, ...next, repricedAt: new Date().toISOString() }, null, 2));
    }
    log(`${changed} of ${runs.length} runs ${args.has('write') ? 'updated' : 'would change (pass --write to update)'}`);
    return 0;
  }

  if (command === 'estimate') {
    const out = args.positional[1];
    if (!out) { log(USAGE); return 2; }
    const runs = loadRuns(path.resolve(out));
    const model = alias(args.get('model', 'sonnet')!);
    const taskIds = selectTasks(all, args.get('tasks', 'all')).map((t) => t.id);
    const e = estimateFullRun(runs, { targetModel: model, reps: Number(args.get('reps', '10')), taskIds, safetyFactor: Number(args.get('safety', '1.5')) });
    log(renderEstimate(e));
    return 0;
  }

  if (command === 'run') {
    const preset = args.get('preset') ? PRESETS[args.get('preset')!] : null;
    if (args.get('preset') && !preset) { log(`unknown preset ${args.get('preset')}`); return 2; }
    const model = alias(args.get('model', preset?.model || 'sonnet')!);
    const effort = args.get('effort', preset?.effort || 'medium')!;
    const reps = Number(args.get('reps', String(preset?.reps ?? 3)));
    const tasks = selectTasks(all, args.get('tasks', preset?.tasks || 'all'));
    const armsAvail: Record<string, Arm> = builtinArms();
    for (const f of args.flags['arm-file'] || []) { const a = await loadArmFile(f); armsAvail[a.id] = a; }
    const armIds = (args.get('arms', ['plain', 'kora', ...Object.keys(armsAvail).filter((k) => k !== 'plain' && k !== 'kora')].join(','))!).split(',').filter(Boolean);
    const arms = armIds.map((id) => resolveArm(id, armsAvail));
    const baseline = args.get('baseline', armIds.includes('plain') ? 'plain' : armIds[0])!;
    if (!armIds.includes(baseline)) { log(`--baseline ${baseline} is not one of --arms ${armIds.join(',')}`); return 2; }
    const seed = Number(args.get('seed', '20251015'));
    if ((args.get('preset') === 'full' || args.get('preset') === 'planning') && !args.has('budget-usd')) { log(`--preset ${args.get('preset')} spends real money: pass --budget-usd <N> (run the estimate command on a calibration run first).`); return 2; }
    const budgetUsd = Number(args.get('budget-usd', preset && args.get('preset') === 'calibrate' ? '2.5' : '10'));
    const runCapUsd = Number(args.get('run-cap-usd', String(preset?.runCapUsd ?? 1)));
    const root = path.resolve(args.get('root', path.join(os.tmpdir(), 'kora-bench-paired'))!);
    if (root === os.homedir() || root.startsWith(os.homedir() + path.sep)) { log(`--root ${root} is inside $HOME; CLAUDE.md files above a repo copy leak into every run. Use a folder outside it (the default does).`); return 2; }
    const outDir = path.resolve(args.get('out', path.join('bench-out', 'paired-' + new Date().toISOString().replace(/[:.]/g, '-')))!);
    if (args.has('dry-run')) {
      const plan = schedule(tasks, arms, reps, seed);
      log(`${plan.length} pairs, ${plan.length * arms.length} runs (${arms.map((a) => `${a.id}: ${a.model || model}/${a.effort || effort}`).join(', ')}); nothing is run.`);
      for (const p of plan) log(`  ${p.task.id} rep ${p.rep}: ${p.order.join(' → ')}`);
      return 0;
    }
    const claudeBin = resolveClaudeBin();
    log(`bench: ${tasks.length} tasks x ${arms.length} arms x ${reps} reps = ${tasks.length * arms.length * reps} runs on ${arms.some((a) => a.model || a.effort) ? arms.map((a) => `${a.id}: ${a.model || model}/${a.effort || effort}`).join(', ') : `${model}/${effort}`}; budget $${budgetUsd}, per-run cap $${runCapUsd}\n  claude: ${claudeBin}\n  scratch: ${root}\n  results: ${outDir}`);
    const res = await runBench({ root, outDir, model, effort, reps, seed, tasks, arms, budgetUsd, runCapUsd, claudeBin, log });
    const runs = loadRuns(outDir);
    const md = renderReport(runs, { baseline }, { model, effort });
    fs.writeFileSync(path.join(outDir, 'report.md'), md);
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(analyse(runs, { baseline }), null, 2));
    log('\n' + md);
    log(`stopped: ${res.stopped}; spent $${res.spent.toFixed(3)}; report: ${path.join(outDir, 'report.md')}`);
    return res.stopped === 'interrupted' ? 130 : 0;
  }

  log(USAGE);
  return 2;
}

const alias = modelAlias;

function readConfig(out: string): { model?: string; effort?: string } | null {
  try { return JSON.parse(fs.readFileSync(path.join(out, 'config.json'), 'utf8')); } catch { return null; }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`bench-paired: ${e && e.stack ? e.stack : e}\n`); process.exit(1); });
