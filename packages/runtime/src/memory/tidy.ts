// Background maintenance. Designed for a nightly run on a free model: chunked (yields to the event loop),
// cancellable (AbortSignal), idempotent (inputs are hashed; unchanged groups are skipped) and safe to fail
// (every LLM step is optional — the mechanical steps still run).
import { createHash } from 'node:crypto';
import type { Ctx, Row } from './ctx';
import { askJson, slicer } from './ctx';
import type { Fact, Receipt, Scope } from './types';
import { DAY_MS, LIMITS } from './types';
import { tx } from './db';
import { contentTokens, estimateTokens } from './text';
import { addQuestion, addReceipt, embedFacts, retireFact, rowToFact } from './facts';
import { coreCap, readCore, writeCore } from './core';
import { renderFact } from './subject';

export interface TidyReport {
  dedupedFacts: number;
  retiredStale: number;
  contradictionsResolved: number;
  questionsRaised: number;
  coresRefreshed: string[];
  reembedded: number;
  prunedTurns: number;
  llmCalls: number;
  cancelled: boolean;
  /** Undoable record of every automatic retirement. */
  receipts: Receipt[];
}

interface Group {
  scope: Scope;
  blobId: string | null;
}

const meta = (ctx: Ctx, k: string): string | undefined => (ctx.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as Row | undefined)?.v;
const setMeta = (ctx: Ctx, k: string, v: string) => ctx.db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
const hash = (s: string) => createHash('sha1').update(s).digest('hex');
const gkey = (g: Group) => `${g.scope}:${g.blobId ?? ''}`;

function groupsFor(ctx: Ctx, blobId?: string): Group[] {
  const rows = ctx.db.prepare('SELECT DISTINCT scope, blob_id FROM facts WHERE until IS NULL').all() as Row[];
  const all: Group[] = rows.map((r) => ({ scope: r.scope, blobId: r.blob_id ?? null }));
  return blobId ? all.filter((g) => g.scope === 'you' || (g.scope === 'blob' && g.blobId === blobId)) : all;
}

function activeFacts(ctx: Ctx, g: Group, limit = 800): Fact[] {
  const rows = ctx.db
    .prepare(`SELECT * FROM facts WHERE until IS NULL AND scope = ? AND COALESCE(blob_id,'') = ? ORDER BY created_at DESC LIMIT ?`)
    .all(g.scope, g.blobId ?? '', limit) as Row[];
  return rows.map(rowToFact);
}

const rank = (f: Fact) => (f.important ? 1e6 : 0) + f.useCount * 100 + f.confidence * 10 - f.createdAt / 1e13;

function merge(ctx: Ctx, keep: Fact, drop: Fact, blobId: string, rep: TidyReport): void {
  ctx.db.prepare('UPDATE facts SET important = ?, confidence = ?, since = ?, use_count = use_count + ? WHERE id = ?').run(
    keep.important || drop.important ? 1 : 0,
    Math.max(keep.confidence, drop.confidence),
    Math.min(keep.since, drop.since),
    drop.useCount,
    keep.id,
  );
  if (retireFact(ctx, drop.id, 'duplicate', keep.id)) {
    rep.dedupedFacts++;
    rep.receipts.push(addReceipt(ctx, { kind: 'retired', factId: drop.id, blobId, text: drop.text, undo: { factId: drop.id } }));
  }
}

async function dedupe(ctx: Ctx, g: Group, rep: TidyReport, signal?: AbortSignal): Promise<void> {
  const facts = activeFacts(ctx, g);
  const sets = facts.map((f) => new Set(contentTokens(f.text)));
  const gone = new Set<number>();
  const slice = slicer();
  for (let i = 0; i < facts.length; i++) {
    if (signal?.aborted) return;
    await slice();
    if (gone.has(i) || sets[i].size === 0) continue;
    for (let j = i + 1; j < facts.length; j++) {
      if (gone.has(j) || sets[j].size === 0) continue;
      let inter = 0;
      for (const t of sets[i]) if (sets[j].has(t)) inter++;
      if (inter / (sets[i].size + sets[j].size - inter) < 0.8) continue;
      const [keep, drop, dropIdx] = rank(facts[i]) >= rank(facts[j]) ? [facts[i], facts[j], j] : [facts[j], facts[i], i];
      tx(ctx.db, () => merge(ctx, keep, drop, g.blobId ?? '', rep));
      gone.add(dropIdx);
      if (dropIdx === i) break;
    }
  }
}

const TIDY_SYSTEM = `You tidy an AI coworker's memory about a user. You get numbered facts. Find (a) duplicates that say the same thing and (b) contradictions where two facts cannot both be true now.
Reply with ONLY JSON: {"merge":[{"keep":"F1","drop":["F4"]}],"conflicts":[{"older":"F2","newer":"F3","resolution":"newer"|"ask"}]}
Use "newer" only if the newer fact clearly replaces the older one; otherwise "ask". Use empty arrays when there is nothing. Do not invent ids.`;

