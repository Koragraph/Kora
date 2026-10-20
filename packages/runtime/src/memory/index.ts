/**
 * Blobs memory engine — public API.
 *
 *   const mem = openMemory({ dbPath, extractor, embedder?, now? })        // MemoryStore
 *
 *   // read path (every turn)
 *   await mem.recall({ blobId, query, budgetTokens = 1000, includeTeam?, touch? })
 *        → { core:{you,blob}, facts: Fact[], promptText, tokens:{core,memory,total} }
 *   mem.getCore(blobId) → { you, blob }          mem.setCore(scope, blobId, text)   // throws CoreTooLargeError
 *   mem.getTeamCore() / mem.setTeamCore(text)    // Chief's delegation notes
 *
 *   // write path (after each turn; never throws on model garbage)
 *   await mem.ingestTurn({ blobId, threadId, messageId, userText, assistantText, at, allowTeam? }) → Receipt[]
 *   mem.undo(receiptId) → boolean                 await mem.approvePending(id) → Receipt|null    mem.rejectPending(id)
 *   mem.listPending({ blobId? })                  mem.listReceipts({ blobId?, limit? })
 *
 *   // facts (Profile → Memory)
 *   mem.listFacts({ scope?, blobId?, includeRetired? })   mem.searchFacts({ blobId, query, includeRetired?, limit? })
 *   await mem.editFact(id, { text?, confidence?, important? })   mem.forgetFact(id)   mem.markImportant(id, on = true)
 *   mem.addFact({ scope, blobId?, text, important? })     // manual "remember this" (the user's own Memory tab: no checks)
 *   await mem.remember({ scope, blobId?, text, important?, replaces? }) → { outcome, fact, previous, receipt }   // the blob's tool: contradiction-aware
 *   mem.getFact(id)
 *
 *   // contradictions the blob should raise naturally (recall() also injects one, rate-limited)
 *   mem.pendingQuestions(blobId) → Question[]     await mem.resolveQuestion(id, 'old' | 'new') → Receipt|null
 *
 *   // episodes
 *   await mem.summarizeThread({ threadId, blobId, transcript }) → string
 *   mem.searchEpisodes({ blobId?, query, limit = 5 }) → EpisodeHit[]
 *
 *   // maintenance
 *   await mem.tidy({ blobId?, signal? }) → TidyReport      mem.needsTidy() → boolean
 *   mem.stats() → MemoryStats                              mem.close()
 *
 * Scopes: 'you' (every blob + Chief), 'blob' (private to one blobId), 'team' (Chief only: pass includeTeam / allowTeam).
 * Times are epoch milliseconds. All SQLite work is synchronous and small; anything slow (LLM, embedding, tidy) is async
 * and yields to the event loop. `now` is injectable for tests.
 */
import { statSync } from 'node:fs';
import type { Ctx, Row } from './ctx';
import type { Embedder, EpisodeHit, Extractor, Fact, PendingItem, Question, Receipt, Scope, TurnInput } from './types';
import { openDb } from './db';
import { tx } from './db';
import { getCore, readCore, writeCore, CoreTooLargeError } from './core';
import { addReceipt, deleteFact, embedFacts, purgeSources, sweepForgotten, retireFact, getFact, insertFact, rowToFact, rowToPending, rowToQuestion, searchVisible, setFactText, clamp01 } from './facts';
import { remember, type RememberArgs, type RememberResult } from './remember';
import { approvePending, ingestTurn, rejectPending, resolveQuestion, undo } from './ingest';
import { recall, type RecallArgs, type RecallResult } from './recall';
import { searchEpisodes, summarizeThread, type Transcript } from './episodes';
import { lastTidyAt, needsTidy, tidy, type TidyReport } from './tidy';
import { LIMITS } from './types';
import { cleanText, looksLikeSecret } from './text';

export type { Embedder, EpisodeHit, Extractor, Fact, PendingItem, Question, Receipt, Scope, TurnInput } from './types';
export type { RecallResult, RecallArgs } from './recall';
export type { RememberArgs, RememberResult } from './remember';
export { detectCorrections, slotOf } from './corrections';
export type { TidyReport } from './tidy';
export { CoreTooLargeError } from './core';
export { createHashEmbedder } from './embed';
export { LIMITS as MEMORY_LIMITS, DAY_MS } from './types';
export { estimateTokens, contentTokens, coverage, scrubSecrets } from './text';

