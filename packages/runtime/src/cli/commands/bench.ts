import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { KORAGRAPH_SUITE, judge, type BenchSuite, type BenchTask } from '../../bench/tasks';
import { prepareCopy, releaseCopy, resetCopy, dirtyCopy, runOne, report, Condition, RunResult } from '../../bench/runner';
import { runSession, sessionReport, SessionResult } from '../../bench/session';
import { RunMetrics, summarize, renderSummary, gate, writeJson, Summary, DEFAULT_GATE } from '../../bench/metrics';

export const summary = 'A/B the same task headless: plain Claude Code vs inside kora. Real cost from claude itself.';
export const usage = `Usage: kora bench [--repo <path>] [--out <dir>] [--suite <file.json>] [--tasks <file.json>] [--only <id,id>]
                    [--conditions baseline,kora] [--model claude-sonnet-5] [--effort medium] [--max-turns 30] [--budget 3]
                    [--repeat 3] [--mixed] [--reuse-copies] [--regime indexed|cold|dirty] [--warm]
       kora bench --gate [--baseline bench/baseline.json] [--summary <out>/summary.json]
       kora bench --promote --summary <out>/summary.json [--baseline bench/baseline.json]
       kora bench --rejudge --out <dir>          re-run the success verdicts over saved answers with current expectations

Each (task × condition × repeat) is one headless \`claude -p\` session on its own copy of the repo, reset to the suite's
pinned SHA between runs. The built-in suite pins KoragraphMCP and covers understand / callers / change-plan / edit /
strings, plus dirty-tree and cold (never indexed) regimes. --mixed runs ONE continuous 10-turn session per condition.
Output: <out>/summary.json (schema 2: per-run + medians/spread + savings only where both arms succeeded), <out>/report.md,
<out>/runs/<task>/<condition>[.rN].{json,metrics.json,answer.md,stream.jsonl,diff}.
--gate compares a summary with the committed baseline and exits 1 on regression (savings −${DEFAULT_GATE.savingsDropPct} pts,
injected tokens +${DEFAULT_GATE.injectedTokensGrowPct}%, any success drop, any silent-injection kill). --promote copies a summary over the baseline.`;

