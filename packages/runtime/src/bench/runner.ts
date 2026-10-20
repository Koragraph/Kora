// Bench: the same task, run headless with `claude -p`, under two conditions on two identical copies of a repo:
//   baseline — no hooks, no instruction files, no MCP servers (--strict-mcp-config). Plain Claude Code.
//   kora   — the copy prepared exactly as a pane would be: enforce install + prepare() args/env.
// Spend is authoritative (claude's own total_cost_usd and usage). The ledger's savings model is reported
// beside it so the counterfactual can be CALIBRATED against a real A/B, not trusted blindly.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { winCommand } from '../util/win-exec';
import { spawn, spawnSync } from 'node:child_process';
import { parseTranscript, parseSessionTree, summarize, LedgerSummary, fmtTokens, fmtUsd } from '../ledger/transcript';
import { judge, type BenchTask, type BenchSuite, type Regime } from './tasks';
import { RunMetrics, METRICS_SCHEMA, emptyBucket, foldAssistant, injectionsFor, foldInjections, TurnBucket, steadyCostOf, usageFromTranscript } from './metrics';

export type Condition = 'baseline' | 'kora' | 'kora-nomcp' | 'kora-nohooks';
export interface RunResult {
  task: string; condition: Condition; model: string; effort: string; sessionId: string | null; costUsd: number; numTurns: number; durationMs: number;
  usage: { input: number; cacheWrite: number; cacheRead: number; output: number; context: number };
  tools: Record<string, number>; graphCalls: number; denials: number; answer: string; transcript: string | null; ledger: LedgerSummary | null; error: string | null;
}

/**
 * The env of a bench session: this process's, minus what marks it as running inside an agent. Run from a Kora thread,
 * the thread's KORA_INJECT_OWNER=driver told the kora arm's prompt hook to stand down, so that arm ran with no
 * injection at all and the A/B measured nothing; its KORA_ENV sent the BASELINE through Kora's claude shim, which then
 * exited with no output (found 2026-10-20). A user's own settings (KORA_HOME, KORA_MCP, …) stay, and so does
 * KORA_AGENT: it is the marker that keeps Kora's privileged daemon calls away from agents, and a bench started by an
 * agent must not start sessions without it (only Kora's own code reads it, so a plain baseline is unaffected).
 */
const SESSION_ENV = /^(CLAUDECODE$|CLAUDE_CODE_|KORA_(ENV|PANE_ID|INJECT_OWNER|CALLER_KEY|SOCKET_PATH|BIN|NODE|REPO_ROOT|SHIMS_DIR|SHIM_ACTIVE|UI_PORT|BLOBS_ROOT|PRELAUNCH)$)/;
export function stripEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) { if (v === undefined) continue; if (SESSION_ENV.test(k)) continue; env[k] = v; }
  return env;
}

