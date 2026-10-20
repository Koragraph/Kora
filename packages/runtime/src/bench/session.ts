// Mixed-session bench: ONE continuous Claude session per condition, several prompts in sequence, fed over
// stream-json stdin so context accumulates exactly as it does in a real working hour. This is the number the
// product's pitch actually rests on: not "one task type", the whole mix.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { winCommand } from '../util/win-exec';
import { spawn } from 'node:child_process';
import { parseSessionTree, summarize, fmtTokens, fmtUsd } from '../ledger/transcript';
import { stripEnv, type Condition } from './runner';
import { judge, type BenchTask, type BenchSuite } from './tasks';
import { RunMetrics, METRICS_SCHEMA, emptyBucket, foldAssistant, injectionsFor, TurnBucket, InjectRecordLite, foldInjections, steadyCostOf } from './metrics';
import { copyDiff, neutralizeCopy } from './runner';

export const MIXED_TASKS: BenchTask[] = [
  { id: 'm1-understand', kind: 'understand', prompt: 'How does the MCP server decide which repository a tool call is scoped to? Walk through it with the functions involved and file:line. Under 250 words.' },
  { id: 'm2-callers', kind: 'callers', prompt: 'Who calls resolveProjectScope, and what does each caller pass as the scope value? file:line for each call site.' },
  { id: 'm3-edit', kind: 'edit', prompt: 'In src/cli/stderr-filter.js, add a summarised rule (same shape as the existing INGEST_SUMMARISED entries) that collapses lines starting with `[lsp]` into one line reading "N LSP notice(s)". Keep the file\'s style. Edit the file; do not run tests. One-line summary when done.' },
  { id: 'm4-strings', kind: 'change-plan', prompt: 'List every place the string practice.db appears in code comments, docs or help text (not in code paths that build the filename). file:line each. Be complete and concise.' },
  { id: 'm5-plan', kind: 'change-plan', prompt: 'I want graphStaleness() to also return an ageMs field (milliseconds since the last ingest). What would need to change, and what depends on its return shape today? file:line. Do not edit.' },
  { id: 'm6-edit2', kind: 'edit', prompt: 'Now make that change: add ageMs to what graphStaleness() returns, computed from the latest ingest timestamp it already reads, and thread it to wherever the staleness note is rendered so the note can say "(Ns ago)". Minimal diff. Do not run tests. Two-line summary.' },
  { id: 'm7-test', kind: 'edit', prompt: 'Add a unit test for the new stderr-filter rule, in the same style and location as the existing stderr-filter tests. Do not run it. One-line summary.' },
  { id: 'm8-summary', kind: 'understand', prompt: 'Summarise everything we changed in this session in five bullets, each with the file touched.' },
];

export interface TurnResult { task: string; costUsd: number; costDelta: number; durationMs: number; numTurns: number; error: string | null; tools: Record<string, number>; graphCalls: number; bucket?: TurnBucket; answer?: string; startedAt?: number }
export interface SessionResult { condition: Condition; sessionId: string | null; turns: TurnResult[]; costUsd: number; durationMs: number; transcript: string | null; ledger: any; toolClasses: any; context: number; answers: Record<string, string>; metrics?: RunMetrics[] }

