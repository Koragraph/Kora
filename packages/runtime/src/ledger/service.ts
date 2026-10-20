// Per-pane ledger: tails the pane's transcript and re-summarises when it grows. Cheap: a stat per second per
// pane, and a full re-parse only when the file changed (transcripts are append-only and a session is a few MB
// at most). Emits `ledger.updated`; the server merges the summary into PaneInfo.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { parseTranscript, summarize, LedgerSummary, Session } from './transcript';

export class LedgerService extends EventEmitter {
  private watched = new Map<string, { file: string; size: number; timer: NodeJS.Timeout | null; summary: LedgerSummary | null; session: Session | null }>();
  attach(paneId: string, file: string) {
    const cur = this.watched.get(paneId);
    if (cur && cur.file === file) return;
    if (cur) this.detach(paneId);
    const entry = { file, size: -1, timer: null as NodeJS.Timeout | null, summary: null as LedgerSummary | null, session: null as Session | null };
    this.watched.set(paneId, entry);
    const tick = () => { this.refresh(paneId); };
    entry.timer = setInterval(tick, 1000); entry.timer.unref();
    tick();
  }
  detach(paneId: string) { const e = this.watched.get(paneId); if (!e) return; if (e.timer) clearInterval(e.timer); this.watched.delete(paneId); }
  refresh(paneId: string): LedgerSummary | null {
    const e = this.watched.get(paneId); if (!e) return null;
    let st: fs.Stats; try { st = fs.statSync(e.file); } catch { return e.summary; }
    if (st.size === e.size) return e.summary;
    e.size = st.size;
    try {
      e.session = parseTranscript(e.file); e.summary = summarize(e.session);
      this.emit('updated', paneId, e.summary);
    } catch (err) { this.emit('error', paneId, err); }
    return e.summary;
  }
  get(paneId: string): LedgerSummary | null { return this.watched.get(paneId)?.summary ?? null; }
  session(paneId: string): Session | null { return this.watched.get(paneId)?.session ?? null; }
  all(): { paneId: string; summary: LedgerSummary }[] { return [...this.watched.entries()].filter(([, e]) => e.summary).map(([paneId, e]) => ({ paneId, summary: e.summary! })); }
  totals(): { costUsd: number; cacheSavedUsd: number; context: number; graphCalls: number; reads: number; greps: number } {
    const t = { costUsd: 0, cacheSavedUsd: 0, context: 0, graphCalls: 0, reads: 0, greps: 0 };
    for (const { summary: s } of this.all()) { t.costUsd += s.costUsd; t.cacheSavedUsd += s.cacheSavedUsd; t.context += s.context; t.graphCalls += s.graphCalls; t.reads += s.reads; t.greps += s.greps; }
    return t;
  }
}
