// The delegation log (docs/bots/SPEC.md "Learn", ARCH 6.4): one row per delegated step that reached an end state, so
// Kora's capability cards can say what each blob did lately and what it is good or slow at. Append-only JSON lines in
// <KORA_HOME>/blobs/delegation.jsonl (the same convention as undo.jsonl): a user reaction is a patch row, folded on load.
// Runtime-computed, never model-written: the cards are built from these rows by cards.ts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { blobsStoreDir } from './home';

export type DelegationOutcome = 'done' | 'failed' | 'cancelled' | 'needs-you';
export type DelegationReaction = 'good' | 'redo' | null;

export interface DelegationRow {
  id: string;
  ts: number;
  jobId: string;
  stepId: string;
  blobId: string;
  /** Task kind, lower-kebab ("research", "market-scan"). */
  kind: string;
  /** Short task title. */
  title: string;
  /** The brief given to the blob, capped (the full text lives in the thread). */
  brief: string;
  outcome: DelegationOutcome;
  durationMs: number;
  tokens: number;
  reaction: DelegationReaction;
}

export type DelegationInput = Omit<DelegationRow, 'id' | 'ts' | 'reaction'> & { ts?: number; reaction?: DelegationReaction };

export interface BlobStats {
  /** Top task kinds: >= 2 done and no redo within the window. */
  goodAt: string[];
  /** Kinds where this blob's median duration is well above the rest of the team's. */
  slowAt: string[];
  done: number;
  failed: number;
}

export const DAY_MS = 24 * 3600_000;
export const GOOD_AT_WINDOW_MS = 90 * DAY_MS;
const BRIEF_CAP = 600;

export function normalizeKind(raw: string | null | undefined): string {
  const k = String(raw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return k || 'general';
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export class DelegationLog extends EventEmitter {
  private all: DelegationRow[] = [];
  private byId = new Map<string, DelegationRow>();
  private file: string | null;

  /** `file` null = in memory only (tests). Default: <KORA_HOME>/blobs/delegation.jsonl. */
  constructor(o: { file?: string | null } = {}) {
    super();
    this.file = o.file === undefined ? path.join(blobsStoreDir(), 'delegation.jsonl') : o.file;
    this.load();
  }

  private load(): void {
    if (!this.file) return;
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r: any; try { r = JSON.parse(line); } catch { continue; }
      if (r && typeof r.react === 'string') { const row = this.byId.get(r.react); if (row) row.reaction = r.reaction === 'good' || r.reaction === 'redo' ? r.reaction : null; continue; }
      if (r && typeof r.id === 'string' && typeof r.blobId === 'string') { this.all.push(r as DelegationRow); this.byId.set(r.id, r as DelegationRow); }
    }
  }

  private write(obj: unknown): void {
    if (!this.file) return;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.appendFileSync(this.file, JSON.stringify(obj) + '\n'); } catch { /* the log is advisory */ }
  }

  append(i: DelegationInput): DelegationRow {
    const row: DelegationRow = {
      id: `dlg_${crypto.randomBytes(5).toString('hex')}`, ts: i.ts ?? Date.now(), jobId: i.jobId, stepId: i.stepId, blobId: i.blobId,
      kind: normalizeKind(i.kind), title: i.title.slice(0, 120), brief: i.brief.slice(0, BRIEF_CAP), outcome: i.outcome,
      durationMs: Math.max(0, Math.round(i.durationMs)), tokens: Math.max(0, Math.round(i.tokens)), reaction: i.reaction ?? null,
    };
    this.all.push(row); this.byId.set(row.id, row);
    this.write(row);
    this.emit('appended', row);
    return row;
  }

  /** The user's (or Kora's) verdict on a finished step. Returns false when no row matches. */
  react(match: { rowId?: string; jobId?: string; stepId?: string }, reaction: 'good' | 'redo'): boolean {
    const row = match.rowId ? this.byId.get(match.rowId) : [...this.all].reverse().find((r) => r.jobId === match.jobId && r.stepId === match.stepId);
    if (!row) return false;
    row.reaction = reaction;
    this.write({ react: row.id, reaction, at: Date.now() });
    this.emit('appended', row);
    return true;
  }

  /** A deleted blob's rows go, from memory and from the file (rewritten without them, reactions folded in). */
  forgetBlob(blobId: string): number {
    const keep = this.all.filter((r) => r.blobId !== blobId);
    const dropped = this.all.length - keep.length;
    if (!dropped) return 0;
    this.all = keep;
    this.byId = new Map(keep.map((r) => [r.id, r]));
    if (this.file) {
      try {
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r) + '\n').join(''));
        fs.renameSync(tmp, this.file);
      } catch { /* the log is advisory */ }
    }
    return dropped;
  }

  rows(): readonly DelegationRow[] { return this.all; }
  forBlob(blobId: string): DelegationRow[] { return this.all.filter((r) => r.blobId === blobId); }
  forJob(jobId: string): DelegationRow[] { return this.all.filter((r) => r.jobId === jobId); }

  /** The blob's most recent finished rows (newest first). `needs-you` marker rows are skipped. */
  lately(blobId: string, n = 3): DelegationRow[] {
    return this.all.filter((r) => r.blobId === blobId && r.outcome !== 'needs-you').slice(-n).reverse();
  }

  /** Good-at / slow-at for one blob (ARCH 6.2). `now` is injectable for tests. */
  stats(blobId: string, now = Date.now()): BlobStats {
    const mine = this.forBlob(blobId);
    const since = now - GOOD_AT_WINDOW_MS;
    const recent = mine.filter((r) => r.ts >= since);
    const byKind = new Map<string, { done: number; redo: boolean; last: number }>();
    for (const r of recent) {
      const k = byKind.get(r.kind) ?? { done: 0, redo: false, last: 0 };
      if (r.outcome === 'done') k.done++;
      if (r.reaction === 'redo') k.redo = true;
      k.last = Math.max(k.last, r.ts);
      byKind.set(r.kind, k);
    }
    const goodAt = [...byKind.entries()].filter(([, v]) => v.done >= 2 && !v.redo).sort((a, b) => b[1].done - a[1].done || b[1].last - a[1].last).slice(0, 2).map(([k]) => k);

    // slow at: this blob's median for a kind > 1.5x the median of the other blobs' rows of that kind (>= 3 samples each side)
    const slowAt: string[] = [];
    const doneRows = (rs: DelegationRow[]) => rs.filter((r) => r.outcome === 'done' && r.durationMs > 0);
    for (const kind of new Set(doneRows(mine).map((r) => r.kind))) {
      const my = doneRows(mine).filter((r) => r.kind === kind);
      const others = doneRows(this.all.filter((r) => r.blobId !== blobId)).filter((r) => r.kind === kind);
      if (my.length >= 3 && others.length >= 3 && median(my.map((r) => r.durationMs)) > 1.5 * median(others.map((r) => r.durationMs))) slowAt.push(kind);
    }
    return { goodAt, slowAt: slowAt.slice(0, 2), done: mine.filter((r) => r.outcome === 'done').length, failed: mine.filter((r) => r.outcome === 'failed').length };
  }
}
