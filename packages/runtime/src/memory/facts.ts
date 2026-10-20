// Low-level fact / pending / question / receipt storage + visibility-safe search. All functions are synchronous.
import { createHash, randomUUID } from 'node:crypto';
import type { Ctx, Row } from './ctx';
import type { Fact, PendingItem, Question, Receipt, ReceiptKind, Scope } from './types';
import { DAY_MS, LIMITS } from './types';
import { contentTokens, coverage, ftsQuery, jaccard, normalize, words } from './text';
import { cosine, decodeVec } from './embed';
import { scrubCore } from './core';

export const newId = (p: string): string => `${p}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

export function rowToFact(r: Row): Fact {
  return {
    id: r.id,
    scope: r.scope,
    ...(r.blob_id ? { blobId: r.blob_id } : {}),
    text: r.text,
    since: r.since,
    ...(r.until != null ? { until: r.until } : {}),
    confidence: r.confidence,
    important: !!r.important,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count ?? 0,
    source: { threadId: r.thread_id ?? null, messageId: r.message_id ?? null },
    ...(r.retired_reason ? { retiredReason: r.retired_reason } : {}),
    ...(r.superseded_by ? { supersededBy: r.superseded_by } : {}),
  };
}

export function getFact(ctx: Ctx, id: string): Fact | undefined {
  const r = ctx.db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as Row | undefined;
  return r ? rowToFact(r) : undefined;
}

export interface NewFact {
  scope: Scope;
  blobId?: string | null;
  text: string;
  since?: number;
  confidence?: number;
  important?: boolean;
  threadId?: string | null;
  messageId?: string | null;
}

export function insertFact(ctx: Ctx, f: NewFact): Fact {
  const id = newId('f');
  const now = ctx.now();
  const blobId = f.scope === 'blob' ? (f.blobId ?? null) : null;
  if (f.scope === 'blob' && !blobId) throw new Error('blob-scoped fact needs a blobId');
  ctx.db
    .prepare(
      `INSERT INTO facts(id, scope, blob_id, text, since, confidence, important, created_at, last_used_at, thread_id, message_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, f.scope, blobId, f.text, f.since ?? now, clamp01(f.confidence ?? 0.8), f.important ? 1 : 0, now, now, f.threadId ?? null, f.messageId ?? null);
  ctx.db.prepare('INSERT INTO facts_fts(text, fid) VALUES(?, ?)').run(f.text, id);
  return getFact(ctx, id)!;
}

export const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.7);

export function retireFact(ctx: Ctx, id: string, reason: string, supersededBy?: string): boolean {
  const r = ctx.db
    .prepare('UPDATE facts SET until = ?, retired_reason = ?, superseded_by = ? WHERE id = ? AND until IS NULL')
    .run(ctx.now(), reason, supersededBy ?? null, id);
  if (Number(r.changes) === 0) return false;
  // never leave a retired fact standing in the always-injected Core notes
  const old = getFact(ctx, id);
  const next = supersededBy ? getFact(ctx, supersededBy) : undefined;
  if (old) scrubCore(ctx, old.text, next?.text, id);
  return true;
}

export function reactivateFact(ctx: Ctx, id: string): boolean {
  const r = ctx.db.prepare('UPDATE facts SET until = NULL, retired_reason = NULL, superseded_by = NULL, last_used_at = ? WHERE id = ? AND until IS NOT NULL').run(ctx.now(), id);
  return Number(r.changes) > 0;
}

export function setFactText(ctx: Ctx, id: string, text: string): void {
  ctx.db.prepare('UPDATE facts SET text = ?, embedding = NULL, emb_model = NULL WHERE id = ?').run(text, id);
  ctx.db.prepare('DELETE FROM facts_fts WHERE fid = ?').run(id);
  ctx.db.prepare('INSERT INTO facts_fts(text, fid) VALUES(?, ?)').run(text, id);
}

export function deleteFact(ctx: Ctx, id: string): boolean {
  const old = getFact(ctx, id);
  if (old && old.until == null) scrubCore(ctx, old.text, undefined, id);
  ctx.db.prepare('DELETE FROM facts_fts WHERE fid = ?').run(id);
  if (old) purgeSources(ctx, old);
  return Number(ctx.db.prepare('DELETE FROM facts WHERE id = ?').run(id).changes) > 0;
}

/** Retired-by-Forget facts are kept this long for the receipt's Undo, then deleted for real. */
export const FORGOTTEN_UNDO_MS = DAY_MS;
const TOMBSTONE_TTL_MS = 30 * DAY_MS;

