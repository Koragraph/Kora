// `kora savings` — the number. Real usage from the agent's transcript, plus the labelled counterfactual.
import fs from 'node:fs';
import path from 'node:path';
import { chatSessionRows } from '../../ledger/chat-sessions';
import { parseTranscript, summarize, fmtTokens, fmtUsd, LedgerSummary } from '../../ledger/transcript';

export const summary = 'Real token usage per pane or transcript (measured spend and cache; savings numbers only come from `kora bench`)';
export const usage = `Usage: kora savings [<paneId>] [--session <transcript.jsonl>] [--json]

  <paneId>              one live pane (from \`kora pane list\`)
  --session <file>      analyse any Claude Code transcript (~/.claude/projects/<slug>/<id>.jsonl) with no server
  --json                raw

Measured only: spend, context, cache hit rate and cache savings come straight from the transcript's usage fields,
plus how the agent worked (graph calls, reads, greps). There is no estimated "tokens avoided" figure — it was a
counterfactual guess and was removed; for a defensible savings number, run an A/B with \`kora bench\`.`;

function row(label: string, s: LedgerSummary) {
  return `${label.padEnd(10)} ${String(s.apiCalls).padStart(5)} calls  ${fmtTokens(s.context).padStart(7)} ctx  ${fmtUsd(s.costUsd).padStart(8)} spent  ` +
    `graph ${String(s.graphCalls).padStart(3)} (mcp ${s.graphMcp}, cli ${s.graphCli})  reads ${String(s.reads).padStart(3)}  greps ${String(s.greps).padStart(3)}  ` +
    `cache hit ${(s.cacheHitRate * 100).toFixed(0)}%  cache saved ${fmtUsd(s.cacheSavedUsd)}`;
}

export async function run(argv: string[], io: { out: (s: string) => void; err: (s: string) => void }): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const json = flags.has('--json');
  const sessionIdx = argv.indexOf('--session');
  if (sessionIdx >= 0) {
    const f = argv[sessionIdx + 1]; if (!f) { io.err(usage + '\n'); return 2; }
    const sess = parseTranscript(path.resolve(f)); const s = summarize(sess);
    if (json) { io.out(JSON.stringify({ summary: s }, null, 2) + '\n'); return 0; }
    io.out(row(path.basename(f).slice(0, 8), s) + '\n'); return 0;
  }
  const { callOnce } = require('../../protocol/client');
  const paneId = argv.find((a) => !a.startsWith('--'));
  try {
    if (paneId) {
      const r = await callOnce('ledger.get', { paneId });
      if (json) { io.out(JSON.stringify(r, null, 2) + '\n'); return 0; }
      if (!r.summary) { io.out(`${paneId}: no transcript yet (the agent's SessionStart hook reports it; a plain shell pane has none)\n`); return 0; }
      io.out(row(paneId, r.summary) + '\n');
      return 0;
    }
    const r = await callOnce('ledger.summary', {});
    // The desktop-chat lane: threads resume Claude sessions that no pane ever registered with the ledger.
    const chats = chatSessionRows();
    if (json) { io.out(JSON.stringify({ ...r, chats }, null, 2) + '\n'); return 0; }
    if (!r.panes.length && !chats.length) { io.out('No agent transcripts yet. Ask something in a Kora chat, or spawn an agent (kora agent spawn claude).\n'); return 0; }
    for (const p of r.panes) io.out(row(p.paneId, p.summary) + '\n');
    if (chats.length) io.out(`desktop chats (${chats.length}, measured from their Claude sessions):\n`);
    for (const c of chats) io.out(row(c.paneId, c.summary) + `  ${c.title.slice(0, 40)}\n`);
    const t = { ...r.totals };
    for (const c of chats) { t.costUsd += c.summary.costUsd; t.cacheSavedUsd += c.summary.cacheSavedUsd; t.context += c.summary.context; t.graphCalls += c.summary.graphCalls; t.reads += c.summary.reads; t.greps += c.summary.greps; }
    io.out(`${'TOTAL'.padEnd(10)} spent ${fmtUsd(t.costUsd)}  ${fmtTokens(t.context)} ctx  graph ${t.graphCalls}  reads ${t.reads}  greps ${t.greps}  cache saved ${fmtUsd(t.cacheSavedUsd)}\n`);
    return 0;
  } catch (e: any) {
    io.err(`kora savings: server not reachable (${e.message}). Use --session <transcript> or --all for offline analysis.\n`); return 1;
  }
}