export interface OpenMemoryOptions {
  /** SQLite file path, or ':memory:'. */
  dbPath: string;
  extractor: Extractor;
  embedder?: Embedder;
  now?: () => number;
  /** Per extractor call. Default 60 s. */
  extractTimeoutMs?: number; // the TOTAL deadline of one extraction (all attempts)
}

export interface ListFactsArgs {
  scope?: Scope;
  blobId?: string;
  includeRetired?: boolean;
}

export interface MemoryStats {
  schemaVersion: number;
  facts: { active: number; retired: number; byScope: Record<Scope, number>; important: number; embedded: number };
  pending: number;
  openQuestions: number;
  episodes: number;
  turns: number;
  receipts: number;
  embedder: string | null;
  lastTidyAt?: number;
  dbBytes: number;
}

export interface MemoryStore {
  recall(a: RecallArgs): Promise<RecallResult>;
  getCore(blobId: string): { you: string; blob: string; youUpdatedAt: number; blobUpdatedAt: number };
  setCore(scope: 'you' | 'blob', blobId: string, text: string): void;
  getTeamCore(): string;
  setTeamCore(text: string): void;
  ingestTurn(t: TurnInput): Promise<Receipt[]>;
  undo(receiptId: string): boolean;
  approvePending(id: string): Promise<Receipt | null>;
  rejectPending(id: string): boolean;
  listPending(a?: { blobId?: string }): PendingItem[];
  listReceipts(a?: { blobId?: string; limit?: number }): Array<Receipt & { undone: boolean }>;
  listFacts(a?: ListFactsArgs): Fact[];
  searchFacts(a: { blobId: string; query: string; includeRetired?: boolean; includeTeam?: boolean; limit?: number }): Fact[];
  getFact(id: string): Fact | undefined;
  addFact(a: { scope: Scope; blobId?: string; text: string; important?: boolean }): Promise<Fact>;
  /** The model-facing write: dedupe / replace what it contradicts / hold when sensitive / add - atomically, with a receipt. */
  remember(a: RememberArgs): Promise<RememberResult>;
  editFact(id: string, patch: { text?: string; confidence?: number; important?: boolean }): Promise<Fact | undefined>;
  forgetFact(id: string): boolean;
  /** Forget as the model does: the fact is retired (gone from recall and Core) and a receipt comes back, so `undo(receipt.id)` brings it back. null when it is not a live fact. */
  forgetWithReceipt(id: string): Receipt | null;
  markImportant(id: string, on?: boolean): boolean;
  pendingQuestions(blobId: string): Question[];
  resolveQuestion(id: string, keep: 'old' | 'new'): Promise<Receipt | null>;
  summarizeThread(a: { threadId: string; blobId: string; transcript: Transcript }): Promise<string>;
  searchEpisodes(a: { blobId?: string; query: string; limit?: number }): EpisodeHit[];
  tidy(a?: { blobId?: string; signal?: AbortSignal }): Promise<TidyReport>;
  needsTidy(): boolean;
  stats(): MemoryStats;
  /** Delete everything a blob owns: its private facts, core notes, episodes, turns, pending items, questions and receipts. */
  forgetBlob(blobId: string): { facts: number };
  close(): void;
}