/** What identifies a fact on its own: numbers (3+ digits, however they are punctuated), emails, words with digits. */
function strongTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.toLowerCase().match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []) out.add(m);
  for (const m of text.match(/\d(?:[\d\s().-]*\d)?/g) ?? []) { const d = m.replace(/\D/g, ''); if (d.length >= 3) out.add(d); }
  for (const w of words(text)) if (w.length >= 3 && /\d/.test(w) && /\p{L}/u.test(w)) out.add(w);
  return [...out];
}
interface ForgetKey { strong: string[]; words: string[] }
const forgetKey = (text: string): ForgetKey => ({ strong: strongTokens(text), words: [...new Set(contentTokens(text))] });
/** Does `text` say the forgotten thing? Any identifying token, or most of its words (all of them for a short fact). */
function saysIt(key: ForgetKey, text: string, hashFn: (s: string) => string = (x) => x): boolean {
  const strong = new Set(strongTokens(text).map(hashFn));
  if (key.strong.some((t) => strong.has(t))) return true;
  if (!key.words.length) return false;
  const have = new Set(contentTokens(text).map(hashFn));
  const hit = key.words.filter((w) => have.has(w)).length;
  return key.words.length <= 2 ? hit === key.words.length : hit >= 2 && hit / key.words.length >= 0.6;
}
const h = (s: string): string => createHash('sha256').update(`kora-forget:${s}`).digest('hex').slice(0, 16);

/**
 * Forget means forget: the raw exchange the fact came from (turns + the episode search index), the thread summaries that
 * repeat it, open held items that say it and every receipt that quotes it go too. A turn goes when it says the fact
 * (an identifying token such as the number or email, or most of its words), not only when it says every word: "Actually
 * my phone is 555-0199" said the forgotten "Your reservation phone number is 555-0199". A tombstone (hashed tokens, no
 * text) and the purged turn ids stop the retry queue from re-indexing or re-learning it.
 */
export function purgeSources(ctx: Ctx, f: Fact): void {
  const key = forgetKey(f.text);
  const dropTurn = (turnId: string) => {
    const t = ctx.db.prepare('SELECT thread_id, message_id FROM turns WHERE id = ?').get(turnId) as Row | undefined;
    if (t) ctx.db.prepare('INSERT OR IGNORE INTO purged_turns(thread_id, message_id, at) VALUES(?,?,?)').run(t.thread_id, t.message_id, ctx.now());
    ctx.db.prepare("DELETE FROM ep_fts WHERE kind = 'turn' AND ref = ?").run(turnId);
    ctx.db.prepare('DELETE FROM turns WHERE id = ?').run(turnId);
  };
  if (f.source.messageId) {
    for (const r of ctx.db.prepare('SELECT id FROM turns WHERE message_id = ?').all(f.source.messageId) as Row[]) dropTurn(r.id);
  }
  // The tool records the daemon's thread id while turns are stored under the UI thread id, so the thread filter alone
  // missed them (live QA 2026-10-10): also scan the most recent turns of any thread.
  if (key.strong.length || key.words.length) {
    const scan = ctx.db.prepare('SELECT id, text FROM turns WHERE thread_id = ? OR id IN (SELECT id FROM turns ORDER BY at DESC LIMIT 2000)').all(f.source.threadId ?? '') as Row[];
    for (const r of scan) if (saysIt(key, String(r.text))) dropTurn(r.id);
    // Summaries are not verbatim but they repeat the detail: drop the ones that say it (the next idle pass writes a new one).
    for (const e of ctx.db.prepare('SELECT id, summary FROM episodes').all() as Row[]) {
      if (!saysIt(key, String(e.summary))) continue;
      ctx.db.prepare("DELETE FROM ep_fts WHERE kind = 'summary' AND ref = ?").run(e.id);
      ctx.db.prepare('DELETE FROM episodes WHERE id = ?').run(e.id);
    }
    for (const p of ctx.db.prepare("SELECT id, text FROM pending WHERE status = 'open'").all() as Row[]) {
      if (saysIt(key, String(p.text))) ctx.db.prepare('DELETE FROM pending WHERE id = ?').run(p.id);
    }
    ctx.db.prepare('INSERT INTO forgotten(id, fact_id, tokens, at) VALUES(?,?,?,?)').run(newId('x'), f.id, JSON.stringify({ strong: key.strong.map(h), words: key.words.map(h) }), ctx.now());
  }
  ctx.db.prepare('DELETE FROM receipts WHERE fact_id = ?').run(f.id);
}

/**
 * Was this turn forgotten after it happened? Its id was purged by Forget, or it says a fact forgotten later than it was
 * said. The retry queue replays old turns: without this, a forgotten fact came back as a held card (pl7 S2-1).
 */
