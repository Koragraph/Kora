// The model-facing "remember this" write path. It is NOT a blind append: it goes through the same decision the turn
// extractor makes - duplicate / replace what it contradicts / hold when sensitive / add - in ONE transaction, and every
// outcome that changes memory gets a real receipt (so Undo works on it).
import type { Ctx } from './ctx';
import type { Fact, Receipt, Scope } from './types';
import { LIMITS } from './types';
import { tx } from './db';
import { cleanText, jaccard, looksLikeSecret, looksLikeTaskInstruction, looksSensitive, contentTokens } from './text';
import { explicitSubjectOrNull, isOtherPersonContact, subjectKey } from './subject';
import { mergeCorrection, slotOf, sameValue } from './corrections';
import { addReceipt, allVisible, embedFacts, findDuplicate, getFact, insertFact, retireFact, searchVisible } from './facts';
import { addPending } from './ingest';

export interface RememberArgs {
  scope: Scope;
  blobId?: string;
  text: string;
  important?: boolean;
  /** A hint at the stored fact this replaces: a fact id, or plain words ("lives in Dallas"). */
  replaces?: string;
  threadId?: string | null;
  messageId?: string | null;
  at?: number;
}

export interface RememberResult {
  outcome: 'added' | 'updated' | 'held' | 'duplicate';
  /** The fact now true (added / updated / the existing duplicate). */
  fact?: Fact;
  /** What it replaced (outcome 'updated'). */
  previous?: Fact[];
  receipt?: Receipt;
  pendingId?: string;
  reason?: 'sensitive' | 'low_confidence';
}

/** Stored facts the new statement contradicts (same single-valued slot, a near-restatement, or the caller's hint). */
function contradictions(ctx: Ctx, a: { scope: Scope; blobId: string | null; text: string; replaces?: string }): Fact[] {
  const vis = { blobId: a.blobId ?? '', includeTeam: a.scope === 'team' };
  const pool = allVisible(ctx, vis);
  const out: Fact[] = [];
  const add = (f: Fact | undefined) => { if (f && f.until == null && !out.some((x) => x.id === f.id)) out.push(f); };

  const slot = slotOf(a.text);
  // A "replaces" hint may only point at a fact of the same kind (same subject, same slot): "Your sister lives in Lisbon." can
  // never retire "You live in Austin.", whatever the model passes (live QA, 2026-10-10).
  const sameKind = (f: Fact): boolean => {
    if (subjectKey(f.text) !== subjectKey(a.text)) return false;
    const sb = slotOf(f.text);
    return (!slot && !sb) || (!!slot && !!sb && slot.slot === sb.slot);
  };
  const hint = a.replaces?.trim();
  if (hint) {
    const byId = /^f_[0-9a-f]+$/i.test(hint) ? getFact(ctx, hint) : undefined;
    if (byId) { if (sameKind(byId)) add(byId); }
    else {
      const best = searchVisible(ctx, vis, hint, { limit: 6 }).sort((x, y) => y.lex - x.lex)[0];
      if (best && best.lex >= 0.5 && sameKind(best.fact)) add(best.fact);
    }
  }
  if (slot) {
    for (const f of pool) {
      const s = slotOf(f.text);
      // the SAME subject only: "Sam lives in Austin." never replaces "You live in Dallas."
      if (s && s.slot === slot.slot && s.subject === slot.subject && !sameValue(s.value, slot.value)) add(f);
    }
  } else {
    // a near-restatement with one word changed ("Prefers morning meetings." -> "Prefers afternoon meetings.")
    const head = contentTokens(a.text)[0];
    let best: { f: Fact; j: number } | null = null;
    for (const f of pool) {
      if (f.scope !== a.scope || (a.scope === 'blob' && f.blobId !== a.blobId)) continue;
      if (subjectKey(f.text) !== subjectKey(a.text)) continue;
      const j = jaccard(f.text, a.text);
      if (j >= 0.5 && j < 0.85 && contentTokens(f.text)[0] === head && (!best || j > best.j)) best = { f, j };
    }
    if (best) add(best.f);
  }
  return out;
}

