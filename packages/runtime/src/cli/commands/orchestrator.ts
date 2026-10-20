// `kora orchestrator` — install the portable orchestrator playbook so any agent (Claude Code, Codex, Cursor,
// Gemini, opencode) can act as the fleet orchestrator. This is the download-once artifact the user asked for:
// it does not depend on hooks. `promote` also installs it automatically, but this lets a user set it up by hand
// (e.g. to invoke the Claude skill directly with /kora-orchestrator, or to paste the block into an AGENTS.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IO } from '../main';
import { parseArgs, str } from '../args';
import { orchestratorPlaybook, orchestratorPlaybookPath, claudeSkillDoc } from '../../server/orchestrator-skill';
import { installSwarmSkill, swarmPlaybookPath } from '../../server/swarm-skill';

export const summary = 'Install the portable orchestrator playbook (skill) for every agent, or print it';
export const usage = `Usage: kora orchestrator <install|path|show>

  install [--dir <path>]   Write the playbook every agent can read (~/.kora/skills/orchestrator.md) and the
                           Claude Code skill (~/.claude/skills/kora-orchestrator/SKILL.md). --dir also drops a
                           copy of AGENTS-ORCHESTRATOR.md there for Codex/Cursor/opencode repos. Also installs the
                           Swarm-mode skill (~/.kora/skills/swarm.md, ~/.claude/skills/koraswarm/SKILL.md) and the
                           OpenCode state plugin its workers load (~/.kora/opencode/plugins/kora-state.js).
  path                     Print the portable playbook path (the file agents read).
  show                     Print the playbook to stdout (pipe it wherever you like).

The orchestrator uses \`kora graph\` on demand, so a promoted pane needs no injection hooks — it stays fast.`;

function claudeSkillPath(): string { return path.join(os.homedir(), '.claude', 'skills', 'kora-orchestrator', 'SKILL.md'); }

export async function run(args: string[], io: IO): Promise<number> {
  const { positional, flags } = parseArgs(args, ['dir']);
  const sub = positional[0] || 'install';
  if (sub === 'path') { io.out(orchestratorPlaybookPath() + '\n'); return 0; }
  if (sub === 'show') { io.out(orchestratorPlaybook() + '\n'); return 0; }
  if (sub !== 'install') { io.err(`kora orchestrator: unknown subcommand "${sub}"\n\n${usage}\n`); return 2; }

  const written: string[] = [];
  const pb = orchestratorPlaybookPath();
  fs.mkdirSync(path.dirname(pb), { recursive: true });
  fs.writeFileSync(pb, orchestratorPlaybook() + '\n'); written.push(pb);

  const sk = claudeSkillPath();
  fs.mkdirSync(path.dirname(sk), { recursive: true });
  fs.writeFileSync(sk, claudeSkillDoc()); written.push(sk);

  try {
    installSwarmSkill();
    written.push(swarmPlaybookPath(), path.join(os.homedir(), '.claude', 'skills', 'koraswarm', 'SKILL.md'));
  } catch (e: any) { io.err(`kora orchestrator: swarm skill not installed: ${e?.message || e}\n`); }

  const dir = str(flags.dir);
  if (dir) {
    const target = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()), 'AGENTS-ORCHESTRATOR.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, orchestratorPlaybook() + '\n'); written.push(target);
  }

  io.out(`installed orchestrator playbook:\n${written.map((w) => '  ' + w).join('\n')}\n`);
  io.out(`\nClaude Code: it loads as the \`kora-orchestrator\` skill (or /kora-orchestrator).\n`);
  io.out(`Codex / Cursor / opencode: reference ${pb} from your AGENTS.md, or run with --dir <repo> to drop a copy in.\n`);
  return 0;
}