export function turnForgotten(ctx: Ctx, t: { threadId: string; messageId: string; at: number }, text: string): boolean {
  if (ctx.db.prepare('SELECT 1 FROM purged_turns WHERE thread_id = ? AND message_id = ?').get(t.threadId, t.messageId)) return true;
  for (const r of ctx.db.prepare('SELECT tokens FROM forgotten WHERE at > ?').all(t.at) as Row[]) {
    try { if (saysIt(JSON.parse(String(r.tokens)) as ForgetKey, text, h)) return true; } catch { /* a bad row never blocks */ }
  }
  return false;
}

/** Hard-delete facts the model forgot once their Undo window has passed, and drop old tombstones. */
export function sweepForgotten(ctx: Ctx): void {
  const cutoff = ctx.now() - FORGOTTEN_UNDO_MS;
  for (const r of ctx.db.prepare("SELECT id FROM facts WHERE retired_reason = 'forgotten' AND until < ?").all(cutoff) as Row[]) deleteFact(ctx, r.id);
  ctx.db.prepare('DELETE FROM forgotten WHERE at < ?').run(ctx.now() - TOMBSTONE_TTL_MS);
  ctx.db.prepare('DELETE FROM purged_turns WHERE at < ?').run(ctx.now() - TOMBSTONE_TTL_MS);
}

/** Embed (async) and store vectors for the given fact ids. Never throws. */
export async function embedFacts(ctx: Ctx, ids: string[]): Promise<void> {
  if (!ctx.embedder || ids.length === 0) return;
  try {
    const rows = ids.map((id) => ctx.db.prepare('SELECT id, text FROM facts WHERE id = ?').get(id) as Row | undefined).filter(Boolean) as Row[];
    const vecs = await ctx.embedder.embed(rows.map((r) => r.text));
    if (ctx.closed) return;
    rows.forEach((r, i) => {
      const v = vecs[i];
      if (v && v.length === ctx.embedder!.dims) {
        ctx.db.prepare('UPDATE facts SET embedding = ?, emb_model = ? WHERE id = ?').run(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)), ctx.embedder!.id, r.id);
      }
    });
  } catch {
    /* embeddings are optional */
  }
}

// ---------- receipts ----------