export async function runSession(opts: { tasks: BenchTask[]; condition: Condition; cwd: string; model: string; effort: string; maxTurns: number; budgetUsd: number; binPath: string; outDir: string; log: (s: string) => void; suite?: BenchSuite; repeat?: number }): Promise<SessionResult> {
  const { condition, cwd, log } = opts;
  const env = stripEnv();
  let args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', opts.model, '--effort', opts.effort, '--dangerously-skip-permissions', '--max-turns', String(opts.maxTurns), '--max-budget-usd', String(opts.budgetUsd), '--strict-mcp-config'];
  if (condition === 'baseline') { const empty = path.join(opts.outDir, 'empty-mcp.json'); fs.writeFileSync(empty, '{"mcpServers":{}}'); args.push('--mcp-config', empty); neutralizeCopy(cwd); }
  else {
    const { createEnforcer } = require('../enforce'); const enforcer = createEnforcer();
    await enforcer.install({ agent: 'claude', cwd, replaceKoragraphHooks: true });
    Object.assign(env, { KORA_ENV: '1', KORA_BIN: opts.binPath, KORA_AGENT: 'claude', KORA_REPO_ROOT: cwd, KORA_SOCKET_PATH: path.join(opts.outDir, 'no-server.sock') });
    const plan = await enforcer.prepare({ agent: 'claude', cwd, paneId: 'bench', socketPath: env.KORA_SOCKET_PATH, binPath: opts.binPath, command: 'claude', args: [], env });
    Object.assign(env, plan.env || {});
    args = [...args, ...(plan.args || []).filter((a: string, i: number, arr: string[]) => !(a === '--strict-mcp-config' || (a === '--mcp-config' && /none\.json$/.test(arr[i + 1] || '')) || /none\.json$/.test(a)))];
    log(`  prepare: ${(plan.notes || []).join(' · ')}`);
  }
  const t0 = Date.now();
  const raw: string[] = []; const turns: TurnResult[] = []; const answers: Record<string, string> = {};
  const result: SessionResult = { condition, sessionId: null, turns, costUsd: 0, durationMs: 0, transcript: null, ledger: null, toolClasses: null, context: 0, answers };
  const cli = winCommand('claude', args, env);
  const child = spawn(cli.command, cli.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: cli.windowsVerbatimArguments });
  let buf = ''; let stderr = '';
  let cur: TurnResult | null = null; let resolveTurn: (() => void) | null = null; let lastCumulative = 0;
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; raw.push(line);
      let o: any; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'system' && o.session_id) result.sessionId = result.sessionId || o.session_id;
      if (o.type === 'assistant' && o.message && cur) {
        if (cur.bucket) foldAssistant(cur.bucket, o.message);
        const u = o.message.usage || {}; const c = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        for (const b of o.message.content || []) if (b.type === 'tool_use') {
          const name = b.name.startsWith('mcp__') ? 'mcp:' + b.name.replace(/^mcp__[^_]+__/, '') : b.name; cur.tools[name] = (cur.tools[name] || 0) + 1;
          if (b.name.startsWith('mcp__kora') || (b.name === 'Bash' && /kora graph/.test(String(b.input?.command || '')))) cur.graphCalls++;
          const short = b.name === 'Bash' ? String(b.input?.command || '').slice(0, 70) : b.name === 'Read' ? path.basename(String(b.input?.file_path || '')) + (b.input?.offset != null || b.input?.limit != null ? ' [range]' : '') : (b.input?.pattern || b.input?.query || b.input?.file_path || '');
          log(`    [${fmtTokens(c).padStart(5)} ctx] ${name} ${short}`);
        }
      } else if (o.type === 'result' && cur) {
        result.sessionId = o.session_id || result.sessionId;
        const total = o.total_cost_usd || 0;
        // total_cost_usd may be cumulative for the session or per turn; treat monotonic growth as cumulative.
        cur.costUsd = total; cur.costDelta = total >= lastCumulative ? total - lastCumulative : total; lastCumulative = Math.max(lastCumulative, total);
        cur.numTurns = o.num_turns || 0; answers[cur.task] = String(o.result || ''); if (o.is_error) cur.error = String(o.result || o.subtype || 'error');
        if (resolveTurn) { const r = resolveTurn; resolveTurn = null; r(); }
      }
    }
  });
  const exited = new Promise<number>((res) => child.on('exit', (code) => res(code ?? 1)));
  for (const task of opts.tasks) {
    log(`\n  ▶ ${task.id} / ${condition}`);
    cur = { task: task.id, costUsd: 0, costDelta: 0, durationMs: 0, numTurns: 0, error: null, tools: {}, graphCalls: 0, bucket: emptyBucket(), startedAt: Date.now() };
    const t1 = Date.now();
    const done = new Promise<void>((r) => { resolveTurn = r; });
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: task.prompt }] } }) + '\n');
    const timeout = new Promise<void>((r) => setTimeout(r, 15 * 60 * 1000));
    await Promise.race([done, timeout, exited.then(() => undefined)]);
    cur.durationMs = Date.now() - t1; cur.answer = answers[task.id] || ''; turns.push(cur);
    log(`    done: +${fmtUsd(cur.costDelta)} (cum ${fmtUsd(cur.costUsd)}) ${Math.round(cur.durationMs / 1000)}s graph ${cur.graphCalls}${cur.error ? ' ERROR ' + cur.error.slice(0, 80) : ''}`);
    if (child.exitCode !== null) { log('    (process exited early)'); break; }
  }
  child.stdin.end();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 30000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  result.durationMs = Date.now() - t0;
  const last = turns[turns.length - 1]; result.costUsd = last ? Math.max(last.costUsd, turns.reduce((a, t) => a + t.costDelta, 0)) : 0;
  const dir = path.join(opts.outDir, 'sessions'); fs.mkdirSync(dir, { recursive: true });
  const stemS = `${condition}${opts.repeat ? '.r' + opts.repeat : ''}`;
  fs.writeFileSync(path.join(dir, `${stemS}.stream.jsonl`), raw.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, `${stemS}.answers.md`), Object.entries(answers).map(([k, v]) => `## ${k}\n\n${v}\n`).join('\n'));
  if (stderr.trim()) fs.writeFileSync(path.join(dir, `${stemS}.stderr.txt`), stderr);
  if (result.sessionId) {
    const projects = path.join(os.homedir(), '.claude', 'projects');
    try { for (const d of fs.readdirSync(projects)) { const f = path.join(projects, d, `${result.sessionId}.jsonl`); if (fs.existsSync(f)) { result.transcript = f; break; } } } catch { /* none */ }
    if (result.transcript) { try { const tree = parseSessionTree(result.transcript); result.ledger = summarize(tree.main); result.context = tree.context; result.toolClasses = tree.toolCounts; } catch (e: any) { log(`  ledger parse failed: ${e.message}`); } }
  }
  // Per-turn metrics rows (one RunMetrics per prompt, task = the turn id) so the mixed session lands in the same
  // scoreboard as the single tasks. Injection telemetry is attributed per turn by time window (the session id is
  // shared by every turn).
  const rep = opts.repeat ?? 0;
  const allInj = condition === 'baseline' ? [] : injectionsFor(result.sessionId, t0);
  const diff = copyDiff(cwd);
  result.metrics = turns.map((t, i) => {
    const task = opts.tasks.find((x) => x.id === t.task)!;
    const b = t.bucket || emptyBucket();
    const end = i + 1 < turns.length ? turns[i + 1].startedAt! : Number.MAX_SAFE_INTEGER;
    const inj = foldInjections(allInj.filter((r: InjectRecordLite) => Date.parse(r.ts) >= (t.startedAt || 0) - 1000 && Date.parse(r.ts) < end));
    const verdict = judge(task, t.answer || '', diff);
    return {
      schema: METRICS_SCHEMA, suite: opts.suite?.name || 'adhoc', task: t.task, kind: task.kind, regime: task.regime || 'indexed', condition, repeat: rep,
      model: opts.model, effort: opts.effort, sessionId: result.sessionId, startedAt: new Date(t.startedAt || t0).toISOString(),
      input: b.input, output: b.output, cacheRead: b.cacheRead, cacheWrite: b.cacheWrite, cost: t.costDelta,
      // only the session's FIRST turn carries the cold-prefix write; later turns are steady by construction
      firstCallCacheWrite: i === 0 ? Math.max(0, b.firstCallCacheWrite) : 0, firstCallCacheRead: i === 0 ? Math.max(0, b.firstCallCacheRead) : 0, steadyCost: i === 0 ? steadyCostOf(t.costDelta, b.firstCallCacheWrite, opts.model) : t.costDelta,
      turns: b.apiCalls, toolCalls: b.tools, wallClock: t.durationMs,
      ...inj, fellBackToGrep: inj.injections > 0 && b.searched ? 1 : 0, precision: { noRead: 0, match: 0, other: 0 },
      success: verdict.success && !t.error, successDetail: t.error ? [`error: ${t.error.slice(0, 80)}`, ...verdict.detail] : verdict.detail, error: t.error,
    } as RunMetrics;
  });
  fs.writeFileSync(path.join(dir, `${condition}${rep ? '.r' + rep : ''}.json`), JSON.stringify({ ...result, turns: turns.map(({ bucket: _b, ...t }) => t) }, null, 2));
  fs.writeFileSync(path.join(dir, `${condition}${rep ? '.r' + rep : ''}.metrics.json`), JSON.stringify(result.metrics, null, 2));
  return result;
}