const tidySchemaParse = (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { merge?: unknown; conflicts?: unknown };
  const merges: Array<{ keep: string; drop: string[] }> = [];
  const conflicts: Array<{ older: string; newer: string; resolution: string }> = [];
  if (Array.isArray(o.merge))
    for (const m of o.merge as Array<Record<string, unknown>>)
      if (m && typeof m.keep === 'string' && Array.isArray(m.drop)) merges.push({ keep: m.keep, drop: m.drop.filter((x): x is string => typeof x === 'string') });
  if (Array.isArray(o.conflicts))
    for (const c of o.conflicts as Array<Record<string, unknown>>)
      if (c && typeof c.older === 'string' && typeof c.newer === 'string') conflicts.push({ older: c.older, newer: c.newer, resolution: String(c.resolution ?? 'ask') });
  return { merges, conflicts };
};

async function llmPass(ctx: Ctx, g: Group, rep: TidyReport, signal?: AbortSignal): Promise<void> {
  const facts = activeFacts(ctx, g, 25).reverse();
  if (facts.length < 2) return;
  const h = hash(facts.map((f) => `${f.id}|${f.text}`).join('\n'));
  const mk = `tidy_llm:${gkey(g)}`;
  if (meta(ctx, mk) === h) return; // idempotent: nothing changed since the last LLM pass
  if (signal?.aborted) return;
  rep.llmCalls++;
  const byAlias = new Map<string, Fact>(facts.map((f, i): [string, Fact] => [`F${i + 1}`, f]));
  const res = await askJson(
    ctx,
    { system: TIDY_SYSTEM, prompt: `Facts:\n${facts.map((f, i) => `F${i + 1} (${new Date(f.since).toISOString().slice(0, 10)}): ${renderFact(f.text)}`).join('\n')}\n\nJSON:`, maxTokens: 500 },
    tidySchemaParse,
  );
  if (!res || signal?.aborted) return; // failed: leave the hash unset so the next run retries
  tx(ctx.db, () => {
    const blobId = g.blobId ?? '';
    for (const m of res.merges) {
      const keep = byAlias.get(m.keep.toUpperCase());
      if (!keep) continue;
      for (const d of m.drop) {
        const drop = byAlias.get(d.toUpperCase());
        if (!drop || drop.id === keep.id) continue;
        const cur = ctx.db.prepare('SELECT until FROM facts WHERE id = ?').get(drop.id) as Row | undefined;
        const curKeep = ctx.db.prepare('SELECT until FROM facts WHERE id = ?').get(keep.id) as Row | undefined;
        if (cur?.until == null && curKeep?.until == null) merge(ctx, keep, drop, blobId, rep);
      }
    }
    for (const c of res.conflicts) {
      const older = byAlias.get(c.older.toUpperCase());
      const newer = byAlias.get(c.newer.toUpperCase());
      if (!older || !newer || older.id === newer.id) continue;
      const alive = (id: string) => (ctx.db.prepare('SELECT until FROM facts WHERE id = ?').get(id) as Row | undefined)?.until == null;
      if (!alive(older.id) || !alive(newer.id)) continue;
      const safe = c.resolution === 'newer' && newer.since > older.since && newer.confidence >= older.confidence - 0.1 && !older.important;
      if (safe) {
        if (retireFact(ctx, older.id, 'contradicted', newer.id)) {
          rep.contradictionsResolved++;
          rep.receipts.push(addReceipt(ctx, { kind: 'retired', factId: older.id, blobId, text: older.text, undo: { factId: older.id } }));
        }
      } else if (addQuestion(ctx, { blobId: g.blobId, scope: g.scope, text: `Earlier: "${older.text}". Also: "${newer.text}". Which is right?`, factIds: [older.id, newer.id], proposed: undefined })) {
        rep.questionsRaised++;
      }
    }
    setMeta(ctx, mk, h);
  });
}

const CORE_SYSTEM = (cap: number) => `You keep a short always-on notes page for an AI coworker. Rewrite it from the facts: most important first, terse bullet lines, no duplicates, no speculation. Keep every subject explicit and unchanged: a line about the user starts with "You", a line about another person starts with their name (never a bare verb like "Lives in Austin."). Hard limit: about ${Math.floor(cap * 3)} characters.
Reply with ONLY JSON: {"text":"- line\\n- line"}`;

function deterministicCore(facts: Fact[], cap: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const f of facts) {
    const l = `- ${renderFact(f.text)}`;
    const c = estimateTokens(l) + 1;
    if (used + c > cap * 0.9) break;
    used += c;
    lines.push(l);
  }
  return lines.join('\n');
}

function coreFacts(ctx: Ctx, g: Group): Fact[] {
  return activeFacts(ctx, g, 200)
    .filter((f) => f.important || f.useCount >= 1 || f.confidence >= 0.8)
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 30);
}

