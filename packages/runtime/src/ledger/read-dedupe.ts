// Read dedupe, diff-aware (RESEARCH.md item 4). The hook remembers every Read of the session in a per-session
// JSON under os.tmpdir: {file → {mtimeMs, size, offset, limit, turn, lines, blocks}} where blocks is one sha256
// per 40-line block. A second Read of an unchanged file is nudged ("already in context"); a changed file gets
// the changed line ranges so the agent reads a range, not the file. Zero cost when it does nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathTail } from '../util/os-roots';

export const BLOCK_LINES = 40;

export interface ReadRecord { mtimeMs: number; size: number; offset: number | null; limit: number | null; turn: number; lines: number; blocks: string[] }
export type ReadLog = Record<string, ReadRecord>;

export function readLogPath(markerBase: string): string { return `${markerBase}-reads.json`; }
export function loadReadLog(markerBase: string): ReadLog {
  try { const v = JSON.parse(fs.readFileSync(readLogPath(markerBase), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
export function saveReadLog(markerBase: string, log: ReadLog): void {
  try { fs.writeFileSync(readLogPath(markerBase), JSON.stringify(log)); } catch { /* best effort */ }
}

export function blockHashes(content: string): { lines: number; blocks: string[] } {
  const ls = content.split('\n');
  if (ls.length && ls[ls.length - 1] === '') ls.pop();
  const blocks: string[] = [];
  for (let i = 0; i < ls.length; i += BLOCK_LINES) blocks.push(crypto.createHash('sha256').update(ls.slice(i, i + BLOCK_LINES).join('\n')).digest('hex').slice(0, 12));
  return { lines: ls.length, blocks };
}

/** Line ranges (1-based, inclusive) whose 40-line block differs between two hash lists; adjacent blocks merge. */
export function changedRanges(prev: { lines: number; blocks: string[] }, next: { lines: number; blocks: string[] }): Array<[number, number]> {
  const n = Math.max(prev.blocks.length, next.blocks.length);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    if (prev.blocks[i] === next.blocks[i]) continue;
    const a = i * BLOCK_LINES + 1;
    const b = Math.min((i + 1) * BLOCK_LINES, Math.max(next.lines, prev.lines, a));
    const last = out[out.length - 1];
    if (last && last[1] + 1 >= a) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}
export function fmtRanges(r: Array<[number, number]>): string { return r.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', '); }

/** Build the record for a file as it is on disk now (content hashed when readable, else stat only). */
export function recordFor(file: string, input: { offset?: unknown; limit?: unknown }, turn: number, content?: string | null): ReadRecord | null {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  let hashed = { lines: 0, blocks: [] as string[] };
  try { hashed = blockHashes(typeof content === 'string' ? content : fs.readFileSync(file, 'utf8')); } catch { /* stat only */ }
  const off = Number(input?.offset); const lim = Number(input?.limit);
  return { mtimeMs: st.mtimeMs, size: st.size, offset: Number.isFinite(off) && input?.offset != null ? off : null, limit: Number.isFinite(lim) && input?.limit != null ? lim : null, turn, ...hashed };
}

/**
 * What to tell the agent about a Read of `file` given the session's log. null = say nothing (first Read, or a
 * legitimately different range of a file only partially read before).
 */
/**
 * The earlier Read record when `file` is unchanged since it and that Read covered what this one asks for; null otherwise (never read,
 * changed, or a range the earlier Read did not include: a new range, not a re-read).
 */
export function unchangedReread(file: string, input: { offset?: unknown; limit?: unknown }, log: ReadLog): ReadRecord | null {
  const prev = log[file]; if (!prev) return null;
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  if (st.mtimeMs !== prev.mtimeMs || st.size !== prev.size) return null;
  if (prev.offset != null || prev.limit != null) {
    const pa = prev.offset ?? 1, pb = prev.limit != null ? pa + prev.limit - 1 : Infinity;
    const na = input?.offset != null ? Number(input.offset) : 1, nb = input?.limit != null ? na + Number(input.limit) - 1 : Infinity;
    if (na < pa || nb > pb) return null;
  }
  return prev;
}

/**
 * What to tell the agent about a Read of `file` given the session's log. null = say nothing (first Read, or a
 * legitimately different range of a file only partially read before).
 */
export function dedupeNotice(file: string, input: { offset?: unknown; limit?: unknown }, log: ReadLog): string | null {
  const prev = log[file]; if (!prev) return null;
  const base = pathTail(file, 1) || file;
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  if (st.mtimeMs === prev.mtimeMs && st.size === prev.size) {
    // The previous Read was a range and this asks for lines outside it: that is a new range, not a re-read.
    if (!unchangedReread(file, input, log)) return null;
    return `kora: ${base} is already in context from an earlier Read (turn ${prev.turn}; unchanged since) — use what you have unless you need a different range. (If your context was compacted or cleared since then, it is gone: read it again.)`;
  }
  if (!prev.blocks.length) return `kora: ${base} changed since your last Read (turn ${prev.turn}).`;
  let next: { lines: number; blocks: string[] };
  try { next = blockHashes(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const ranges = changedRanges(prev, next);
  if (!ranges.length) return `kora: ${base} is already in context from an earlier Read (turn ${prev.turn}; touched but content unchanged) — use what you have unless you need a different range. (If your context was compacted since, read it again.)`;
  return `kora: ${base} changed since your last Read (turn ${prev.turn}) at lines ${fmtRanges(ranges)} — Read those ranges with offset/limit, not the whole file.`;
}
