import type { IO } from '../main';
import { parseArgs, withClient, json, str } from './_shared';

export const summary = 'Orchestrator fleet: record the plan, read the roster, verify a merge';
export const usage = `kora fleet <subcommand> [--json]

  set [<orchestratorId>] [--plan "…"]               Record the plan (defaults to $KORA_PANE_ID)
  get [<orchestratorId>]                             Roster + plan + recent events
  verify [--workers p3,p5,…]                         Graph pre-merge conflict check across the workers' worktrees

Run from inside the orchestrator pane and the id defaults to this pane.`;

function selfId(explicit?: string): string {
  const id = explicit || process.env.KORA_PANE_ID;
  if (!id) throw new Error('no orchestrator id (pass one, or run inside the orchestrator pane so KORA_PANE_ID is set)');
  return id;
}

export async function run(argv: string[], io: IO): Promise<number> {
  const { positional, flags } = parseArgs(argv, ['plan', 'workers'], ['json']);
  const sub = positional[0] || 'get';
  return withClient(io, async (c) => {
    switch (sub) {
      case 'set': {
        const id = selfId(positional[1]);
        const r = await c.call('fleet.set', { orchestratorId: id, plan: str(flags.plan) });
        if (flags.json) json(io, r); else io.out(`fleet updated for ${id}\n`); return 0;
      }
      case 'get': case 'roster': {
        const id = selfId(positional[1]);
        const f = await c.call('fleet.get', { orchestratorId: id });
        if (flags.json) { json(io, f); return 0; }
        io.out(`ROSTER (${f.roster.length})\n`);
        for (const w of f.roster) io.out(`  ${w.paneId}  ${w.agent}${w.account ? '@' + w.account : ''}  ${w.steered ? 'steered' : w.state}${w.blocker ? ' · ' + w.blocker : ''}\n`);
        if (f.plan) io.out(`PLAN: ${f.plan}\n`);
        if (f.events.length) io.out('EVENTS:\n' + f.events.slice(0, 8).map((e) => `  ${new Date(e.at).toLocaleTimeString()} ${e.text}`).join('\n') + '\n');
        return 0;
      }
      case 'verify': {
        const paneIds = str(flags.workers)?.split(',').map((s) => s.trim()).filter(Boolean);
        const r = await c.call('worktree.mergeVerify', { paneIds });
        if (flags.json) { json(io, r); return 0; }
        if (!r.pairs.length) { io.out('no conflicts (fewer than two worktrees, or their diffs are independent)\n'); return 0; }
        for (const p of r.pairs) {
          io.out(`  ${p.status === 'clean' ? '✓' : p.status === 'semantic' ? '■' : '?'} ${p.a} ⇄ ${p.b}  ${p.status}\n`);
          for (const b of p.blame ?? []) io.out(`      ${b.file}:${b.line} ${b.symbol} — broken by ${b.byWorker}\n`);
        }
        io.out(`order: ${r.order.join(' → ')}\n`);
        return r.pairs.some((p) => p.status === 'semantic') ? 1 : 0;
      }
      default: io.err(usage + '\n'); return 2;
    }
  });
}
