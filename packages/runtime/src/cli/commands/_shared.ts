// Shared helpers for the runtime CLI commands: arg parsing, client connection, output formatting.
import type { IO } from '../main';
import { KoraClient } from '../../protocol/client';
import { defaultSocketPath, PaneInfo, AgentState } from '../../protocol/types';

// `kora pane read … | head` must not crash on EPIPE.
process.stdout.on('error', (e: any) => { if (e?.code === 'EPIPE') process.exit(0); });

export interface Parsed { positional: string[]; flags: Record<string, string | boolean>; rest: string[] }

/** Parse `--flag value`, `--flag=value`, `--bool`, `-x`; everything after `--` goes to rest. */
export function parseArgs(argv: string[], valueFlags: string[] = [], boolFlags: string[] = []): Parsed {
  const out: Parsed = { positional: [], flags: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) { out.flags[name] = a.slice(eq + 1); continue; }
      if (boolFlags.includes(name) || (!valueFlags.includes(name) && (argv[i + 1] === undefined || argv[i + 1].startsWith('-')))) { out.flags[name] = true; continue; }
      out.flags[name] = argv[++i] ?? '';
      continue;
    }
    out.positional.push(a);
  }
  return out;
}
export const str = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: string | boolean | undefined): number | undefined => (typeof v === 'string' && v !== '' && !isNaN(Number(v)) ? Number(v) : undefined);

export async function connect(io: IO): Promise<KoraClient> {
  const c = new KoraClient(defaultSocketPath());
  try { await c.connect(); }
  catch (e: any) { throw new Error(`cannot reach kora server at ${defaultSocketPath()} (${e?.code || e?.message}). Start it with: kora server start`); }
  return c;
}

/** Run `fn` with a connected client, always closing it. */
export async function withClient<T>(io: IO, fn: (c: KoraClient) => Promise<T>): Promise<T> {
  const c = await connect(io);
  try { return await fn(c); } finally { c.close(); }
}

export function json(io: IO, v: unknown) { io.out(JSON.stringify(v, null, 2) + '\n'); }

export const STATE_GLYPH: Record<AgentState, string> = { working: '●', blocked: '■', idle: '○', unknown: '·' };

export function paneRow(p: PaneInfo): string {
  const st = p.exited ? `exited(${p.exitCode})` : p.state;
  const g = p.graph.indexed ? `⬢ ${fmtCount(p.graph.nodes)} nodes · ${p.graph.toolCalls} calls` : '⬡ not indexed';
  return `${p.id.padEnd(4)} ${p.workspaceId.padEnd(3)} ${p.exited ? '✕' : STATE_GLYPH[p.state]} ${st.padEnd(12)} ${p.agent.padEnd(9)} ${p.name.padEnd(16)} ${p.cwd}  ${g}${p.blocker ? `\n     ↳ ${p.blocker}` : ''}`;
}
export function fmtCount(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n); }

export function table(rows: string[][]): string {
  const w: number[] = [];
  for (const r of rows) r.forEach((c, i) => { w[i] = Math.max(w[i] ?? 0, c.length); });
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join('  ')).join('\n') + '\n';
}
