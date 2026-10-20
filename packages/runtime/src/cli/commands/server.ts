import type { IO } from '../main';
import { parseArgs, withClient, json } from './_shared';
import { defaultSocketPath } from '../../protocol/types';

export const summary = 'Run the background server: start|stop|status|run';
export const usage = `kora server <start|stop|status|run> [--json]

  start    Start a detached server (logs to ~/.kora/server.log); no-op if already running
  stop     Ask the running server to shut down (panes are killed; layout is saved to state.json and restored on next start)
  status   Show version, pid, uptime, pane/workspace counts
  run      Run the server in the foreground (what \`start\` spawns)

Socket: $KORA_SOCKET_PATH (default ~/.kora/kora.sock). Home: $KORA_HOME (default ~/.kora).`;

export async function run(argv: string[], io: IO): Promise<number> {
  const { positional, flags } = parseArgs(argv, [], ['json']);
  const sub = positional[0] || 'status';
  const daemon = require('../../server/daemon') as typeof import('../../server/daemon');
  switch (sub) {
    case 'run': {
      const code = await daemon.runForeground();
      // A handle something left open (a UI socket mid-close, a worker thread) must not keep a stopped server alive.
      setTimeout(() => process.exit(code), 1500).unref();
      return code;
    }
    case 'start': {
      if (await daemon.isSocketAlive(defaultSocketPath())) { io.out(`server already running on ${defaultSocketPath()}\n`); return 0; }
      const r = await daemon.startDetached();
      if (flags.json) json(io, r); else io.out(`server started (pid ${r.pid}) on ${r.socketPath}\n`);
      return 0;
    }
    case 'stop': {
      if (!(await daemon.isSocketAlive(defaultSocketPath()))) { io.out('server not running\n'); return 0; }
      await withClient(io, (c) => c.call('server.shutdown', {}));
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (await daemon.isSocketAlive(defaultSocketPath()))) await new Promise((r) => setTimeout(r, 100));
      // It used to say "stopped" regardless (live QA #4: a daemon that was still up). Say what is true.
      if (await daemon.isSocketAlive(defaultSocketPath())) {
        io.err(`server asked to shut down but is still answering after 5 s (it is closing its browsers, sessions and routines); run \`kora server status\` to see, or stop its pid with kill.\n`);
        return 1;
      }
      io.out('server stopped\n'); return 0;
    }
    case 'status': {
      if (!(await daemon.isSocketAlive(defaultSocketPath()))) { if (flags.json) json(io, { running: false, socket: defaultSocketPath() }); else io.out(`server not running (${defaultSocketPath()})\n`); return 1; }
      const r = await withClient(io, async (c) => ({ ping: await c.call('server.ping', {}), status: await c.call('server.status', {}) }));
      if (flags.json) json(io, { running: true, ...r.ping, ...r.status });
      else io.out(`kora server ${r.status.version} · pid ${r.ping.pid} · up ${Math.round(r.ping.uptimeMs / 1000)}s\nsocket: ${r.status.socket}\nchat UI: ${r.status.ui ? `${r.status.ui.url} (ws /ws)` : r.status.uiError ? `NOT RUNNING — ${r.status.uiError}` : 'off'}\nworkspaces: ${r.status.workspaces} · panes: ${r.status.panes} · repos: ${r.status.graph.repos}\ngraph db: ${r.status.graph.db}\n${r.status.memory ? `memory: ${r.status.memory.rssMb} MB rss · ${r.status.memory.heapUsedMb} MB heap · ${r.status.memory.liveChatSessions} live chat session(s) · ${r.status.memory.stalls.count} event-loop stall(s)${r.status.memory.stalls.count ? ` (max ${r.status.memory.stalls.maxMs} ms)` : ''}\n` : ''}`);
      return 0;
    }
    default: io.err(usage + '\n'); return 2;
  }
}
