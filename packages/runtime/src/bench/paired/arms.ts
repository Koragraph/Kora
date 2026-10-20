// Arms of the paired benchmark. An arm decides everything that differs between conditions: what is installed in the
// repo copy, which flags and environment `claude` gets. Everything else (model, effort, prompt, time limit, fresh
// repo copy, isolated environment, grading) is the harness's and identical for every arm.
//
//   plain  — Claude Code as a user without Kora runs it: no hooks, no rulebook, no MCP servers, no graph.
//   kora   — the repo copy prepared exactly as a Kora pane would be (enforce install + prepare: hooks, rulebook block,
//            strict MCP), with the repo indexed in an isolated graph store, per-prompt declaration injection on.
//
// Adding a competitor (GitNexus, Graphify, codegraph, ...): see docs/bench/PAIRED-HARNESS.md; `mcpArm()` below
// turns an MCP server command into an arm in a few lines.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { Arm, ArmContext, ArmPlan } from './types';
import { foldInjections, injectionsFor } from '../metrics';

// ---------------------------------------------------------------------------------------------------------------
// the environment every arm starts from

const CLAUDE_SESSION_VARS = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_VERSION$|CLAUDE_EFFORT$|CLAUDE_PID$)/;

/** A directory is a Kora shim directory when its `claude` (or grep/rg/find) is the managed shim script. */
export function isShimDir(dir: string): boolean {
  for (const name of ['claude', 'grep', 'rg', 'find', 'codex']) {
    try {
      const head = fs.readFileSync(path.join(dir, name), 'utf8').slice(0, 200);
      if (/kora shim/i.test(head)) return true;
    } catch { /* not there */ }
  }
  return false;
}

export function pathWithoutShims(p: string | undefined): string {
  return (p || '').split(path.delimiter).filter((d) => d && !isShimDir(d)).join(path.delimiter);
}

/** The real `claude` binary: $KORA_BENCH_CLAUDE, else the first one on PATH that is not a Kora shim. */
export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KORA_BENCH_CLAUDE) return env.KORA_BENCH_CLAUDE;
  for (const d of (env.PATH || '').split(path.delimiter)) {
    if (!d || isShimDir(d)) continue;
    const f = path.join(d, 'claude');
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
  }
  throw new Error('no real `claude` binary on PATH (only Kora shims); set KORA_BENCH_CLAUDE');
}

/**
 * The base environment of every `claude` the harness starts. Kora variables are never removed: the ones that could
 * reach a live daemon are OVERRIDDEN with isolated values (KORA_HOME, KORA_SOCKET_PATH, an empty KORA_PANE_ID,
 * KORAGRAPH_*). Claude Code's own session variables (the parent session's id, messaging socket) are dropped so the
 * child is a fresh top-level session, and the Kora PATH shims are taken off PATH so the plain arm is plain.
 */
export function buildBaseEnv(opts: { koraHome: string; koraGraphHome: string; base?: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(opts.base || process.env) };
  for (const k of Object.keys(env)) if (CLAUDE_SESSION_VARS.test(k)) delete env[k];
  env.PATH = pathWithoutShims(env.PATH);
  Object.assign(env, {
    KORA_HOME: opts.koraHome,
    KORA_SOCKET_PATH: path.join(opts.koraHome, 'no-server.sock'),
    KORA_PANE_ID: '',
    KORAGRAPH_HOME: opts.koraGraphHome,
    KORAGRAPH_DB: path.join(opts.koraGraphHome, 'graph.db'),
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  });
  return env;
}

/** Context that would leak into a repo copy: a CLAUDE.md / AGENTS.md / .claude above it (Claude Code reads every
 *  CLAUDE.md up the directory tree; a ~/CLAUDE.md contaminated an earlier bench). Returns the offending paths. */