async function refreshCore(ctx: Ctx, g: Group, rep: TidyReport): Promise<void> {
  const existing = readCore(ctx, g.scope, g.blobId ?? '');
  if (existing && existing.source === 'user' && existing.text.trim()) return; // the user owns it
  const facts = coreFacts(ctx, g);
  if (facts.length === 0) return;
  const h = hash(facts.map((f) => `${f.id}|${f.text}`).join('\n'));
  if (existing?.inputHash === h) return;
  const cap = coreCap(g.scope);
  // cheap path first: when every fact fits the note as plain bullets there is nothing for a model to compress
  const plain = deterministicCore(facts, cap);
  let text: string | null = plain.split('\n').length === facts.length ? plain : null;
  if (!text) {
    rep.llmCalls++;
    text = await askJson(
      ctx,
      { system: CORE_SYSTEM(cap), prompt: `Facts:\n${facts.map((f) => `- ${renderFact(f.text)}`).join('\n')}\n\nJSON:`, maxTokens: Math.min(600, cap) },
      (raw) => {
        const t = (raw as { text?: unknown } | undefined)?.text;
        const real = typeof t === 'string' ? t.trim() : '';
        return real.length > 5 && estimateTokens(real) <= cap ? real : null;
      },
    );
  }
  if (!text) text = plain;
  writeCore(ctx, g.scope, g.blobId ?? '', text, 'auto', h);
  rep.coresRefreshed.push(gkey(g));
}

export async function tidy(ctx: Ctx, opts: { blobId?: string; signal?: AbortSignal } = {}): Promise<TidyReport> {
  const rep: TidyReport = { dedupedFacts: 0, retiredStale: 0, contradictionsResolved: 0, questionsRaised: 0, coresRefreshed: [], reembedded: 0, prunedTurns: 0, llmCalls: 0, cancelled: false, receipts: [] };
  const stop = () => {
    if (opts.signal?.aborted || ctx.closed) rep.cancelled = true;
    return rep.cancelled;
  };
  const now = ctx.now();

  for (const g of groupsFor(ctx, opts.blobId)) {
    if (stop()) return rep;
    await dedupe(ctx, g, rep, opts.signal);
    if (stop()) return rep;
    // stale trivia: never used, not important, untouched for a year
    tx(ctx.db, () => {
      const rows = ctx.db
        .prepare(`SELECT id, text FROM facts WHERE until IS NULL AND important = 0 AND use_count = 0 AND scope = ? AND COALESCE(blob_id,'') = ? AND MAX(last_used_at, created_at) < ?`)
        .all(g.scope, g.blobId ?? '', now - LIMITS.staleDays * DAY_MS) as Row[];
      for (const r of rows) if (retireFact(ctx, r.id, 'stale')) {
        rep.retiredStale++;
        rep.receipts.push(addReceipt(ctx, { kind: 'retired', factId: r.id, blobId: g.blobId ?? '', text: r.text, undo: { factId: r.id } }));
      }
    });
    await llmPass(ctx, g, rep, opts.signal);
    if (stop()) return rep;
    await refreshCore(ctx, g, rep);
  }

  // re-embed anything missing or from another model, in small chunks
  if (ctx.embedder) {
    for (;;) {
      if (stop()) return rep;
      const ids = (ctx.db.prepare('SELECT id FROM facts WHERE until IS NULL AND (embedding IS NULL OR emb_model IS NOT ?) LIMIT 32').all(ctx.embedder.id) as Row[]).map((r) => r.id as string);
      if (ids.length === 0) break;
      await embedFacts(ctx, ids);
      rep.reembedded += ids.length;
      // embedFacts swallows errors; avoid spinning forever if the embedder keeps failing
      const still = ctx.db.prepare('SELECT COUNT(*) AS n FROM facts WHERE id IN (' + ids.map(() => '?').join(',') + ') AND embedding IS NULL').get(...ids) as Row;
      if (Number(still.n) === ids.length) break;
    }
  }

  // old raw turns age out (summaries stay)
  tx(ctx.db, () => {
    const old = ctx.db.prepare('SELECT id FROM turns WHERE at < ?').all(now - 540 * DAY_MS) as Row[];
    for (const r of old) {
      ctx.db.prepare("DELETE FROM ep_fts WHERE kind = 'turn' AND ref = ?").run(r.id);
      ctx.db.prepare('DELETE FROM turns WHERE id = ?').run(r.id);
    }
    rep.prunedTurns = old.length;
    setMeta(ctx, 'last_tidy_at', String(now));
  });
  return rep;
}

/** True after a burst of ≥20 new facts since the last tidy, or when it has not run for a day. */
export function needsTidy(ctx: Ctx): boolean {
  const last = Number(meta(ctx, 'last_tidy_at') ?? 0);
  const n = Number((ctx.db.prepare('SELECT COUNT(*) AS n FROM facts WHERE created_at > ?').get(last) as Row).n);
  return n >= LIMITS.burstFacts || (n > 0 && ctx.now() - last > DAY_MS);
}

export const lastTidyAt = (ctx: Ctx): number | undefined => {
  const v = meta(ctx, 'last_tidy_at');
  return v ? Number(v) : undefined;
};