export function openMemory(opts: OpenMemoryOptions): MemoryStore {
  const ctx: Ctx = {
    db: openDb(opts.dbPath),
    now: opts.now ?? Date.now,
    extractor: opts.extractor,
    embedder: opts.embedder,
    extractTimeoutMs: opts.extractTimeoutMs ?? 60_000,
    closed: false,
  };
  let tidying: Promise<TidyReport> | null = null;
  const count = (sql: string, ...p: any[]): number => Number((ctx.db.prepare(sql).get(...p) as Row).n); // eslint-disable-line @typescript-eslint/no-explicit-any

  return {
    recall: (a) => recall(ctx, a),
    getCore: (blobId) => getCore(ctx, blobId),
    setCore(scope, blobId, text) {
      writeCore(ctx, scope, blobId, text, 'user');
    },
    getTeamCore: () => readCore(ctx, 'team')?.text ?? '',
    setTeamCore(text) {
      writeCore(ctx, 'team', '', text, 'user');
    },

    ingestTurn: (t) => ingestTurn(ctx, t),
    undo: (id) => undo(ctx, id),
    approvePending: (id) => approvePending(ctx, id),
    rejectPending: (id) => rejectPending(ctx, id),
    listPending(a) {
      const rows = a?.blobId
        ? (ctx.db.prepare("SELECT * FROM pending WHERE status = 'open' AND (blob_id = ? OR scope = 'you') ORDER BY created_at").all(a.blobId) as Row[])
        : (ctx.db.prepare("SELECT * FROM pending WHERE status = 'open' ORDER BY created_at").all() as Row[]);
      return rows.map(rowToPending);
    },
    listReceipts(a) {
      const rows = (a?.blobId
        ? ctx.db.prepare('SELECT * FROM receipts WHERE blob_id = ? ORDER BY created_at DESC LIMIT ?').all(a.blobId, a.limit ?? 50)
        : ctx.db.prepare('SELECT * FROM receipts ORDER BY created_at DESC LIMIT ?').all(a?.limit ?? 50)) as Row[];
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        factId: r.fact_id,
        ...(r.pending_id ? { pendingId: r.pending_id } : {}),
        text: r.text,
        blobId: r.blob_id,
        createdAt: r.created_at,
        undone: r.undone_at != null,
      }));
    },

    listFacts(a = {}) {
      tx(ctx.db, () => sweepForgotten(ctx));
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (!a.includeRetired) where.push('until IS NULL');
      if (a.scope) {
        where.push('scope = ?');
        params.push(a.scope);
        if (a.scope === 'blob' && a.blobId) {
          where.push('blob_id = ?');
          params.push(a.blobId);
        }
      } else if (a.blobId) {
        where.push("(scope = 'you' OR (scope = 'blob' AND blob_id = ?))");
        params.push(a.blobId);
      }
      const rows = ctx.db.prepare(`SELECT * FROM facts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`).all(...params) as Row[];
      return rows.map(rowToFact);
    },
    searchFacts(a) {
      return searchVisible(ctx, { blobId: a.blobId, includeTeam: a.includeTeam }, a.query, { includeRetired: a.includeRetired, limit: a.limit ?? 20 })
        .sort((x, y) => y.lex - x.lex)
        .map((h) => h.fact);
    },
    getFact: (id) => getFact(ctx, id),
    remember: (a) => remember(ctx, a),
    async addFact(a) {
      const text = cleanText(a.text, LIMITS.factMaxChars);
      if (!text) throw new Error('empty fact');
      if (looksLikeSecret(text)) throw new Error('refusing to store what looks like a credential or ID number');
      const f = tx(ctx.db, () => insertFact(ctx, { scope: a.scope, blobId: a.blobId, text, confidence: 1, important: a.important, threadId: null, messageId: null }));
      await embedFacts(ctx, [f.id]);
      return getFact(ctx, f.id)!;
    },
    async editFact(id, patch) {
      let reembed = false;
      tx(ctx.db, () => {
        if (patch.text !== undefined) {
          const text = cleanText(patch.text, LIMITS.factMaxChars);
          if (!text || looksLikeSecret(text)) throw new Error('invalid fact text');
          setFactText(ctx, id, text);
          reembed = true;
        }
        if (patch.confidence !== undefined) ctx.db.prepare('UPDATE facts SET confidence = ? WHERE id = ?').run(clamp01(patch.confidence), id);
        if (patch.important !== undefined) ctx.db.prepare('UPDATE facts SET important = ? WHERE id = ?').run(patch.important ? 1 : 0, id);
      });
      if (reembed) await embedFacts(ctx, [id]);
      return getFact(ctx, id);
    },
    forgetFact: (id) => tx(ctx.db, () => deleteFact(ctx, id)),
    // The model's Forget: the raw turns, search rows and summaries that say it go now (they cannot be undone anyway); the
    // fact row is retired for the receipt's Undo and deleted for real once that window passes (sweepForgotten).
    forgetWithReceipt: (id) =>
      tx(ctx.db, () => {
        sweepForgotten(ctx);
        const f = getFact(ctx, id);
        if (!f || f.until != null || !retireFact(ctx, id, 'forgotten')) return null;
        purgeSources(ctx, f);
        return addReceipt(ctx, { kind: 'retired', factId: id, blobId: f.blobId ?? '', text: f.text, undo: { factId: id } });
      }),
    markImportant(id, on = true) {
      return Number(ctx.db.prepare('UPDATE facts SET important = ? WHERE id = ?').run(on ? 1 : 0, id).changes) > 0;
    },

    pendingQuestions(blobId) {
      const rows = ctx.db.prepare("SELECT * FROM questions WHERE status = 'open' AND (blob_id = ? OR blob_id IS NULL) ORDER BY created_at").all(blobId) as Row[];
      return rows.map(rowToQuestion);
    },
    resolveQuestion: (id, keep) => resolveQuestion(ctx, id, keep),

    summarizeThread: (a) => summarizeThread(ctx, a),
    searchEpisodes: (a) => searchEpisodes(ctx, a),

    tidy(a) {
      // one tidy at a time; concurrent callers share the in-flight run
      if (!tidying) tidying = tidy(ctx, a ?? {}).finally(() => (tidying = null));
      return tidying;
    },
    needsTidy: () => needsTidy(ctx),

    stats() {
      const by = (s: Scope) => count("SELECT COUNT(*) AS n FROM facts WHERE until IS NULL AND scope = ?", s);
      let dbBytes = 0;
      try {
        dbBytes = opts.dbPath === ':memory:' ? 0 : statSync(opts.dbPath).size;
      } catch {
        /* ignore */
      }
      return {
        schemaVersion: Number((ctx.db.prepare('PRAGMA user_version').get() as Row).user_version),
        facts: {
          active: count('SELECT COUNT(*) AS n FROM facts WHERE until IS NULL'),
          retired: count('SELECT COUNT(*) AS n FROM facts WHERE until IS NOT NULL'),
          byScope: { you: by('you'), blob: by('blob'), team: by('team') },
          important: count('SELECT COUNT(*) AS n FROM facts WHERE until IS NULL AND important = 1'),
          embedded: count('SELECT COUNT(*) AS n FROM facts WHERE embedding IS NOT NULL'),
        },
        pending: count("SELECT COUNT(*) AS n FROM pending WHERE status = 'open'"),
        openQuestions: count("SELECT COUNT(*) AS n FROM questions WHERE status = 'open'"),
        episodes: count('SELECT COUNT(*) AS n FROM episodes'),
        turns: count('SELECT COUNT(*) AS n FROM turns'),
        receipts: count('SELECT COUNT(*) AS n FROM receipts'),
        embedder: ctx.embedder?.id ?? null,
        lastTidyAt: lastTidyAt(ctx),
        dbBytes,
      };
    },
    forgetBlob(blobId) {
      return tx(ctx.db, () => {
        const ids = (ctx.db.prepare("SELECT id FROM facts WHERE scope = 'blob' AND blob_id = ?").all(blobId) as Row[]).map((r) => r.id as string);
        for (const id of ids) deleteFact(ctx, id);
        ctx.db.prepare("DELETE FROM core WHERE scope = 'blob' AND blob_id = ?").run(blobId);
        ctx.db.prepare("DELETE FROM ep_fts WHERE blob_id = ?").run(blobId);
        ctx.db.prepare('DELETE FROM episodes WHERE blob_id = ?').run(blobId);
        ctx.db.prepare('DELETE FROM turns WHERE blob_id = ?').run(blobId);
        ctx.db.prepare('DELETE FROM pending WHERE blob_id = ?').run(blobId);
        ctx.db.prepare('DELETE FROM questions WHERE blob_id = ?').run(blobId);
        ctx.db.prepare('DELETE FROM receipts WHERE blob_id = ?').run(blobId);
        return { facts: ids.length };
      });
    },
    close() {
      if (ctx.closed) return;
      ctx.closed = true;
      try {
        ctx.db.close();
      } catch {
        /* already closed */
      }
    },
  };
}