export function prepareCopy(repo: string, outDir: string, condition: Condition, opts: { sha?: string; regime?: Regime } = {}): string {
  const regime = opts.regime || 'indexed';
  // A COLD copy carries a basename the graph has never seen, so nothing name-matches it to the pinned repo's index.
  // …and a basename no earlier run used: the SessionStart hook auto-indexes an unindexed checkout in the background,
  // so a previous cold copy's row would name-match the next one (measured: 'KoragraphMCP-cold' came back indexed).
  const dst = path.join(outDir, 'repos', condition, path.basename(repo) + (regime === 'cold' ? `-cold-${Date.now().toString(36)}` : ''));
  releaseCopy(dst);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (regime === 'cold') {
    // .claude is COPIED (a git-tracked deletion would make live-freshness archive those nodes in the real store);
    // the baseline neutralises project hooks with --setting-sources user instead of deleting them.
    const r = spawnSync('rsync', ['-a', '--exclude', 'node_modules', '--exclude', 'CLAUDE.local.md', '--exclude', '.mcp.json', `${repo}/`, `${dst}/`], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('rsync failed');
  } else {
    // Indexed and dirty runs work in a standalone clone at the pinned commit: both arms get the same tracked files, and
    // neither inherits the source checkout's own Kora hooks (a linked worktree did: the baseline ran Kora's deny hook
    // and the kora arm ran its hooks twice, found 2026-10-20). The kora arm's clone is indexed in cli/commands/bench.ts.
    const r = spawnSync('git', ['clone', '-q', '--no-hardlinks', repo, dst], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) throw new Error(`git clone ${repo} failed`);
  }
  resetCopy(dst, opts.sha);
  if (condition === 'baseline') neutralizeCopy(dst);
  // COLD means the graph has never seen this checkout: the store matches repos by git identity (origin URL) before
  // basename, so the remote must go too or the copy inherits the pinned repo's index (measured: the first cold run
  // injected 2 declarations).
  if (regime === 'cold') { spawnSync('git', ['remote', 'remove', 'origin'], { cwd: dst, stdio: 'ignore' }); spawnSync('git', ['remote', 'add', 'origin', `https://cold.invalid/${path.basename(dst)}-${Date.now()}.git`], { cwd: dst, stdio: 'ignore' }); }
  return dst;
}
/** Remove a bench copy (a clone or an rsync copy). */
export function releaseCopy(dst: string): void { fs.rmSync(dst, { recursive: true, force: true }); }
/**
 * The BASELINE is plain Claude Code as a user of this repository runs it: the repo's own CLAUDE.md / AGENTS.md (minus
 * any kora managed block), its own permissions, NO hooks, no MCP. Measured (Phase 0, first attempt): running the
 * baseline with `--setting-sources user` silently dropped the project CLAUDE.md — a 96 KB file here — so the kora
 * arm carried ~39k tokens per call that the baseline never saw, and every comparison was wrong by that much.
 */
export function neutralizeCopy(dst: string): void {
  const { removeBlock } = require('../enforce/agentsmd');
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) { const p = path.join(dst, f); if (fs.existsSync(p)) { try { removeBlock(p); } catch { /* no block */ } } }
  for (const f of ['.claude/settings.json', '.claude/settings.local.json']) {
    const p = path.join(dst, f); if (!fs.existsSync(p)) continue;
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); if (j && typeof j === 'object' && 'hooks' in j) { delete j.hooks; fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n'); } } catch { /* leave it */ }
  }
}
/** Back to a clean tree at the pinned SHA (between repeats; edits from a previous run must not leak). Keeps the
 *  enforcement files a prepare() installed (CLAUDE.md / AGENTS.md / .claude). */
export function resetCopy(dst: string, sha?: string): void {
  if (sha) spawnSync('git', ['checkout', '-q', '--detach', sha], { cwd: dst, stdio: 'ignore' });
  spawnSync('git', ['checkout', '-q', '--', '.'], { cwd: dst, stdio: 'ignore' });
  spawnSync('git', ['clean', '-fdq', '-e', '.claude', '-e', 'CLAUDE.md', '-e', 'AGENTS.md', '-e', 'GEMINI.md'], { cwd: dst, stdio: 'ignore' });
  // git index stat info is stale after a copy; refresh so `git status` (freshness) does not see a phantom dirty tree
  spawnSync('git', ['update-index', '--refresh', '-q'], { cwd: dst, stdio: 'ignore' });
}
/** The DIRTY regime: uncommitted edits to source files the graph has indexed — the case where injection used to be
 *  silently dead (fresh:true blew the hook budget). A trailing comment per file: content changes, structure doesn't. */