export async function remember(ctx: Ctx, a: RememberArgs): Promise<RememberResult> {
  let text = cleanText(a.text, LIMITS.factMaxChars);
  if (!text) throw new Error('empty fact');
  if (looksLikeSecret(text)) throw new Error('refusing to store what looks like a credential or ID number');
  if (looksLikeTaskInstruction(text)) throw new Error('that is an instruction for this task or session (or test setup), not a lasting fact about the user, so it is not saved. Remember only durable facts and preferences the user states about themselves');
  const scope: Scope = a.scope;
  if (scope === 'you' || scope === 'team') {
    // who is it about? "Lives in Austin." cannot be told apart from somebody else's city (live QA #2)
    const fixed = explicitSubjectOrNull(text);
    if (!fixed) throw new Error('say who the fact is about: start with "You" for the user ("You live in Austin.") or with the person\'s name ("Sam lives in Austin.")');
    text = fixed;
  }
  const blobId = scope === 'blob' ? (a.blobId ?? null) : null;
  if (scope === 'blob' && !blobId) throw new Error('blob-scoped fact needs a blobId');
  const at = a.at ?? ctx.now();
  const src = { blobId: a.blobId ?? '', threadId: a.threadId ?? '', messageId: a.messageId ?? '' };

  const toEmbed: string[] = [];
  const result = tx(ctx.db, (): RememberResult => {
    const dupe = findDuplicate(ctx, scope, blobId, text);
    const targets = contradictions(ctx, { scope, blobId, text, replaces: a.replaces }).filter((f) => f.id !== dupe?.id);
    if (dupe && targets.length === 0) {
      ctx.db.prepare('UPDATE facts SET last_used_at = ?, confidence = MAX(confidence, 1) WHERE id = ?').run(ctx.now(), dupe.id);
      if (!dupe.source.messageId && a.messageId) ctx.db.prepare('UPDATE facts SET thread_id = ?, message_id = ? WHERE id = ?').run(a.threadId ?? null, a.messageId, dupe.id);
      return { outcome: 'duplicate', fact: getFact(ctx, dupe.id)! };
    }
    if (dupe) {
      // the same thing is already stored AND an older contradictory fact is still active: finish the correction
      const olds = targets.filter((f) => retireFact(ctx, f.id, 'corrected', dupe.id));
      const receipt = olds.length ? addReceipt(ctx, { kind: 'retired', factId: olds[0].id, blobId: src.blobId, text: olds[0].text, undo: { factId: olds[0].id } }) : undefined;
      return { outcome: olds.length ? 'updated' : 'duplicate', fact: dupe, previous: olds, ...(receipt ? { receipt } : {}) };
    }

    // Sensitive items (health, money, legal, other people) are held for the user's OK on EVERY write path.
    if (looksSensitive(text) || isOtherPersonContact(text)) {
      const target = targets[0];
      const r = addPending(ctx, src, { kind: target ? 'update' : 'add', scope, text, ...(target ? { target: target.id } : {}), reason: 'sensitive', confidence: 1, important: !!a.important });
      // addPending returns null when the very same item is already waiting: the user has seen the card for it.
      return { outcome: 'held', reason: 'sensitive', ...(r ? { receipt: r, pendingId: r.pendingId } : {}) };
    }

    // One detail of a multi-part fact changed: swap it in and keep the rest; if it can't be merged, keep the old fact too.
    let finalText = text;
    const replaceable: Fact[] = [];
    for (const t of targets) {
      const m = mergeCorrection(t.text, finalText);
      if (m === null) replaceable.push(t);
      else if ('text' in m) { finalText = m.text; replaceable.push(t); }
    }
    const f = insertFact(ctx, { scope, blobId, text: finalText, since: at, confidence: 1, important: !!a.important || replaceable.some((t) => t.important), threadId: a.threadId ?? null, messageId: a.messageId ?? null });
    toEmbed.push(f.id);
    const retired = replaceable.filter((t) => retireFact(ctx, t.id, 'corrected', f.id));
    if (retired.length) {
      const receipt = addReceipt(ctx, {
        kind: 'updated', factId: f.id, blobId: src.blobId, text: f.text, previousText: retired[0].text,
        undo: { newFactId: f.id, oldFactId: retired[0].id, alsoOldFactIds: retired.slice(1).map((x) => x.id) },
      });
      return { outcome: 'updated', fact: f, previous: retired, receipt };
    }
    const receipt = addReceipt(ctx, { kind: 'added', factId: f.id, blobId: src.blobId, text: f.text, undo: { factId: f.id } });
    return { outcome: 'added', fact: f, receipt };
  });
  await embedFacts(ctx, toEmbed);
  if (result.fact && toEmbed.length) result.fact = getFact(ctx, result.fact.id) ?? result.fact;
  return result;
}