export function sessionReport(results: SessionResult[]): string {
  const L: string[] = [];
  const base = results.find((r) => r.condition === 'baseline');
  L.push('| condition | session cost | Δ | context Σ | api calls | reads | greps | graph | turns errored | time |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of results) {
    const tc = r.toolClasses || {}; const d = base && r !== base && base.costUsd ? `${Math.round((1 - r.costUsd / base.costUsd) * 100)}%` : '';
    L.push(`| ${r.condition} | ${fmtUsd(r.costUsd)} | ${d} | ${fmtTokens(r.context)} | ${r.ledger?.apiCalls ?? ''} | ${tc.read ?? ''} | ${(tc.grep ?? 0) + (tc.glob ?? 0)} | ${tc.graph ?? r.turns.reduce((a, t) => a + t.graphCalls, 0)} | ${r.turns.filter((t) => t.error).length} | ${Math.round(r.durationMs / 1000)}s |`);
  }
  L.push('', '| turn | ' + results.map((r) => `${r.condition} cost`).join(' | ') + ' | ' + results.map((r) => `${r.condition} tools`).join(' | ') + ' |', '|---|' + results.map(() => '---:').join('|') + '|' + results.map(() => '---').join('|') + '|');
  const ids = results[0]?.turns.map((t) => t.task) ?? [];
  for (const id of ids) {
    const cells = results.map((r) => { const t = r.turns.find((x) => x.task === id); return t ? fmtUsd(t.costDelta) : ''; });
    const tools = results.map((r) => { const t = r.turns.find((x) => x.task === id); return t ? Object.entries(t.tools).map(([k, v]) => `${k}×${v}`).join(' ') : ''; });
    L.push(`| ${id} | ${cells.join(' | ')} | ${tools.join(' | ')} |`);
  }
  if (base) { const n = results.find((r) => r.condition === 'kora'); if (n && base.costUsd) L.push('', `**Mixed session:** plain ${fmtUsd(base.costUsd)} → kora ${fmtUsd(n.costUsd)} (${Math.round((1 - n.costUsd / base.costUsd) * 100)}% ${n.costUsd <= base.costUsd ? 'less' : 'MORE'}).`); }
  return L.join('\n');
}
