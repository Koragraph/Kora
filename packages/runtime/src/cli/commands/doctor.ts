// `kora doctor` — check the whole chain and name a fix for anything wrong. Exit 1 on any ✗.
// Two parts: the health checks a new user trips over (server/health.ts — the same rows Settings → Diagnostics shows),
// then the graph + enforcement chain (enforcer.doctor). `--export [dir]` also writes the redacted diagnostics bundle.
import path from 'node:path';
import type { IO } from '../main';
import { parseArgs } from '../args';
import { createEnforcer } from '../../enforce/index';
import type { HealthDeps, HealthReport } from '../../server/health';

export const summary = 'Check the whole chain and name a fix for anything wrong';
export const usage = `Usage: kora doctor [path] [--json] [--export [dir]] [--quick]

Kora: daemon up + version, Claude Code installed + logged in, OpenCode version, the graph index for [path]
(default: cwd), free disk, the UI port, Swarm provider reachability, local model servers (Ollama / LM Studio).
Chain: node, node-pty, better-sqlite3, graph store, staleness, enforcement per agent, shims, MCP config.
Prints ✓ / ! / ✗ with a fix line under each problem. Exit 1 if anything is ✗.

  --export [dir]  also write a redacted diagnostics bundle (versions, checks, log tails) to dir (default ~/Downloads)
  --quick         skip the Swarm provider probes (no network calls to providers)`;

/** `kora` lives in ~/.local/bin: when that directory is not on PATH the user's next terminal says "command not found". */
function pathHint(): { name: string; ok: boolean; detail: string; fix?: string; optional?: boolean }[] {
  try {
    const os = require('node:os') as typeof import('node:os'); const fs = require('node:fs') as typeof import('node:fs');
    const bin = path.join(os.homedir(), '.local', 'bin');
    const win = process.platform === 'win32';
    const cli = ['kora', 'kora-dev'].find((n) => fs.existsSync(path.join(bin, win ? `${n}.cmd` : n)));
    if (!cli) return [];
    const same = (d: string) => (win ? path.resolve(d).toLowerCase() === bin.toLowerCase() : path.resolve(d) === bin);
    const onPath = (process.env.PATH || '').split(path.delimiter).some((d) => d && same(d));
    // Windows: the user PATH lives in the registry; this PowerShell line appends the folder there (no setx truncation).
    const fix = win
      ? `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${bin}', 'User')   (in PowerShell, then open a new terminal)`
      : `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   (then open a new terminal)`;
    return onPath ? [] : [{ name: 'PATH', ok: false, optional: true, detail: `${bin} holds \`${cli}\` but is not on this shell's PATH, so a new terminal will not find it`, fix }];
  } catch { return []; }
}

/** The CLI's view of the world: the daemon over the socket, Swarm and the graph in-process. */
export function cliHealthDeps(opts: { quick?: boolean } = {}): HealthDeps {
  const { version } = require('../../../package.json') as { version: string };
  const { loadConfig } = require('../../config') as typeof import('../../config');
  const { defaultSocketPath } = require('../../protocol/types') as typeof import('../../protocol/types');
  return {
    version,
    inDaemon: false,
    uiPort: loadConfig().uiPort,
    daemon: async () => {
      const { isSocketAlive } = require('../../server/daemon') as typeof import('../../server/daemon');
      if (!(await isSocketAlive(defaultSocketPath(), 500))) return { running: false, version: null, pid: null, uptimeMs: null };
      try {
        const { callOnce } = require('../../protocol/client') as typeof import('../../protocol/client');
        const r: any = await callOnce('server.ping', {}, undefined, 3000);
        return { running: true, version: r?.version ?? null, pid: r?.pid ?? null, uptimeMs: r?.uptimeMs ?? null };
      } catch (e: any) { return { running: false, version: null, pid: null, uptimeMs: null, error: `the socket does not answer: ${e?.message ?? e}` }; }
    },
    graphStatus: async (cwd) => {
      const { createGraphService } = require('../../graph/index') as typeof import('../../graph/index');
      return createGraphService().status(cwd);
    },
    swarmStatus: async () => {
      const { SwarmSetup } = require('../../server/swarm-setup') as typeof import('../../server/swarm-setup');
      const { SwarmHealth } = require('../../server/swarm-health') as typeof import('../../server/swarm-health');
      const s = new SwarmSetup({ health: new SwarmHealth() });
      if (!opts.quick) {
        const before = await s.getStatus();
        await Promise.allSettled(before.providers.filter((p) => p.enabled && (p.provider === 'zen' || p.hasKey)).map((p) => s.testProvider({ provider: p.provider })));
      }
      return s.getStatus();
    },
  };
}