export function dirtyCopy(dst: string, n = 8): string[] {
  const ls = spawnSync('git', ['ls-files', '--', '*.js', '*.ts', '*.py'], { cwd: dst, encoding: 'utf8' });
  const files = (ls.stdout || '').split('\n').filter((f) => f && /^src\//.test(f)).slice(0, n);
  for (const f of files) { try { fs.appendFileSync(path.join(dst, f), `\n// bench: dirty working tree ${Date.now()}\n`); } catch { /* skip */ } }
  return files;
}
export function copyDiff(dst: string): { files: string[]; text: string } {
  const names = spawnSync('git', ['diff', '--name-only'], { cwd: dst, encoding: 'utf8' });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-x', '.claude', '-x', 'CLAUDE.md', '-x', 'AGENTS.md', '-x', 'GEMINI.md'], { cwd: dst, encoding: 'utf8' });
  const text = spawnSync('git', ['diff'], { cwd: dst, encoding: 'utf8' }).stdout || '';
  const files = [...(names.stdout || '').split('\n'), ...(untracked.stdout || '').split('\n')].map((x) => x.trim()).filter(Boolean);
  let extra = '';
  for (const f of (untracked.stdout || '').split('\n').map((x) => x.trim()).filter(Boolean)) { try { extra += `\n+++ ${f}\n` + fs.readFileSync(path.join(dst, f), 'utf8').slice(0, 20000); } catch { /* skip */ } }
  return { files, text: text + extra };
}

export async function runOne(opts: { task: BenchTask; condition: Condition; cwd: string; model: string; effort: string; maxTurns: number; budgetUsd: number; binPath: string; outDir: string; log: (s: string) => void; suite?: BenchSuite; repeat?: number }): Promise<RunResult & { metrics: RunMetrics }> {
  const { task, condition, cwd, model, effort, log } = opts;
  const env = stripEnv();
  const startedAt = Date.now();
  const bucket: TurnBucket = emptyBucket();
  let args = ['-p', task.prompt, '--model', model, '--effort', effort, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--max-turns', String(opts.maxTurns), '--max-budget-usd', String(opts.budgetUsd), '--strict-mcp-config'];
  if (condition === 'baseline') {
    const empty = path.join(opts.outDir, 'empty-mcp.json'); fs.writeFileSync(empty, '{"mcpServers":{}}');
    // default setting sources: the project CLAUDE.md loads exactly as it does for a real user (see neutralizeCopy)
    args.push('--mcp-config', empty);
    neutralizeCopy(cwd);
  } else {
    const { createEnforcer } = require('../enforce');
    const enforcer = createEnforcer();
    await enforcer.install({ agent: 'claude', cwd, replaceKoragraphHooks: true });
    Object.assign(env, { KORA_ENV: '1', KORA_BIN: opts.binPath, KORA_AGENT: 'claude', KORA_REPO_ROOT: cwd, KORA_SOCKET_PATH: path.join(opts.outDir, 'no-server.sock') });
    const plan = await enforcer.prepare({ agent: 'claude', cwd, paneId: 'bench', socketPath: env.KORA_SOCKET_PATH, binPath: opts.binPath, command: 'claude', args: [], env });
    Object.assign(env, plan.env || {});
    let extra = plan.args || [];
    if (condition === 'kora-nomcp') { const i = extra.indexOf('--mcp-config'); if (i >= 0) extra = [...extra.slice(0, i), ...extra.slice(i + 2)]; const empty = path.join(opts.outDir, 'empty-mcp.json'); fs.writeFileSync(empty, '{"mcpServers":{}}'); extra.push('--mcp-config', empty); }
    if (condition === 'kora-nohooks') { try { fs.rmSync(path.join(cwd, '.claude', 'settings.json')); } catch { /* none */ } }
    args = [...args, ...extra];
    log(`  prepare: ${(plan.notes || []).join(' · ')}`);
  }
  const t0 = Date.now();
  const raw: string[] = [];
  const result: RunResult = { task: task.id, condition, model, effort, sessionId: null, costUsd: 0, numTurns: 0, durationMs: 0, usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, context: 0 }, tools: {}, graphCalls: 0, denials: 0, answer: '', transcript: null, ledger: null, error: null };
  await new Promise<void>((resolve) => {
    const cli = winCommand('claude', args, env);
    const child = spawn(cli.command, cli.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: cli.windowsVerbatimArguments });
    let buf = '';
    const killer = setTimeout(() => { result.error = 'timeout'; child.kill('SIGKILL'); }, 20 * 60 * 1000);
    child.stdout.on('data', (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; raw.push(line);
        let o: any; try { o = JSON.parse(line); } catch { continue; }
        if (o.type === 'assistant' && o.message) {
          foldAssistant(bucket, o.message);
          const u = o.message.usage || {};
          const c = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
          for (const b of o.message.content || []) if (b.type === 'tool_use') {
            const name = b.name.startsWith('mcp__') ? 'mcp:' + b.name.replace(/^mcp__[^_]+__/, '') : b.name;
            result.tools[name] = (result.tools[name] || 0) + 1;
            if (b.name.startsWith('mcp__kora') || (b.name === 'Bash' && /kora graph/.test(String(b.input?.command || '')))) result.graphCalls++;
            const short = b.name === 'Bash' ? String(b.input?.command || '').slice(0, 70) : b.name === 'Read' ? path.basename(String(b.input?.file_path || '')) : b.name.startsWith('mcp__') ? JSON.stringify(b.input).slice(0, 60) : (b.input?.pattern || b.input?.query || '');
            log(`  [${fmtTokens(c).padStart(5)} ctx] ${name} ${short}`);
          }
        } else if (o.type === 'user' && Array.isArray(o.message?.content)) {
          for (const b of o.message.content) if (b.type === 'tool_result') { const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content); if (/permissionDecision|denied|not allowed|blocked by .*hook|PreToolUse hook/i.test(t)) result.denials++; }
        } else if (o.type === 'result') {
          result.sessionId = o.session_id || null; result.costUsd = o.total_cost_usd || 0; result.numTurns = o.num_turns || 0; result.answer = String(o.result || '');
          const u = o.usage || {}; result.usage = { input: u.input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0, context: 0 };
          if (o.is_error) result.error = String(o.result || o.subtype || 'error');
        }
      }
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('exit', (code) => { clearTimeout(killer); if (code !== 0 && !result.error) result.error = `exit ${code}: ${err.slice(-400)}`; resolve(); });
  });
  result.durationMs = Date.now() - t0;
  const dir = path.join(opts.outDir, 'runs', task.id); fs.mkdirSync(dir, { recursive: true });
  const stem = `${condition}${opts.repeat ? '.r' + opts.repeat : ''}`; // every repeat keeps its own stream/answer (they used to overwrite)
  fs.writeFileSync(path.join(dir, `${stem}.stream.jsonl`), raw.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, `${stem}.answer.md`), result.answer);
  // The transcript file is where the ledger's per-call context and file references live.
  if (result.sessionId) {
    const projects = path.join(os.homedir(), '.claude', 'projects');
    try { for (const d of fs.readdirSync(projects)) { const f = path.join(projects, d, `${result.sessionId}.jsonl`); if (fs.existsSync(f)) { result.transcript = f; break; } } } catch { /* none */ }
    if (result.transcript) {
      try {
        const tree = parseSessionTree(result.transcript);
        result.ledger = summarize(tree.main); result.usage.context = tree.context; // main + subagents
        (result as any).toolClasses = tree.toolCounts; (result as any).subagents = tree.subagents.length;
      } catch (e: any) { log(`  ledger parse failed: ${e.message}`); }
    }
  }
  const diff = copyDiff(cwd);
  const verdict = judge(task, result.answer, diff);
  // Session totals: Claude's own `result` usage (authoritative — what total_cost_usd was computed from). First-call
  // cache split: the transcript (its first step's usage is the API call's cache accounting).
  if (result.usage && (result.usage.cacheRead || result.usage.cacheWrite || result.usage.output)) { bucket.input = result.usage.input; bucket.output = result.usage.output; bucket.cacheRead = result.usage.cacheRead; bucket.cacheWrite = result.usage.cacheWrite; }
  const tu = usageFromTranscript(result.transcript);
  if (tu) { bucket.apiCalls = tu.apiCalls; bucket.firstCallCacheWrite = tu.firstCallCacheWrite; bucket.firstCallCacheRead = tu.firstCallCacheRead; }
  const injRows = condition === 'baseline' ? [] : injectionsFor(result.sessionId, startedAt);
  const inj = foldInjections(injRows);
  // precision@1 proxy: for each injection, the top declaration's file vs what the agent then Read. 'no-read' = answered
  // without opening anything (the injection sufficed), 'match' = read the injected file (a range, presumably),
  // 'other' = read elsewhere (the top hit was not what it needed).
  const readFiles = new Set<string>();
  for (const line of raw) { let o: any; try { o = JSON.parse(line); } catch { continue; } if (o.type === 'assistant') for (const b of o.message?.content || []) if (b.type === 'tool_use' && b.name === 'Read' && b.input?.file_path) readFiles.add(path.relative(cwd, String(b.input.file_path))); }
  const precision = { noRead: 0, match: 0, other: 0 };
  for (const r of injRows) if (r.decision === 'injected') { const tf = (r as any).topFile as string | undefined; if (!readFiles.size) precision.noRead++; else if (tf && [...readFiles].some((f) => f === tf || f.endsWith(tf) || tf.endsWith(f))) precision.match++; else precision.other++; }
  const metrics: RunMetrics = {
    schema: METRICS_SCHEMA, suite: opts.suite?.name || 'adhoc', task: task.id, kind: task.kind, regime: task.regime || 'indexed', condition, repeat: opts.repeat ?? 0,
    model, effort, sessionId: result.sessionId, startedAt: new Date(startedAt).toISOString(),
    input: bucket.input, output: bucket.output, cacheRead: bucket.cacheRead, cacheWrite: bucket.cacheWrite, cost: result.costUsd,
    firstCallCacheWrite: Math.max(0, bucket.firstCallCacheWrite), firstCallCacheRead: Math.max(0, bucket.firstCallCacheRead), steadyCost: steadyCostOf(result.costUsd, bucket.firstCallCacheWrite, model),
    turns: bucket.apiCalls, toolCalls: bucket.tools, wallClock: result.durationMs,
    ...inj, fellBackToGrep: inj.injections > 0 && bucket.searched ? 1 : 0, precision,
    success: verdict.success && !result.error, successDetail: result.error ? [`error: ${result.error.slice(0, 80)}`, ...verdict.detail] : verdict.detail, error: result.error,
  };
  const rep = opts.repeat ?? 0;
  fs.writeFileSync(path.join(dir, `${condition}${rep ? '.r' + rep : ''}.json`), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(dir, `${condition}${rep ? '.r' + rep : ''}.metrics.json`), JSON.stringify(metrics, null, 2));
  if (diff.text) fs.writeFileSync(path.join(dir, `${condition}${rep ? '.r' + rep : ''}.diff`), diff.text);
  return { ...result, metrics };
}