export function parentContextFiles(workdir: string): string[] {
  const found: string[] = [];
  let dir = path.dirname(path.resolve(workdir));
  for (;;) {
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude']) {
      const f = path.join(dir, name);
      if (fs.existsSync(f)) found.push(f);
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const userMemory = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  if (fs.existsSync(userMemory)) found.push(userMemory);
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// plain

export const plainArm: Arm = {
  id: 'plain',
  label: 'Plain Claude Code (no hooks, no rulebook, no MCP servers, no graph)',
  async prepare(): Promise<ArmPlan> {
    return { args: [], env: {}, notes: ['no hooks, no rulebook, no MCP'] };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// kora

function safeName(s: string): string { return s.replace(/[^A-Za-z0-9._-]+/g, '_'); }

export function createKoraArm(opts: { binPath?: string } = {}): Arm {
  const runtimeRoot = path.resolve(__dirname, '..', '..', '..');
  const binPath = opts.binPath || path.join(runtimeRoot, 'bin', 'kora.js');
  const ingestChild = path.join(__dirname, 'ingest-child.js');
  return {
    id: 'kora',
    label: 'Kora (hooks + rulebook + indexed code graph, per-prompt declaration injection)',
    async prepare(ctx: ArmContext): Promise<ArmPlan> {
      const t0 = Date.now();
      const notes: string[] = [];
      // In-process Kora code (enforcer, graph service) reads these at call time: point them at this arm's isolated home.
      // KORA_TAKEOVER_HOME=0 keeps the legacy-product takeover from touching the real ~/.claude.
      Object.assign(process.env, {
        KORA_HOME: ctx.koraHome,
        KORAGRAPH_HOME: ctx.koraGraphHome,
        KORAGRAPH_DB: path.join(ctx.koraGraphHome, 'graph.db'),
        KORA_SOCKET_PATH: path.join(ctx.koraHome, 'no-server.sock'),
        KORA_TAKEOVER_HOME: '0',
      });
      fs.mkdirSync(ctx.koraHome, { recursive: true });
      fs.mkdirSync(ctx.koraGraphHome, { recursive: true });

      // One index per start state (same path, same deterministic HEAD → it stays valid for every repetition).
      const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.workdir, encoding: 'utf8' }).stdout.trim();
      // next to this arm's own graph store (`<root>/arms/<arm id>/`), so `kora@haiku` never trusts `kora`'s index
      const marker = path.join(path.dirname(ctx.koraGraphHome), 'indexed', safeName(ctx.stateKey) + '.json');
      let cached: { sha?: string; nodes?: number } | null = null;
      try { cached = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { cached = null; }
      if (!cached || cached.sha !== sha) {
        ctx.log(`  kora: indexing ${ctx.stateKey} (once per start state)`);
        const r = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
          const child = spawn(process.execPath, ['--liftoff-only', ingestChild, ctx.workdir], { cwd: ctx.workdir, env: { ...ctx.baseEnv, KORA_TAKEOVER_HOME: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
          let out = ''; let err = '';
          const killer = setTimeout(() => child.kill('SIGKILL'), 10 * 60 * 1000);
          child.stdout.on('data', (d) => { out += d; });
          child.stderr.on('data', (d) => { err += d; });
          child.on('exit', (code) => { clearTimeout(killer); resolve({ code, out, err }); });
        });
        if (r.code !== 0) throw new Error(`kora arm: indexing ${ctx.stateKey} failed (exit ${r.code}): ${r.err.slice(-400)}`);
        let info: any = {};
        try { info = JSON.parse(r.out.trim().split('\n').pop() || '{}'); } catch { /* keep {} */ }
        if (!info.indexed) throw new Error(`kora arm: the graph does not report ${ctx.stateKey} as indexed after ingest: ${r.out.slice(-200)}`);
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, JSON.stringify({ sha, nodes: info.nodes, edges: info.edges, at: new Date().toISOString() }));
        notes.push(`indexed ${ctx.stateKey}: ${info.nodes} nodes, ${info.edges} edges`);
      } else notes.push(`index for ${ctx.stateKey} reused (${cached.nodes} nodes)`);

      // The copy as a pane would get it: hooks in .claude/settings.local.json, the rulebook block in CLAUDE.md, strict MCP.
      const { createEnforcer } = require('../../enforce') as typeof import('../../enforce');
      const enforcer = createEnforcer();
      await enforcer.install({ agent: 'claude', cwd: ctx.workdir, replaceKoragraphHooks: true } as any);
      const env: Record<string, string> = {
        ...(Object.fromEntries(Object.entries(ctx.baseEnv).filter(([, v]) => typeof v === 'string')) as Record<string, string>),
        KORA_ENV: '1', KORA_BIN: binPath, KORA_AGENT: 'claude', KORA_REPO_ROOT: ctx.workdir, KORA_PANE_ID: 'bench',
        // the hook lane injects declarations itself (the SDK chat lane sets KORA_INJECT_OWNER=driver instead)
        KORA_INJECT_OWNER: 'hook',
      };
      const plan = await enforcer.prepare({ agent: 'claude', cwd: ctx.workdir, paneId: 'bench', socketPath: env.KORA_SOCKET_PATH, binPath, command: 'claude', args: [], env } as any);
      notes.push(...(plan.notes || []));
      return { args: plan.args || [], env: { ...(plan.env || {}), KORA_ENV: '1', KORA_BIN: binPath, KORA_AGENT: 'claude', KORA_REPO_ROOT: ctx.workdir, KORA_PANE_ID: 'bench', KORA_INJECT_OWNER: 'hook', KORA_TAKEOVER_HOME: '0' }, notes, setupMs: Date.now() - t0 };
    },
    async collect(ctx: ArmContext, session) {
      const rows = session.sessionIds.flatMap((id) => injectionsFor(id, session.startedAt, path.join(ctx.koraHome, 'inject.jsonl')));
      return { ...foldInjections(rows) };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// competitor arms from an MCP server

export interface McpArmSpec {
  id: string;
  label: string;
  /** the MCP server `claude` should talk to */
  server: { command: string; args?: string[]; env?: Record<string, string> };
  /** name under which the server is registered in `claude` (tool names become mcp__<name>__*) */
  serverName?: string;
  /** appended to the system prompt: the competitor's own recommended instructions, verbatim */
  rules?: string;
  /** written into CLAUDE.md in the repo copy (the competitor's own installer does this) */
  claudeMd?: string;
  /** a command run in the repo copy before every run (indexing). The copy is fresh, so this runs every time; its wall time is recorded. */
  index?: { command: string; args?: string[]; timeoutSec?: number };
  /** extra environment for `claude` */
  env?: Record<string, string>;
}

export function mcpArm(spec: McpArmSpec): Arm {
  return {
    id: spec.id,
    label: spec.label,
    async prepare(ctx: ArmContext): Promise<ArmPlan> {
      const t0 = Date.now();
      const notes: string[] = [];
      if (spec.index) {
        const r = spawnSync(spec.index.command, spec.index.args || [], { cwd: ctx.workdir, env: ctx.baseEnv, encoding: 'utf8', timeout: (spec.index.timeoutSec || 600) * 1000 });
        if (r.status !== 0) throw new Error(`${spec.id}: index command failed (exit ${r.status}): ${(r.stderr || r.stdout || '').slice(-400)}`);
        notes.push(`indexed with ${spec.index.command} in ${Date.now() - t0} ms`);
      }
      const cfg = path.join(ctx.runDir, `${spec.id}-mcp.json`);
      fs.mkdirSync(ctx.runDir, { recursive: true });
      fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { [spec.serverName || spec.id]: { command: spec.server.command, args: spec.server.args || [], env: spec.server.env || {} } } }, null, 2));
      if (spec.claudeMd) fs.writeFileSync(path.join(ctx.workdir, 'CLAUDE.md'), spec.claudeMd);
      const args = ['--strict-mcp-config', '--mcp-config', cfg];
      if (spec.rules) args.push('--append-system-prompt', spec.rules);
      return { args, env: { ...(spec.env || {}) }, notes, setupMs: Date.now() - t0 };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// registry

export function builtinArms(opts: { binPath?: string } = {}): Record<string, Arm> {
  const kora = createKoraArm(opts);
  return { plain: plainArm, kora };
}

export const MODEL_ALIASES: Record<string, string> = { sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', opus: 'claude-opus-5-5' };

export const modelAlias = (m: string): string => MODEL_ALIASES[m] || m;

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The same arm on another model (and effort): id `<arm>@<model as written>[:<effort>]`, its own KORA_HOME (the id
 *  names it), the base arm's repo copy and graph store (one index per start state for every variant). */
export function withModel(arm: Arm, model: string, effort?: string): Arm {
  const resolved = modelAlias(model);
  return {
    ...arm, id: `${arm.id}@${model}${effort ? ':' + effort : ''}`, label: `${arm.label}, on ${resolved}${effort ? ` at ${effort} effort` : ''}`,
    model: resolved, ...(effort ? { effort } : {}), home: arm.home || arm.id,
  };
}

/** An arm id from the command line: `plain`, or `plain@haiku` / `kora@claude-sonnet-5-5` (that arm on that model), or
 *  `kora@opus:low` (on that model at that effort). */
export function resolveArm(id: string, available: Record<string, Arm>): Arm {
  if (available[id]) return available[id];
  const at = id.indexOf('@');
  const base = at > 0 ? available[id.slice(0, at)] : undefined;
  const [model, effort] = (at > 0 ? id.slice(at + 1) : '').split(':');
  if (!base || !model) throw new Error(`unknown arm "${id}" (have ${Object.keys(available).join(', ')}; add @<model> to run one on another model, e.g. plain@haiku, or @<model>:<effort>, e.g. kora@opus:low)`);
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new Error(`arm "${id}": effort must be one of ${EFFORTS.join(', ')}`);
  return withModel(base, model, effort);
}

/** Load an arm from a module: `export default arm`, `export const arm`, or a function returning an arm. */
export async function loadArmFile(file: string): Promise<Arm> {
  // a real dynamic import (tsc compiles `import()` to require() in this CommonJS package, which cannot load an .mjs)
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;
  const mod: any = await dynamicImport(pathToFileURL(path.resolve(file)).href);
  let arm = mod.default ?? mod.arm;
  if (typeof arm === 'function') arm = await arm();
  if (!arm || typeof arm.id !== 'string' || typeof arm.prepare !== 'function') throw new Error(`${file} must export an arm: { id, label, prepare(ctx) }`);
  return arm as Arm;
}
