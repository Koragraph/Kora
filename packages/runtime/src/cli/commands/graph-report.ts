// `kora graph report [--out FILE] [--json]` — the repo code map (areas, hubs, entry points, ...). A THIN client of the
// daemon's `GET /api/graph/report` (ui-server repoReport.ts builds it in the graph reader child): no second implementation,
// so the CLI, the Graph Explorer's Overview tab and a saved GRAPH_REPORT.md can never disagree. It needs the daemon's UI
// token (`<KORA_HOME>/ui-token`), which agents never hold, so it is a command for a human's terminal.
import fs from 'node:fs';
import path from 'node:path';
import type { IO } from '../main';
import { loadConfig } from '../../config';
import { isAgentOrigin, readControlToken } from '../../server/control-auth';
import { koraHome } from '../../protocol/types';

export const reportUsage = `Usage: kora graph report [--out FILE] [--json] [--cwd DIR]

  The code map of the repo containing the current folder (or --cwd): its areas, the declarations most of the code
  depends on, where execution starts, how the areas connect, what changes most, import cycles. Built from the code graph,
  no model call. Needs the Kora daemon (\`kora server start\`) and an indexed repo (\`kora ingest .\`).
  --out FILE   write the Markdown to FILE (never into the repo unless you point it there) instead of printing it
  --json       the raw report (the same JSON the Graph Explorer reads)`;

export interface ReportFetch {
  readonly port: number;
  readonly token: string;
  readonly cwd: string;
  readonly json: boolean;
  readonly fetchImpl?: typeof fetch;
}

/** One request to the daemon. Returns the body, or the reason it could not be had (exit-code + message for the CLI). */
export async function fetchRepoReport(o: ReportFetch): Promise<{ ok: true; body: string } | { ok: false; code: number; message: string }> {
  const url = `http://127.0.0.1:${o.port}/api/graph/report?cwd=${encodeURIComponent(o.cwd)}${o.json ? '' : '&format=md'}`;
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${o.token}` }, signal: AbortSignal.timeout(30_000) });
  } catch (e: any) {
    return { ok: false, code: 1, message: `could not reach the Kora daemon on 127.0.0.1:${o.port} (${e?.message ?? e}). Start it with: kora server start` };
  }
  if (res.status === 200) return { ok: true, body: await res.text() };
  if (res.status === 404) return { ok: false, code: 1, message: `no whole index for ${o.cwd}. Index it first: kora ingest .` };
  if (res.status === 503) return { ok: false, code: 1, message: 'the graph reader is busy; try again in a moment' };
  if (res.status === 401 || res.status === 403) return { ok: false, code: 1, message: `the daemon refused the token (${res.status}); is KORA_HOME the one the daemon runs with?` };
  return { ok: false, code: 1, message: `the daemon answered ${res.status}` };
}

export async function runReport(flags: Record<string, string | boolean>, cwd: string, io: IO): Promise<number> {
  if (flags.help) { io.out(reportUsage + '\n'); return 0; }
  // Agents never hold the token (the sensitive-path guard refuses the file); say so instead of failing at the read.
  if (isAgentOrigin()) { io.err('kora graph report: needs the Kora control token, which agents do not hold. Run it yourself from a terminal.\n'); return 2; }
  const port = loadConfig().uiPort;
  if (!port) { io.err('kora graph report: the daemon serves no UI port (uiPort is 0 / KORA_UI_PORT=0), so there is nothing to ask.\n'); return 2; }
  const token = readControlToken(koraHome());
  if (!token) { io.err(`kora graph report: no UI token at ${path.join(koraHome(), 'ui-token')}; start the daemon once (kora server start).\n`); return 1; }
  const r = await fetchRepoReport({ port, token, cwd, json: flags.json === true });
  if (!r.ok) { io.err(`kora graph report: ${r.message}\n`); return r.code; }
  const out = typeof flags.out === 'string' ? flags.out : '';
  if (out) {
    const file = path.resolve(out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, r.body.endsWith('\n') ? r.body : `${r.body}\n`);
    io.out(`wrote ${file}\n`);
    return 0;
  }
  io.out(r.body.endsWith('\n') ? r.body : `${r.body}\n`);
  return 0;
}
