// Every allow/deny of an app action, one JSON line each: <KORA_HOME>/blobs/apps/decisions.jsonl. Arguments are never
// stored (they can hold message bodies and secrets): only their key names and a short hash.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type DecisionReason = 'granted' | 'not_granted' | 'user_approved' | 'user_denied' | 'no_approval_channel' | 'full_access_skip' | 'cap_reached' | 'not_connected' | 'account_required' | 'bad_request';

export interface DecisionRow {
  at: number;
  kind: 'decision' | 'result';
  blobId: string;
  threadId: string | null;
  tool: string;
  toolkit: string;
  account: string | null;
  decision: 'allow' | 'deny';
  reason: DecisionReason;
  outbound: boolean;
  mode: string;
  argKeys: string[];
  argHash: string;
  /** result rows only */
  outcome?: 'ok' | 'error' | string;
}

export const argFingerprint = (a: Record<string, unknown>) => ({
  argKeys: Object.keys(a).sort().slice(0, 30),
  argHash: crypto.createHash('sha256').update(JSON.stringify(a, Object.keys(a).sort())).digest('hex').slice(0, 12),
});

const MAX_BYTES = 2 * 1024 * 1024;

export class DecisionLog {
  constructor(private readonly file: string) {}
  append(row: DecisionRow): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      try { if (fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, this.file + '.1'); } catch { /* none yet */ }
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch { /* the log is advisory; it must never break a tool call */ }
  }
  recent(limit = 100, blobId?: string): DecisionRow[] {
    try {
      const rows = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as DecisionRow; } catch { return null; } }).filter((r): r is DecisionRow => !!r);
      return (blobId ? rows.filter((r) => r.blobId === blobId) : rows).slice(-limit);
    } catch { return []; }
  }
}