export function addReceipt(ctx: Ctx, r: { kind: ReceiptKind; factId: string; pendingId?: string; blobId: string; text: string; previousText?: string; undo: object }): Receipt {
  const id = newId('r');
  const createdAt = ctx.now();
  ctx.db
    .prepare('INSERT INTO receipts(id, kind, fact_id, pending_id, blob_id, text, undo, created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, r.kind, r.factId, r.pendingId ?? null, r.blobId, r.text, JSON.stringify(r.undo), createdAt);
  return { id, kind: r.kind, factId: r.factId, ...(r.pendingId ? { pendingId: r.pendingId } : {}), text: r.text, ...(r.previousText ? { previousText: r.previousText } : {}), blobId: r.blobId, createdAt };
}

// ---------- pending ----------

export function rowToPending(r: Row): PendingItem {
  return {
    id: r.id,
    kind: r.kind,
    scope: r.scope,
    blobId: r.blob_id ?? null,
    text: r.text,
    ...(r.target_fact_id ? { targetFactId: r.target_fact_id } : {}),
    reason: r.reason,
    confidence: r.confidence,
    createdAt: r.created_at,
    source: { threadId: r.thread_id ?? null, messageId: r.message_id ?? null },
  };
}

// ---------- questions ----------

export function rowToQuestion(r: Row): Question {
  return {
    id: r.id,
    blobId: r.blob_id ?? null,
    scope: r.scope,
    text: r.text,
    factIds: JSON.parse(r.fact_ids),
    ...(r.proposed ? { proposed: r.proposed } : {}),
    createdAt: r.created_at,
  };
}

export function addQuestion(ctx: Ctx, q: { blobId: string | null; scope: Scope; text: string; factIds: string[]; proposed?: string; threadId?: string | null; messageId?: string | null }): Question | null {
  // do not stack identical open questions
  const dupe = ctx.db.prepare("SELECT id FROM questions WHERE status = 'open' AND fact_ids = ? AND COALESCE(proposed,'') = ?").get(JSON.stringify(q.factIds), q.proposed ?? '') as Row | undefined;
  if (dupe) return null;
  const id = newId('q');
  ctx.db
    .prepare('INSERT INTO questions(id, blob_id, scope, text, fact_ids, proposed, thread_id, message_id, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, q.blobId, q.scope, q.text, JSON.stringify(q.factIds), q.proposed ?? null, q.threadId ?? null, q.messageId ?? null, ctx.now());
  return rowToQuestion(ctx.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Row);
}

// ---------- search (visibility-safe) ----------

export interface Visibility {
  blobId: string;
  includeTeam?: boolean;
}

const visSql = (v: Visibility) => `(f.scope = 'you' OR (f.scope = 'blob' AND f.blob_id = @blob)${v.includeTeam ? " OR f.scope = 'team'" : ''})`;

/** The newest active facts visible to a blob (by creation time): candidates for a correction that shares no word with the old fact. */
export function recentVisible(ctx: Ctx, v: Visibility, limit: number): Fact[] {
  const rows = ctx.db.prepare(`SELECT f.* FROM facts f WHERE f.until IS NULL AND ${visSql(v)} ORDER BY f.created_at DESC LIMIT @limit`).all({ blob: v.blobId, limit }) as Row[];
  return rows.map(rowToFact);
}

/** Every active fact a blob can see (bounded): the pool a correction or contradiction check scans. */
export function allVisible(ctx: Ctx, v: Visibility, limit = 400): Fact[] {
  const rows = ctx.db.prepare(`SELECT f.* FROM facts f WHERE f.until IS NULL AND ${visSql(v)} ORDER BY f.created_at DESC LIMIT @limit`).all({ blob: v.blobId, limit }) as Row[];
  return rows.map(rowToFact);
}

export interface Hit {
  fact: Fact;
  lex: number; // 0..1
  sem: number; // 0..1
}

/**
 * Candidates a blob may see, scored lexically (BM25 + token coverage) and, when an embedder is present, semantically.
 * Another blob's private facts are excluded in SQL, never post-filtered.
 */
export function searchVisible(ctx: Ctx, v: Visibility, query: string, opts: { limit?: number; qvec?: Float32Array | null; includeRetired?: boolean } = {}): Hit[] {
  const limit = opts.limit ?? 60;
  const retiredSql = opts.includeRetired ? '' : 'AND f.until IS NULL';
  const hits = new Map<string, Hit>();
  const q = ftsQuery(query);
  if (q) {
    const rows = ctx.db
      .prepare(
        `SELECT f.*, bm25(facts_fts) AS b FROM facts_fts JOIN facts f ON f.id = facts_fts.fid
         WHERE facts_fts MATCH @q ${retiredSql} AND ${visSql(v)} ORDER BY b LIMIT @limit`,
      )
      .all({ q, blob: v.blobId, limit }) as Row[];
    const qt = contentTokens(query);
    const best = rows.reduce((m, r) => Math.max(m, -r.b), 0) || 1;
    for (const r of rows) {
      const lex = 0.4 * (-r.b / best) + 0.6 * coverage(qt, r.text);
      hits.set(r.id, { fact: rowToFact(r), lex, sem: 0 });
    }
  }
  if (opts.qvec && ctx.embedder) {
    const rows = ctx.db
      .prepare(`SELECT f.* FROM facts f WHERE f.embedding IS NOT NULL AND f.emb_model = @m ${retiredSql} AND ${visSql(v)} ORDER BY f.last_used_at DESC LIMIT 3000`)
      .all({ m: ctx.embedder.id, blob: v.blobId }) as Row[];
    const scored: Array<{ r: Row; s: number }> = [];
    for (const r of rows) {
      const vec = decodeVec(r.embedding);
      if (vec) scored.push({ r, s: cosine(opts.qvec, vec) });
    }
    scored.sort((a, b) => b.s - a.s);
    for (const { r, s } of scored.slice(0, 20)) {
      if (s < 0.3) break;
      const h = hits.get(r.id) ?? { fact: rowToFact(r), lex: 0, sem: 0 };
      h.sem = Math.min(1, s);
      hits.set(r.id, h);
    }
  }
  return [...hits.values()];
}

export function isDecayed(f: Fact, now: number): boolean {
  if (f.important) return false;
  return now - Math.max(f.lastUsedAt, f.createdAt) > LIMITS.decayDays * DAY_MS;
}

/** Existing active fact in the same scope that says (nearly) the same thing. */
export function findDuplicate(ctx: Ctx, scope: Scope, blobId: string | null, text: string): Fact | undefined {
  const norm = normalize(text);
  const rows = searchVisible(ctx, { blobId: blobId ?? '', includeTeam: scope === 'team' }, text, { limit: 12 });
  for (const h of rows) {
    if (h.fact.scope !== scope) continue;
    if (scope === 'blob' && h.fact.blobId !== blobId) continue;
    if (normalize(h.fact.text) === norm || jaccard(h.fact.text, text) >= 0.85) return h.fact;
  }
  return undefined;
}
