// Per-blob token totals ("usage is shown per blob, even in Free"). The SessionManager feeds every settled turn that
// carries usage; totals persist in <KORA_HOME>/blobs/usage.json (debounced, tmp+rename). Same shape as the contract's
// TokenTotals: input EXCLUDES cache reads, `cached` is the cache traffic, `turns` counts settled turns.
import fs from 'node:fs';
import path from 'node:path';
import { blobsStoreDir } from './home';
import { writeFileAtomic } from './store';
import type { TokenTotals } from './types';

interface Persisted { v: 1; blobs: Record<string, { total: TokenTotals; threads: Record<string, TokenTotals> }> }
const zero = (): TokenTotals => ({ input: 0, cached: 0, output: 0, turns: 0 });
const add = (a: TokenTotals, u: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }): void => {
  a.input += Math.max(0, u.inputTokens ?? 0); a.cached += Math.max(0, u.cachedInputTokens ?? 0); a.output += Math.max(0, u.outputTokens ?? 0); a.turns += 1;
};

export class BlobUsageLedger {
  private data: Persisted = { v: 1, blobs: {} };
  private timer: NodeJS.Timeout | null = null;
  private file = () => path.join(blobsStoreDir(), 'usage.json');

  constructor() {
    try { const j = JSON.parse(fs.readFileSync(this.file(), 'utf8')); if (j?.v === 1 && j.blobs) this.data = j; } catch { /* fresh */ }
  }

  record(blobId: string, threadId: string, usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }): void {
    const b = (this.data.blobs[blobId] ??= { total: zero(), threads: {} });
    add(b.total, usage);
    add((b.threads[threadId] ??= zero()), usage);
    if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 3000); this.timer.unref(); }
  }

  total(blobId: string): TokenTotals { return { ...(this.data.blobs[blobId]?.total ?? zero()) }; }
  byThread(blobId: string): Array<{ threadId: string; totals: TokenTotals }> {
    return Object.entries(this.data.blobs[blobId]?.threads ?? {}).map(([threadId, totals]) => ({ threadId, totals: { ...totals } }));
  }
  all(): Map<string, TokenTotals> { return new Map(Object.entries(this.data.blobs).map(([id, b]) => [id, { ...b.total }])); }
  forget(blobId: string): void { delete this.data.blobs[blobId]; this.flush(); }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { writeFileAtomic(this.file(), JSON.stringify(this.data)); } catch { /* advisory */ }
  }
}
