// Every outside call, allowed or refused: who (token name), what (tool), against what (blob/thread id), outcome.
// Message text is never logged - only that a message was sent. jsonl, trimmed so it cannot grow without bound.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { outsideDir } from './tokens';
import type { AuditRow } from './types';

const MAX_ROWS = 2000;
const TRIM_AT = 2500;

export class AuditLog {
  private lines = -1;
  constructor(private readonly dir: string = outsideDir(), private readonly now: () => number = Date.now) {}
  private get file(): string { return path.join(this.dir, 'audit.jsonl'); }

  append(r: { tokenId: string; client: string; tool: string; target?: string | null; ok: boolean; note?: string | null }): AuditRow {
    const row: AuditRow = { id: crypto.randomBytes(5).toString('hex'), at: this.now(), tokenId: r.tokenId, client: r.client.slice(0, 60), tool: r.tool.slice(0, 40), target: r.target ? String(r.target).slice(0, 80) : null, ok: r.ok, note: r.note ? String(r.note).slice(0, 160) : null };
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n', { mode: 0o600 });
      if (this.lines < 0) this.lines = this.readAll().length; else this.lines++;
      if (this.lines > TRIM_AT) { const keep = this.readAll().slice(-MAX_ROWS); fs.writeFileSync(this.file, keep.map((k) => JSON.stringify(k)).join('\n') + '\n', { mode: 0o600 }); this.lines = keep.length; }
    } catch { /* an audit write must never break the call it records */ }
    return row;
  }

  private readAll(): AuditRow[] {
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const out: AuditRow[] = [];
    for (const l of raw.split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* torn line */ } }
    return out;
  }

  /** Newest first. `before` is an `at` cursor from the previous page's last row. */
  list(o: { limit?: number; before?: number; tokenId?: string } = {}): { rows: AuditRow[]; next: number | null } {
    const limit = Math.min(Math.max(Math.floor(o.limit ?? 50), 1), 200);
    let rows = this.readAll().reverse();
    if (o.tokenId) rows = rows.filter((r) => r.tokenId === o.tokenId);
    if (o.before !== undefined) rows = rows.filter((r) => r.at < o.before!);
    const page = rows.slice(0, limit);
    return { rows: page, next: rows.length > limit ? page[page.length - 1]!.at : null };
  }
}