export async function run(argv: string[], io: IO): Promise<number> {
  const { flags, positional } = parseArgs(argv);
  if (flags.help) { io.out(usage + '\n'); return 0; }
  // `--export` takes an optional dir (parseArgs reads a following word as its value); `--quick` is a plain switch.
  if (typeof flags.quick === 'string') { positional.unshift(flags.quick); flags.quick = true; }
  const cwd = path.resolve(positional[0] || process.cwd());
  const { runHealthChecks, formatHealthReport, agentSummary } = require('../../server/health') as typeof import('../../server/health');
  const report: HealthReport = await runHealthChecks({ cwd }, cliHealthDeps({ quick: !!flags.quick }));
  let { checks } = await createEnforcer().doctor({ cwd });
  // The same unindexed repo used to be reported twice (the health row and the chain's "repo indexed"): keep the health row.
  const graphRow = report.checks.find((c) => c.id === 'graph');
  if (graphRow && graphRow.status !== 'ok') checks = checks.filter((c) => !['repo indexed', 'graph fresh', 'index origin'].includes(c.name));
  if (!report.checks.some((c) => c.id === 'cli-path')) checks = [...checks, ...pathHint()];
  let exported: { path: string; bytes: number } | null = null;
  if (flags.export !== undefined) {
    const { writeDiagnosticsBundle } = require('../../server/diagnostics-bundle') as typeof import('../../server/diagnostics-bundle');
    const { loadConfig } = require('../../config') as typeof import('../../config');
    exported = await writeDiagnosticsBundle({ report, config: loadConfig(), dir: typeof flags.export === 'string' ? flags.export : null });
  }
  const { bad: healthBad, warn: healthWarn } = agentSummary(report.checks);
  const chainBad = checks.filter((c) => !c.ok && !c.optional).length;
  const chainWarn = checks.filter((c) => !c.ok && c.optional).length;
  if (flags.json) {
    io.out(JSON.stringify({ health: report, checks, ...(exported ? { exported: exported.path } : {}) }, null, 2) + '\n');
    return healthBad + chainBad ? 1 : 0;
  }
  io.out('Kora\n');
  io.out(formatHealthReport(report));
  io.out('\nGraph + enforcement\n');
  const w = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    io.out(`${c.ok ? '✓' : c.optional ? '!' : '✗'} ${c.name.padEnd(w)}  ${c.detail}\n`);
    if (!c.ok && c.fix) io.out(`  ${' '.repeat(w)}  fix: ${c.fix}\n`);
  }
  // The summary counts exactly the rows printed above with ✗ (problems) and ! (warnings).
  const bad = healthBad + chainBad;
  const warn = healthWarn + chainWarn;
  io.out(bad ? `\n${bad} problem${bad === 1 ? '' : 's'}${warn ? `, ${warn} warning${warn === 1 ? '' : 's'}` : ''}.\n` : warn ? `\nNo problems, ${warn} warning${warn === 1 ? '' : 's'}.\n` : '\nAll good.\n');
  if (exported) io.out(`Diagnostics written to ${exported.path} (redacted; read it before sharing).\n`);
  return bad ? 1 : 0;
}
