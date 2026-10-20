import type { IO } from '../main';
import type { AgentId, AgentState } from '../../protocol/types';
import { parseArgs, withClient, json, str, num, paneRow } from './_shared';
import { isKnownAgent, KNOWN_AGENTS } from '../../detect';

export const summary = 'List agents, spawn one, prompt it, wait until it needs a human, read its screen';
export const usage = `kora agent <subcommand> [options] [--json]

  list                                              Panes running a recognised agent, with state
  spawn <${KNOWN_AGENTS.join('|')}|shell>
        [--cwd DIR] [--name N] [--workspace W] [--prompt "…"] [--budget USD] [--no-worktree] [-- extra args]
        [--orchestrator <id>] [--account <name>]
        --budget: warn at 80%, at 100% the agent is told to finish and stop (never killed). Default: config defaultBudgetUsd
        --orchestrator: mark the new pane a WORKER of that orchestrator (steers feed back to it); --account: credential profile
  promote <id> [--briefing "…"]                     Make a pane the orchestrator; it interviews you, then dispatches workers
  prompt <id> "text" [--no-submit] [--no-wait] [--timeout MS]
        Waits for the agent to be idle (default 60s), types the text, presses Enter
  wait <id> [--until blocked|idle|working|needs-human] [--timeout MS]
        Blocks until the agent reaches the state (needs-human = blocked|idle|exited). timeout 0 = up to 1h
  status <id>
  restart <id> [--mode resume|cheap|fresh]
        cheap (default, config restartMode): fresh session + a distilled brief of the old one; resume re-sends the whole conversation
  compact <id>                                      Send /compact (keeps file:line citations and decisions) to an idle Claude pane
  read <id> [--source screen|detection|scrollback] [--format text|ansi] [--lines N]
  kill <id>`;

export async function run(argv: string[], io: IO): Promise<number> {
  const { positional, flags, rest } = parseArgs(argv, ['cwd', 'name', 'workspace', 'prompt', 'timeout', 'until', 'source', 'format', 'lines', 'budget', 'mode', 'orchestrator', 'account', 'briefing'], ['json', 'no-submit', 'no-wait', 'no-worktree', 'after-change']);
  const sub = positional[0] || 'list';
  const id = positional[1];
  // `kora agent spawn koragent --help` spawned a real pane (and the agent wrote AGENTS.md into the cwd): a help flag
  // before `--` is ours — print the usage and touch nothing. `-- --help` still reaches the agent on purpose.
  if (flags.help === true || flags.h === true || positional.includes('-h')) { io.out(usage + '\n'); return 0; }
  const needId = () => { if (!id) throw new Error(`usage: kora agent ${sub} <id> …`); return id; };
  return withClient(io, async (c) => {
    switch (sub) {
      case 'list': case 'ls': {
        const r = await c.call('agent.list', {});
        if (flags.json) { json(io, r); return 0; }
        if (!r.agents.length) { io.out('no agents running (try: kora agent spawn claude)\n'); return 0; }
        io.out(r.agents.map(paneRow).join('\n') + '\n'); return 0;
      }
      case 'spawn': case 'new': {
        const agent = positional[1] as AgentId | undefined;
        if (!agent || !(isKnownAgent(agent) || agent === 'shell')) throw new Error(`usage: kora agent spawn <${KNOWN_AGENTS.join('|')}|shell> …`);
        const p = await c.call('agent.spawn', { agent, cwd: str(flags.cwd) ?? process.cwd(), name: str(flags.name), workspaceId: str(flags.workspace), prompt: str(flags.prompt), args: rest, worktree: flags['no-worktree'] ? false : undefined, budgetUsd: num(flags.budget), orchestratorId: str(flags.orchestrator), account: str(flags.account) });
        if (flags.json) json(io, p); else io.out(`${p.id}\n`);
        return 0;
      }
      case 'promote': {
        const r = await c.call('agent.promote', { paneId: needId(), briefing: str(flags.briefing) });
        if (flags.json) json(io, r); else io.out(`${id} promoted to orchestrator\n`); return 0;
      }
      case 'prompt': {
        const text = positional.slice(2).join(' ') || rest.join(' ');
        if (!text) throw new Error('usage: kora agent prompt <id> "text"');
        const r = await c.call('agent.prompt', { paneId: needId(), text, submit: !flags['no-submit'], waitIdle: !flags['no-wait'], timeoutMs: num(flags.timeout) });
        if (flags.json) json(io, r); else io.out(`sent · state ${r.state}\n`); return 0;
      }
      case 'wait': {
        const until = (str(flags.until) ?? 'needs-human') as AgentState | 'needs-human';
        const r = await c.call('agent.wait', { paneId: needId(), until, timeoutMs: num(flags.timeout), afterChange: Boolean(flags['after-change']) });
        if (flags.json) json(io, r); else io.out(`${r.state}${r.blocker ? ` · ${r.blocker}` : ''}${r.timedOut ? ' (timed out)' : ''}\n`);
        return r.timedOut ? 3 : 0;
      }
      case 'status': {
        const r = await c.call('agent.status', { paneId: needId() });
        if (flags.json) json(io, r); else io.out(`${r.agent} · ${r.state}${r.blocker ? ` · ${r.blocker}` : ''}\n`); return 0;
      }
      case 'restart': {
        const mode = str(flags.mode) as any;
        if (mode && !['resume', 'cheap', 'fresh'].includes(mode)) throw new Error('--mode must be resume|cheap|fresh');
        const p = await c.call('pane.restart', { paneId: needId(), mode });
        if (flags.json) json(io, p); else io.out(`${p.id}\n`); return 0;
      }
      case 'compact': {
        const r = await c.call('pane.compact', { paneId: needId() });
        if (flags.json) json(io, r); else io.out(r.sent ? `sent${r.reason ? ` — ${r.reason}` : ''}\n` : `not sent — ${r.reason}\n`); return r.sent ? 0 : 1;
      }
      case 'read': {
        const r = await c.call('pane.read', { paneId: needId(), source: str(flags.source) as any, format: str(flags.format) as any, lines: num(flags.lines) });
        if (flags.json) json(io, r); else io.out(r.text + (r.text.endsWith('\n') ? '' : '\n')); return 0;
      }
      case 'kill': { await c.call('pane.kill', { paneId: needId() }); io.out(flags.json ? '{"ok":true}\n' : `killed ${id}\n`); return 0; }
      default: io.err(usage + '\n'); return 2;
    }
  });
}