export async function run(argv: string[], io: { out: (s: string) => void; err: (s: string) => void }): Promise<number> {
  const get = (k: string, d?: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const root = path.resolve(__dirname, '..', '..', '..');
  const baselineFile = path.resolve(get('--baseline', path.join(root, 'bench', 'baseline.json'))!);
  if (argv.includes('--gate') || argv.includes('--promote')) {
    const sf = get('--summary'); if (!sf) { io.err('--summary <file> required\n'); return 2; }
    const cur: Summary = JSON.parse(fs.readFileSync(sf, 'utf8'));
    if (argv.includes('--promote')) { writeJson(baselineFile, cur); io.out(`baseline ← ${sf} (${cur.overallSavingsPct ?? 'n/a'}% overall, ${cur.runs.length} runs)\n`); return 0; }
    if (!fs.existsSync(baselineFile)) { io.err(`no baseline at ${baselineFile}; run --promote first\n`); return 2; }
    const base: Summary = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    const g = gate(base, cur);
    io.out(g.lines.join('\n') + '\n' + (g.ok ? 'GATE PASS\n' : 'GATE FAIL\n'));
    return g.ok ? 0 : 1;
  }
  let suite: BenchSuite = KORAGRAPH_SUITE;
  const sfile = get('--suite'); if (sfile) suite = JSON.parse(fs.readFileSync(sfile, 'utf8'));
  if (argv.includes('--resummarize')) {
    // Rebuild every single-task RunMetrics from its saved stream.jsonl with the CURRENT fold (usage dedupe, first-call
    // cache split, steady cost) — keeps the injection/success fields already recorded. No agent tokens.
    const { emptyBucket, foldAssistant, steadyCostOf, usageFromTranscript } = require('../../bench/metrics') as typeof import('../../bench/metrics');
    const out = path.resolve(get('--out', path.join(process.cwd(), 'bench-out'))!);
    const old: Summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
    let n = 0;
    for (const m of old.runs) {
      const stem = `${m.condition}${m.repeat ? '.r' + m.repeat : ''}`;
      const f = path.join(out, 'runs', m.task, `${stem}.stream.jsonl`); if (!fs.existsSync(f)) continue;
      const b = emptyBucket();
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) { if (!line.trim()) continue; let o: any; try { o = JSON.parse(line); } catch { continue; } if (o.type === 'assistant' && o.message) foldAssistant(b, o.message); }
      let transcript: string | null = null; let ru: any = null; try { const rj = JSON.parse(fs.readFileSync(path.join(out, 'runs', m.task, `${stem}.json`), 'utf8')); transcript = rj.transcript || null; ru = rj.usage || null; } catch { /* none */ }
      if (ru && (ru.cacheRead || ru.cacheWrite || ru.output)) { b.input = ru.input; b.output = ru.output; b.cacheRead = ru.cacheRead; b.cacheWrite = ru.cacheWrite; }
      const tu = usageFromTranscript(transcript);
      if (tu) { b.apiCalls = tu.apiCalls; b.firstCallCacheWrite = tu.firstCallCacheWrite; b.firstCallCacheRead = tu.firstCallCacheRead; }
      Object.assign(m, { input: b.input, output: b.output, cacheRead: b.cacheRead, cacheWrite: b.cacheWrite, turns: b.apiCalls, toolCalls: b.tools, firstCallCacheWrite: Math.max(0, b.firstCallCacheWrite), firstCallCacheRead: Math.max(0, b.firstCallCacheRead), steadyCost: steadyCostOf(m.cost, b.firstCallCacheWrite, m.model), fellBackToGrep: m.injections > 0 && b.searched ? 1 : 0 });
      try { fs.writeFileSync(path.join(out, 'runs', m.task, `${stem}.metrics.json`), JSON.stringify(m, null, 2)); } catch { /* fine */ }
      n++;
    }
    const s = summarize(old.runs, { suite: old.suite, repo: old.repo, model: old.model, effort: old.effort, repeats: old.repeats, conditions: old.conditions });
    writeJson(path.join(out, 'summary.json'), s); fs.writeFileSync(path.join(out, 'report.md'), renderSummary(s) + '\n');
    io.out(`resummarized ${n} runs\n` + renderSummary(s) + '\n');
    return 0;
  }
  if (argv.includes('--rejudge')) {
    // Re-run the mechanical verdict over SAVED answers/diffs with the current expectations (an expectation that was
    // too strict is a bug in the scoreboard, not a reason to re-spend agent tokens). Rewrites metrics + summary.
    const out = path.resolve(get('--out', path.join(process.cwd(), 'bench-out'))!);
    const old: Summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
    const all = [...suite.tasks, ...suite.mixed];
    let changed = 0;
    for (const m of old.runs) {
      const task = all.find((t) => t.id === m.task); if (!task) continue;
      const isMixed = suite.mixed.some((t) => t.id === m.task);
      const dir = isMixed ? path.join(out, 'sessions') : path.join(out, 'runs', m.task);
      const stem = `${m.condition}${m.repeat ? '.r' + m.repeat : ''}`;
      let answer = '';
      // mixed: answers live per SESSION file, with the repeat suffix (older runs overwrote it per repeat — then only
      // repeat 0 can be re-judged; the rest keep their recorded verdict)
      if (isMixed) { const f = path.join(dir, `${stem}.answers.md`); if (!fs.existsSync(f) && m.repeat) continue; try { const md = fs.readFileSync(f, 'utf8'); const sec = md.split(/^## /m).find((x) => x.startsWith(m.task + '\n')); answer = sec ? sec.slice(m.task.length) : ''; } catch { continue; } }
      else { try { answer = fs.readFileSync(path.join(dir, `${stem}.answer.md`), 'utf8'); } catch { /* none */ } }
      let diff: { files: string[]; text: string } | null = null;
      try { const text = fs.readFileSync(path.join(dir, `${stem}.diff`), 'utf8'); diff = { files: Array.from(text.matchAll(/^(?:\+\+\+ (?:b\/)?)(\S+)/gm)).map((x) => x[1]), text }; } catch { diff = null; }
      // an edit verdict needs the working-tree diff; a mixed session does not save one per turn — keep the recorded verdict
      if (!diff && task.expect && (task.expect.diffFiles || task.expect.diffRegex)) continue;
      if (!diff) diff = { files: [], text: '' };
      const v = judge(task, answer, diff);
      const success = v.success && !m.error;
      if (success !== m.success) changed++;
      m.success = success; m.successDetail = m.error ? [`error: ${m.error.slice(0, 80)}`, ...v.detail] : v.detail;
      if (!isMixed) { try { fs.writeFileSync(path.join(dir, `${stem}.metrics.json`), JSON.stringify(m, null, 2)); } catch { /* fine */ } }
    }
    const s = summarize(old.runs, { suite: old.suite, repo: old.repo, model: old.model, effort: old.effort, repeats: old.repeats, conditions: old.conditions });
    writeJson(path.join(out, 'summary.json'), s); fs.writeFileSync(path.join(out, 'report.md'), renderSummary(s) + '\n');
    io.out(`rejudged ${old.runs.length} runs, ${changed} verdict(s) changed\n` + renderSummary(s) + '\n');
    return 0;
  }
  const repo = path.resolve(get('--repo', suite.repo.path)!);
  if (!fs.existsSync(repo)) { io.err(`repo not found: ${repo}\n${usage}\n`); return 2; }
  const outDir = path.resolve(get('--out', path.join(process.cwd(), 'bench-out'))!);
  const conditions = (get('--conditions', 'baseline,kora')!).split(',') as Condition[];
  const model = get('--model', 'claude-sonnet-5')!, effort = get('--effort', 'medium')!;
  const maxTurns = Number(get('--max-turns', '30')), budgetUsd = Number(get('--budget', '3'));
  const repeats = Math.max(1, Number(get('--repeat', '1')));
  // --warm: before the measured runs, one throwaway 1-turn session per (condition × regime) with the suite's first prompt,
  // so BOTH arms start with their prefix in the prompt cache. Measured: a cold first call writes ~44k tokens (~$0.17),
  // a warm one reads them — a swing larger than most tasks that depended on what ran in the previous hour.
  const warm = argv.includes('--warm');
  let tasks: BenchTask[] = suite.tasks;
  const tf = get('--tasks'); if (tf) tasks = JSON.parse(fs.readFileSync(tf, 'utf8'));
  const only = get('--only'); if (only) { const ids = new Set(only.split(',')); tasks = tasks.filter((t) => ids.has(t.id)); }
  const regimeFlag = get('--regime'); if (regimeFlag) tasks = tasks.filter((t) => (t.regime || 'indexed') === regimeFlag);
  fs.mkdirSync(outDir, { recursive: true });
  const binPath = path.resolve(root, 'bin', 'kora.js');
  const pin = get('--repo') ? undefined : suite.repo.sha;
  const copies: Record<string, string> = {};
  const copyFor = (c: Condition, regime: 'indexed' | 'cold' | 'dirty'): string => {
    const key = `${c}:${regime === 'cold' ? 'cold' : 'main'}`;
    if (copies[key]) return copies[key];
    const existing = path.join(outDir, 'repos', c, path.basename(repo));
    copies[key] = regime !== 'cold' && argv.includes('--reuse-copies') && fs.existsSync(existing) ? (resetCopy(existing, pin), existing) : prepareCopy(repo, outDir, c, { sha: pin, regime });
    io.out(`copy ${key}: ${copies[key]}\n`);
    // Indexes are per checkout: the kora arm's clone is indexed like a user's checkout. Kora refuses a first index to an
    // agent, so a bench started by an agent stops here; run it from a terminal.
    if (regime !== 'cold' && c !== 'baseline') {
      const r = spawnSync(process.execPath, [binPath, 'ingest', copies[key]], { stdio: ['ignore', 'ignore', 'inherit'] });
      if (r.status !== 0) throw new Error(`kora ingest ${copies[key]} failed (exit ${r.status}); run kora bench from a terminal`);
    }
    return copies[key];
  };
  const allMetrics: RunMetrics[] = [];
  // Copies are deleted when the run ends, however it ends (--reuse-copies keeps them).
  const releaseAll = (): void => { if (!argv.includes('--reuse-copies')) for (const d of Object.values(copies)) releaseCopy(d); };
  process.once('exit', releaseAll); // also when a run throws
  const meta = { suite: suite.name, repo: { path: repo, sha: pin || 'HEAD' }, model, effort, repeats, conditions };
  const flush = () => { const s = summarize(allMetrics, meta); writeJson(path.join(outDir, 'summary.json'), s); fs.writeFileSync(path.join(outDir, 'report.md'), renderSummary(s) + '\n'); return s; };

  const warmUp = async (c: Condition, cwd: string, prompt: string) => {
    if (!warm) return;
    io.out(`  warm-up ${c}: one throwaway turn so the prefix is cached\n`);
    const t: BenchTask = { id: 'warm-up', kind: 'understand', prompt };
    fs.mkdirSync(path.join(outDir, 'warm'), { recursive: true });
    const r = await runOne({ task: t, condition: c, cwd, model, effort, maxTurns: 1, budgetUsd: 0.5, binPath, outDir: path.join(outDir, 'warm'), log: () => {}, suite, repeat: 0 });
    io.out(`  warm-up ${c}: $${r.costUsd.toFixed(3)}, first call cw=${r.metrics.firstCallCacheWrite} cr=${r.metrics.firstCallCacheRead}\n`);
  };
  if (argv.includes('--mixed')) {
    const seq = tf ? tasks : suite.mixed;
    if (warm) for (const c of conditions) { const cwd = copyFor(c, 'indexed'); resetCopy(cwd, pin); await warmUp(c, cwd, seq[0].prompt); }
    const sres: SessionResult[] = [];
    for (let r = 0; r < repeats; r++) for (const c of conditions) {
      const cwd = copyFor(c, 'indexed'); resetCopy(cwd, pin);
      io.out(`\n══ mixed session / ${c} / repeat ${r + 1}/${repeats}  (${model}, ${effort}) ══\n`);
      const res = await runSession({ tasks: seq, condition: c, cwd, model, effort, maxTurns, budgetUsd, binPath, outDir, log: (s) => io.out(s + '\n'), suite, repeat: r });
      sres.push(res); allMetrics.push(...(res.metrics || []));
      io.out(`  session: ${res.costUsd.toFixed(3)} USD, ${Math.round(res.durationMs / 1000)}s, injected decls ${res.metrics?.reduce((a, m) => a + m.injectedDecls, 0)}\n`);
      fs.writeFileSync(path.join(outDir, 'report-sessions.md'), sessionReport(sres) + '\n'); flush();
    }
    io.out('\n' + sessionReport(sres) + '\n\n' + renderSummary(flush()) + '\n');
    return 0;
  }
  const results: RunResult[] = [];
  if (warm) for (const c of conditions) { const cwd = copyFor(c, 'indexed'); resetCopy(cwd, pin); await warmUp(c, cwd, tasks[0]?.prompt || 'hello'); }
  for (let r = 0; r < repeats; r++) for (const t of tasks) for (const c of conditions) {
    const regime = t.regime || 'indexed';
    const cwd = copyFor(c, regime); resetCopy(cwd, pin);
    if (regime === 'dirty') { const files = dirtyCopy(cwd); io.out(`  dirty: ${files.length} files touched\n`); }
    io.out(`\n▶ ${t.id} [${regime}] / ${c} / repeat ${r + 1}/${repeats}  (${model}, ${effort})\n`);
    const res = await runOne({ task: t, condition: c, cwd, model, effort, maxTurns, budgetUsd, binPath, outDir, log: (s) => io.out(s + '\n'), suite, repeat: r });
    results.push(res); allMetrics.push(res.metrics);
    const m = res.metrics;
    io.out(`  done: ${res.costUsd.toFixed(3)} USD, ${m.turns} api calls, ${Math.round(res.durationMs / 1000)}s, reads ${m.toolCalls.read} (${m.toolCalls.wholeFileRead} whole), greps ${m.toolCalls.grep + m.toolCalls.bashSearch}, graph ${m.toolCalls.graph}, injected ${m.injectedDecls} decls/${m.injectedTokens} tok (${m.graphHits} hit/${m.graphMisses} miss), success ${m.success ? 'YES' : 'NO ' + m.successDetail.join('; ')}${res.error ? `, ERROR ${res.error.slice(0, 120)}` : ''}\n`);
    fs.writeFileSync(path.join(outDir, 'report-legacy.md'), report(results) + '\n'); flush();
  }
  io.out('\n' + renderSummary(flush()) + '\n');
  return 0;
}
