import type { Ctx, Row } from './ctx';
import type { Scope } from './types';
import { LIMITS } from './types';
import { contentTokens, coverage, estimateTokens, normalize } from './text';
import { renderCoreText } from './subject';

const capFor = (scope: Scope): number => (scope === 'you' ? LIMITS.coreYouTokens : scope === 'blob' ? LIMITS.coreBlobTokens : LIMITS.coreTeamTokens);
export const coreCap = capFor;
const key = (scope: Scope, blobId: string): string => (scope === 'blob' ? blobId : '');

export class CoreTooLargeError extends Error {
  constructor(
    public scope: Scope,
    public tokens: number,
    public limit: number,
  ) {
    const words = (n: number) => (Math.round((n * 0.75) / 10) * 10).toLocaleString('en-US');
    super(`This note is too long: it is about ${words(tokens)} words and can hold about ${words(limit)}. Shorten it and save again.`);
  }
}

export function readCore(ctx: Ctx, scope: Scope, blobId = ''): { text: string; source: 'user' | 'auto'; inputHash: string | null; updatedAt: number } | undefined {
  const r = ctx.db.prepare('SELECT * FROM core WHERE scope = ? AND blob_id = ?').get(scope, key(scope, blobId)) as Row | undefined;
  return r ? { text: r.text, source: r.source, inputHash: r.input_hash ?? null, updatedAt: r.updated_at } : undefined;
}

export function getCore(ctx: Ctx, blobId: string): { you: string; blob: string; youUpdatedAt: number; blobUpdatedAt: number } {
  // what the blob reads (and memory.md shows): a machine-written note gets explicit subjects; a note the user wrote is theirs
  const shown = (c: ReturnType<typeof readCore>): string => (c ? (c.source === 'auto' ? renderCoreText(c.text) : c.text) : '');
  const y = readCore(ctx, 'you');
  const b = readCore(ctx, 'blob', blobId);
  return { you: shown(y), blob: shown(b), youUpdatedAt: y?.updatedAt ?? 0, blobUpdatedAt: b?.updatedAt ?? 0 };
}

/** Whole-note rewrite. Throws CoreTooLargeError when over the hard limit. */
export function writeCore(ctx: Ctx, scope: Scope, blobId: string, text: string, source: 'user' | 'auto' = 'user', inputHash?: string): void {
  const t = text.trim();
  const tokens = estimateTokens(t);
  if (tokens > capFor(scope)) throw new CoreTooLargeError(scope, tokens, capFor(scope));
  if (scope === 'blob' && !blobId) throw new Error('blob core needs a blobId');
  ctx.db
    .prepare(
      `INSERT INTO core(scope, blob_id, text, updated_at, source, input_hash) VALUES(?,?,?,?,?,?)
       ON CONFLICT(scope, blob_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at, source = excluded.source, input_hash = excluded.input_hash`,
    )
    .run(scope, key(scope, blobId), t, ctx.now(), source, inputHash ?? null);
}

/**
 * A note the USER wrote is theirs and is never edited here, but if it still states what a correction just retired the blob
 * would read both ("About the user: You live in Austin" next to "Memory: You live in Berlin"). Queue one question, so the
 * blob asks the user to update their note, instead of silently shipping the contradiction.
 */
function askAboutUserNotes(ctx: Ctx, toks: string[], factId?: string): void {
  const rows = ctx.db.prepare("SELECT * FROM core WHERE source = 'user'").all() as Row[];
  for (const r of rows) {
    const note: string = r.text;
    if (!note || coverage(toks, note) < 0.99) continue;
    const sentence = note.split(/\n|(?<=[.!?])\s+/).find((x) => coverage(toks, x) >= 0.99);
    if (!sentence) continue;
    const text = `Your note still says "${sentence.replace(/^\s*[-*]\s+/, '').trim()}" but that changed. Update the note?`;
    const ids = JSON.stringify(factId ? [factId] : []);
    const open = ctx.db.prepare("SELECT 1 FROM questions WHERE status = 'open' AND text = ?").get(text);
    if (open) continue;
    ctx.db
      .prepare('INSERT INTO questions(id, blob_id, scope, text, fact_ids, proposed, thread_id, message_id, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(`q_${Math.random().toString(16).slice(2, 18)}`, r.scope === 'blob' ? r.blob_id : null, r.scope, text, ids, null, null, null, ctx.now());
  }
}

/**
 * A fact stopped being true: take it out of the machine-written Core notes right now (they are rebuilt from facts only by
 * the nightly tidy, and recall skips any fact the Core already states). Only the sentence/clause that restates the fact
 * goes; `replacement` (the fact that superseded it) takes its place. A note the USER wrote is theirs and is left alone.
 */
export function scrubCore(ctx: Ctx, retiredText: string, replacement?: string, factId?: string): void {
  const toks = contentTokens(retiredText);
  if (toks.length === 0) return;
  askAboutUserNotes(ctx, toks, factId);
  const rows = ctx.db.prepare("SELECT * FROM core WHERE source = 'auto'").all() as Row[];
  for (const r of rows) {
    const text: string = r.text;
    if (coverage(toks, text) < 0.99) continue; // the retired fact is not (wholly) in this note
    let changed = false;
    let placed = false;
    const lines = text.split('\n').map((line) => {
      const sentences = line.split(/(?<=[.!?])\s+/);
      const out: string[] = [];
      for (const sent of sentences) {
        if (coverage(toks, sent) < 0.99) { out.push(sent); continue; }
        changed = true;
        const clauses = sent.split(/;\s*|,\s+and\s+|\s+and\s+/);
        const keep = clauses.filter((c) => coverage(toks, c) < 0.99);
        if (keep.length && keep.length < clauses.length) { // only one clause of a compound sentence was the retired fact
          const joined = keep.join(' and ').replace(/^\W*\p{L}/u, (c) => c.toUpperCase());
          out.push(/[.!?]$/.test(joined) ? joined : `${joined}.`);
        }
        if (replacement && !placed) { out.push(replacement); placed = true; }
      }
      return out.join(' ');
    });
    if (!changed) continue;
    let next = lines.filter((l) => l.trim()).join('\n');
    if (replacement && !placed && !normalize(next).includes(normalize(replacement))) next = `${next}\n${replacement}`.trim();
    // the note is no longer a summary of the facts it was built from: clearing the hash makes the next tidy rebuild it
    ctx.db.prepare('UPDATE core SET text = ?, input_hash = NULL, updated_at = ? WHERE scope = ? AND blob_id = ?').run(next, ctx.now(), r.scope, r.blob_id);
  }
}