export function report(results: RunResult[]): string {
  const byTask = new Map<string, RunResult[]>();
  for (const r of results) { if (!byTask.has(r.task)) byTask.set(r.task, []); byTask.get(r.task)!.push(r); }
  const L: string[] = [];
  L.push(`| task | condition | cost | Δ cost | context tok (Σ, incl. subagents) | Δ ctx | api calls | reads | greps/globs | graph | denials | time |`);
  L.push(`|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const [task, rs] of byTask) {
    const base = rs.find((r) => r.condition === 'baseline');
    for (const r of rs) {
      const dc = base && r !== base && base.costUsd ? `${Math.round((1 - r.costUsd / base.costUsd) * 100)}%` : '';
      const dx = base && r !== base && base.usage.context ? `${Math.round((1 - r.usage.context / base.usage.context) * 100)}%` : '';
      const tc = (r as any).toolClasses as Record<string, number> | undefined;
      const reads = tc ? tc.read : (r.tools.Read || 0), greps = tc ? tc.grep + tc.glob : (r.tools.Grep || 0) + (r.tools.Glob || 0);
      L.push(`| ${task} | ${r.condition} | ${fmtUsd(r.costUsd)} | ${dc} | ${fmtTokens(r.usage.context)} | ${dx} | ${r.numTurns} | ${reads} | ${greps} | ${r.graphCalls} | ${r.denials} | ${Math.round(r.durationMs / 1000)}s |${r.error ? ` ERROR: ${r.error.slice(0, 80)}` : ''}`);
    }
  }
  const tot = (c: Condition) => results.filter((r) => r.condition === c).reduce((a, r) => a + r.costUsd, 0);
  const b = tot('baseline'), n = tot('kora');
  if (b && n) L.push('', `**Total:** baseline ${fmtUsd(b)} → kora ${fmtUsd(n)} (${Math.round((1 - n / b) * 100)}% less).`);
  return L.join('\n');
}
