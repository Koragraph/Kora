// `kora takeover [path…] [--all-known] [--dry-run]` — remove what the previous runtime wrote into repos and the home
// dir (its hook entries, managed blocks, MCP entries, orchestrator skill, codex MCP server, git re-index blocks) and
// install kora's equivalents where it had them. Only entries identified by that product's markers, hook command,
// install paths or skill name are touched. Idempotent; --dry-run prints the exact plan and writes nothing.
import path from 'node:path';
import type { IO } from '../main';
import { parseArgs } from '../args';
import type { AgentId } from '../../protocol/types';
import { applyPlan, installKoraSkill, knownRoots, planHome, planRepo, type TakeoverPlan } from '../../enforce/takeover';

export const summary = 'Take over repos (and ~) set up by the previous runtime: remove its hooks/blocks/skill, install kora\'s';
export const usage = `Usage: kora takeover [path…] [--all-known] [--dry-run] [--no-home] [--no-install] [--json]

  path…        checkouts to take over (default: the current directory's checkout)
  --all-known  every checkout the previous runtime ever touched: its saved workspaces, the graph store's repository
               list, and the directories Claude Code / Codex have opened (its own home and checkouts are skipped)
  --dry-run    print the plan; write nothing
  --no-home    leave the home dir alone (~/CLAUDE.md, ~/.claude, the orchestrator skill, ~/.codex/config.toml)
  --no-install only remove; do not install kora's hooks/blocks where the previous runtime had its own

Removed, and only these: <!-- <old>:begin/end --> blocks (CLAUDE.md, AGENTS.md, GEMINI.md, .cursor/rules/<old>.mdc),
hook entries running \`<old> hook …\` or koragraph hook scripts inside its checkout (.claude/settings*.json),
MCP entries named after it that point into it (.mcp.json, .gemini, opencode.json, .cursor/mcp.json,
~/.codex/config.toml), codex trust entries for its worktrees, its Claude skill (~/.claude/skills/<old>-orchestrator),
and git re-index blocks pointed at it (replaced in place with kora's). The home dir's instruction blocks are removed
but not replaced: ~/CLAUDE.md is loaded into every session on the machine.`;

function render(plan: TakeoverPlan): string {
  return plan.steps.map((s) => `  ${s.kind.padEnd(8)}  ${s.file}  — ${s.detail}`).join('\n');
}

export async function run(argv: string[], io: IO): Promise<number> {
  const { flags, positional } = parseArgs(argv);
  if (flags.help) { io.out(usage + '\n'); return 0; }
  const dry = flags['dry-run'] === true;
  if (flags.home === false) process.env.KORA_TAKEOVER_HOME = '0'; // the installs below must not reach ~ either
  const install = flags.install !== false;
  let roots: string[] = [];
  if (flags['all-known'] === true) {
    const k = knownRoots();
    roots = k.roots;
    if (!flags.json) io.out(`candidates: ${roots.length} checkout(s) from ${Object.entries(k.sources).map(([s, n]) => `${s} ${n}`).join(', ') || 'no source'}\n`);
  }
  for (const p of positional) roots.push(path.resolve(p));
  if (!roots.length && flags['all-known'] !== true) roots.push(process.cwd());
  roots = [...new Set(roots.map((r) => { const { gitTopLevel } = require('../../graph/embedded'); return gitTopLevel(r) || r; }))];

  const plans: TakeoverPlan[] = [];
  if (flags.home !== false) plans.push(planHome());
  for (const r of roots) plans.push(planRepo(r));
  const todo = plans.filter((p) => p.steps.length);
  const report: any[] = [];
  let failed = 0;

  if (!flags.json) io.out(`${dry ? 'DRY RUN — nothing is written\n' : ''}${todo.length ? '' : 'nothing to take over: no legacy entries found\n'}`);
  for (const plan of todo) {
    const isHome = plan.steps[0]?.scope === 'home';
    const installs = !install ? [] : isHome ? plan.agents.map((a) => (a === 'skill' ? 'kora-orchestrator skill' : 'codex [mcp_servers.kora]')) : plan.agents.map((a) => `kora enforce (${a === 'unknown' ? 'AGENTS.md' : a})`);
    if (!flags.json) io.out(`\n${isHome ? `home ${plan.root}` : plan.root}\n${render(plan)}\n${installs.map((i) => `  install   ${i}`).join('\n')}${installs.length ? '\n' : ''}`);
    const row: any = { root: plan.root, home: isHome, steps: plan.steps.map((s) => ({ kind: s.kind, file: s.file, detail: s.detail })), install: installs };
    if (!dry) {
      const r = applyPlan(plan);
      failed += r.failed.length;
      for (const f of r.failed) io.err(`  FAILED ${f.step.file}: ${f.error}\n`);
      if (install) {
        const done: string[] = [];
        try {
          if (isHome) {
            if (plan.agents.includes('skill')) done.push(installKoraSkill());
            if (plan.agents.includes('codex')) done.push(require('../../enforce/mcpconfig').upsertCodexMcp().file);
          } else {
            const { createEnforcer } = require('../../enforce/enforcer');
            const enforcer = createEnforcer();
            for (const a of plan.agents) {
              const { results } = await enforcer.install({ agent: a as AgentId, cwd: plan.root });
              for (const x of results) if (x.agent !== 'shims' && (x.action === 'installed' || x.action === 'refreshed')) done.push(`${x.agent}: ${x.file}`);
              for (const x of results) if (x.action === 'skipped' && x.agent !== 'claude') io.err(`  install skipped ${x.file}: ${x.detail || ''}\n`);
            }
          }
        } catch (e: any) { failed++; io.err(`  install failed: ${e?.message || e}\n`); }
        row.installed = done;
        if (!flags.json && done.length) io.out(done.map((d) => `  ✓ installed ${d}`).join('\n') + '\n');
      }
    }
    report.push(row);
  }
  if (flags.json) io.out(JSON.stringify({ dryRun: dry, plans: report }, null, 2) + '\n');
  else io.out(`\n${dry ? 'would change' : 'changed'}: ${todo.reduce((n, p) => n + p.steps.length, 0)} entr(y/ies) in ${todo.length} location(s)${failed ? `; ${failed} failed` : ''}\n`);
  return failed ? 1 : 0;
}
