// `kora enforce install|uninstall|status [--agent X] [path]`
import path from 'node:path';
import type { IO } from '../main';
import { parseArgs, str } from '../args';
import type { AgentId } from '../../protocol/types';
import type { AdapterResult } from '../../enforce/index';
import { createEnforcer } from '../../enforce/index';

export const summary = 'Install/uninstall/status of the enforcement adapters';
export const usage = `Usage: kora enforce <install|uninstall|status> [--agent claude|codex|gemini|opencode|cursor|all] [path]
                       [--no-create] [--replace-koragraph-hooks]

install    write the managed instruction block, agent hooks, MCP config and PATH shims for the agent(s)
uninstall  remove exactly what install wrote (only kora-managed entries; everything else survives)
status     one row per managed file: managed | absent | skipped

--agent all (default) = every agent whose binary is on PATH, plus AGENTS.md for the rest.
--replace-koragraph-hooks also removes koragraph's own .claude/hooks/*.mjs entries (they double-fire with kora's).`;

export function renderResults(results: AdapterResult[]): string {
  if (!results.length) return '(nothing)\n';
  const w1 = Math.max(...results.map((r) => r.agent.length));
  const w2 = Math.max(...results.map((r) => r.action.length));
  return results.map((r) => `  ${r.agent.padEnd(w1)}  ${r.action.padEnd(w2)}  ${r.file}${r.detail ? `  — ${r.detail}` : ''}`).join('\n') + '\n';
}

export async function run(argv: string[], io: IO): Promise<number> {
  const { flags, positional } = parseArgs(argv, ['agent']);
  const [verb, target] = positional;
  if (!verb || flags.help) { io.out(usage + '\n'); return verb ? 0 : 2; }
  const cwd = path.resolve(target || process.cwd());
  const agent = (str(flags.agent) || 'all') as AgentId | 'all';
  const enforcer = createEnforcer();
  let results: AdapterResult[];
  if (verb === 'install') ({ results } = await (enforcer.install as any)({ agent, cwd, create: flags.create !== false, replaceKoragraphHooks: flags['replace-koragraph-hooks'] === true }));
  else if (verb === 'uninstall') ({ results } = await enforcer.uninstall({ agent, cwd }));
  else if (verb === 'status') ({ results } = await enforcer.status({ agent, cwd }));
  else { io.err(`kora enforce: unknown verb "${verb}"\n${usage}\n`); return 2; }
  if (flags.json) { io.out(JSON.stringify({ results }, null, 2) + '\n'); return 0; }
  io.out(`enforce ${verb} (${agent}) in ${cwd}\n${renderResults(results)}`);
  if (verb === 'status') return results.every((r) => r.action === 'managed') ? 0 : 1;
  return results.some((r) => r.action === 'skipped') ? 1 : 0;
}
