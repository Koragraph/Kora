import type { IO } from '../main';
import type { AgentId } from '../../protocol/types';
import { parseArgs, withClient, json, str, num, paneRow } from './_shared';

export const summary = 'Spawn/list/read/write/kill/resize panes; report-agent-session; report-graph-use';
export const usage = `kora pane <subcommand> [options] [--json]

  list [--workspace W]
  spawn [--agent A] [--cwd DIR] [--name N] [--workspace W] [--cols C] [--rows R] [--no-enforce] [-- cmd args…]
        (no command = your login shell)
  kill <id> [--signal SIG]
  write <id> <text…> [--enter]          send text (use --enter to press Return afterwards)
  read <id> [--source screen|detection|scrollback] [--format text|ansi] [--lines N]
  resize <id> <cols> <rows>
  focus <id>
  rename <id> <name>
  get <id>
  report-agent-session <id> --agent A --agent-session-id S [--agent-session-path P]
  report-graph-use <id> --tool T [--ms N]

Every pane gets KORA_ENV=1, KORA_PANE_ID, KORA_SOCKET_PATH, KORA_BIN, KORA_AGENT, KORA_REPO_ROOT.`;

export async function run(argv: string[], io: IO): Promise<number> {
  const { positional, flags, rest } = parseArgs(argv, ['workspace', 'agent', 'cwd', 'name', 'cols', 'rows', 'signal', 'source', 'format', 'lines', 'agent-session-id', 'agent-session-path', 'tool', 'ms'], ['json', 'enter', 'no-enforce']);
  const sub = positional[0] || 'list';
  const id = positional[1];
  const needId = () => { if (!id) throw new Error(`usage: kora pane ${sub} <id> …`); return id; };
  return withClient(io, async (c) => {
    switch (sub) {
      case 'list': case 'ls': {
        const r = await c.call('pane.list', { workspaceId: str(flags.workspace) });
        if (flags.json) { json(io, r); return 0; }
        if (!r.panes.length) { io.out('no panes\n'); return 0; }
        io.out(r.panes.map(paneRow).join('\n') + '\n'); return 0;
      }
      case 'spawn': case 'new': {
        const p = await c.call('pane.spawn', {
          command: rest[0], args: rest.slice(1), cwd: str(flags.cwd) ?? process.cwd(), agent: str(flags.agent) as AgentId | undefined, name: str(flags.name),
          workspaceId: str(flags.workspace), cols: num(flags.cols), rows: num(flags.rows), enforce: flags['no-enforce'] ? false : undefined,
        });
        if (flags.json) json(io, p); else io.out(`${p.id}\n`);
        return 0;
      }
      case 'get': { const p = await c.call('pane.get', { paneId: needId() }); if (flags.json) json(io, p); else io.out(paneRow(p) + '\n'); return 0; }
      case 'kill': { await c.call('pane.kill', { paneId: needId(), signal: str(flags.signal) }); io.out(flags.json ? '{"ok":true}\n' : `killed ${id}\n`); return 0; }
      case 'write': {
        needId(); let text = positional.slice(2).join(' ');
        if (!text && rest.length) text = rest.join(' ');
        if (flags.enter) text += '\r';
        if (!text) throw new Error('nothing to write');
        await c.call('pane.write', { paneId: id!, text }); if (flags.json) io.out('{"ok":true}\n'); return 0;
      }
      case 'read': {
        const r = await c.call('pane.read', { paneId: needId(), source: str(flags.source) as any, format: str(flags.format) as any, lines: num(flags.lines) });
        if (flags.json) json(io, r); else io.out(r.text + (r.text.endsWith('\n') ? '' : '\n')); return 0;
      }
      case 'snapshot': { json(io, await c.call('pane.snapshot', { paneId: needId() })); return 0; }
      case 'resize': {
        const cols = Number(positional[2]), rows = Number(positional[3]);
        if (!id || !cols || !rows) throw new Error('usage: kora pane resize <id> <cols> <rows>');
        await c.call('pane.resize', { paneId: id, cols, rows }); if (flags.json) io.out('{"ok":true}\n'); return 0;
      }
      case 'focus': { await c.call('pane.focus', { paneId: needId() }); if (flags.json) io.out('{"ok":true}\n'); return 0; }
      case 'rename': {
        const name = positional.slice(2).join(' '); if (!id || !name) throw new Error('usage: kora pane rename <id> <name>');
        await c.call('pane.rename', { paneId: id, name }); if (flags.json) io.out('{"ok":true}\n'); return 0;
      }
      case 'report-agent-session': {
        const agent = str(flags.agent) as AgentId | undefined, sid = str(flags['agent-session-id']);
        if (!agent || !sid) throw new Error('usage: kora pane report-agent-session <id> --agent A --agent-session-id S');
        await c.call('pane.reportAgentSession', { paneId: needId(), agent, agentSessionId: sid, transcriptPath: str(flags['agent-session-path']) });
        if (flags.json) io.out('{"ok":true}\n'); return 0;
      }
      case 'report-graph-use': {
        const tool = str(flags.tool); if (!tool) throw new Error('usage: kora pane report-graph-use <id> --tool T [--ms N]');
        await c.call('pane.reportGraphUse', { paneId: needId(), tool, ms: num(flags.ms) }); if (flags.json) io.out('{"ok":true}\n'); return 0;
      }
      default: io.err(usage + '\n'); return 2;
    }
  });
}
