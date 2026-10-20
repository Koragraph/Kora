// Write path: extract → compare with closest existing facts → add / update / retire / ignore (or hold for the user).
import { z } from 'zod';
import type { Ctx, Row } from './ctx';
import { askJson } from './ctx';
import type { Fact, NormTurn, PendingItem, Receipt, Scope, TurnInput } from './types';
import { LIMITS } from './types';
import { tx } from './db';
import { cleanText, scrubSecrets, contentTokens, isTaskRequest, jaccard, looksLikeSecret, looksLikeTaskInstruction, looksSensitive, normalize, statedAboutSelf, statesLastingPreference } from './text';
import { detectCorrections, looksLikeCorrection, mergeCorrection, slotOf } from './corrections';
import { correctionEvidence, hasUngroundedDetail, isOtherPersonContact, mentionsOtherActor, refines, renderFact, retireEvidence, subjectKey, withExplicitSubject } from './subject';
import { allVisible, recentVisible, addQuestion, addReceipt, clamp01, embedFacts, findDuplicate, getFact, insertFact, newId, reactivateFact, retireFact, rowToPending, searchVisible, turnForgotten } from './facts';

export const EXTRACT_SYSTEM = `You maintain long-term memory for an AI coworker. Read the latest exchange and decide what is worth remembering about the USER: stable facts, preferences, people in their life/work, recurring plans, how they like work done.
Reply with ONLY a JSON object: {"ops":[...]} (at most ${LIMITS.maxOpsPerTurn} ops; {"ops":[]} if nothing is worth keeping).
Each op: {"op":"add"|"update"|"retire"|"conflict"|"ignore","scope":"you"|"blob","text":"...","target":"F1","confidence":0.0-1.0,"important":false,"sensitive":false,"explicit":false}
Rules:
- A lasting preference about how the user wants answers in general ("keep answers short, I read on my phone", "I prefer bullet points") IS memory: record it as a fact about them ("You prefer short answers.").
- NEVER record an instruction for the assistant, a rule for this task or session ("only use X", "keep this one under 200 words", "you are in a test", "use my Y blobs"), test setup, or a detail that only matters for the task at hand (who an email is addressed to, what to research). Only durable facts and preferences the user states about THEMSELVES, in their own life, are memory.
- Only record what the USER said or confirmed. Never record the assistant's guesses, one-off task details, or small talk. Use only the user's own words: no dates, years, reasons or details they did not state.
- "text": ONE short self-contained sentence with an EXPLICIT SUBJECT, max 25 words. About the user: start with "You" ("You live in Austin.", "You prefer morning meetings."). About anybody else: start with their name ("Sam lives in Austin.", "Sam is your cofounder."). A sentence that starts with a bare verb ("Lives in Austin.") is wrong: it cannot be told apart from somebody else's fact.
- scope "you" = true about the user in general (useful to any coworker). scope "blob" = about how THIS coworker should work for them, or an ongoing project.
- A fact about ANOTHER person is never a fact about the user: "My friend Sam lives in Austin" -> "Sam lives in Austin." (it does NOT change where the user lives).
- Compare with the numbered existing facts. Same meaning already stored -> op "ignore". New information that replaces a stored fact -> "update" with target (the F-number) - only for the SAME subject and the SAME kind of fact (where they live, who they work for). Stored fact is no longer true -> "retire" with target.
- A fact that holds ONE value (where they live, who they work for, their name) is REPLACED, never added next to the old one: "I moved to Austin" with "F1 [you]: You live in Dallas." -> update, target "F1", text "You live in Austin.", explicit true.
- "explicit": true ONLY when the user clearly corrects or announces a change about themselves ("actually", "that's wrong", "I moved", "not anymore"). Otherwise false.
- Use "conflict" (with target and the new text) when new info contradicts a stored fact but the user did not say it changed.
- "sensitive": true for health, money, legal, identity, or private details about other people. An email address or phone number of anybody but the user is ALWAYS sensitive.
- "important": almost always false. true ONLY for name, timezone, or a strong long-lived preference/dislike - never for a job detail, schedule, project or ordinary fact.
- Never output passwords, keys, card or ID numbers.

Example. Existing: F1 [you]: You live in Dallas.  USER said: "I live in Austin now, not Dallas."
{"ops":[{"op":"update","scope":"you","text":"You live in Austin.","target":"F1","confidence":0.95,"explicit":true}]}
Example. Existing: F1 [you]: You live in Dallas.  USER said: "My friend Sam moved to Austin."
{"ops":[{"op":"add","scope":"you","text":"Sam lives in Austin.","confidence":0.8}]}`;

const opSchema = z.object({
  op: z.enum(['add', 'update', 'retire', 'conflict', 'ignore']),
  scope: z.enum(['you', 'blob', 'team']).optional(),
  text: z.string().optional(),
  target: z.string().optional(),
  confidence: z.coerce.number().optional(),
  important: z.coerce.boolean().optional(),
  sensitive: z.coerce.boolean().optional(),
  explicit: z.coerce.boolean().optional(),
});
export type Op = z.infer<typeof opSchema>;

/** Lenient: keeps every valid op, drops the rest; null only when the reply has no usable envelope. */
export function parseOps(raw: unknown): Op[] | null {
  let list: unknown;
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object' && Array.isArray((raw as { ops?: unknown }).ops)) list = (raw as { ops: unknown[] }).ops;
  else return null;
  const out: Op[] = [];
  for (const item of list as unknown[]) {
    const p = opSchema.safeParse(item);
    if (p.success) out.push(p.data);
  }
  return out.slice(0, LIMITS.maxOpsPerTurn);
}

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export async function ingestTurn(ctx: Ctx, input: TurnInput): Promise<Receipt[]> {
  if (ctx.closed) return [];
  const t: NormTurn = { ...input, messageId: input.userMessageId ?? input.messageId ?? '' };
  // Credentials never reach the turn store, the search index or the extractor model (pl8 S2-1).
  const userText = scrubSecrets(cleanText(t.userText, LIMITS.turnTextMaxChars));
  const assistantText = scrubSecrets(cleanText(t.assistantText, LIMITS.turnTextMaxChars));
  // 0) a turn the user made Kora forget (purged, or saying a fact forgotten after it was said) is never re-indexed or
  //    re-learned: the retry queue replays turns hours later (pl7 S2-1)
  if (tx(ctx.db, () => turnForgotten(ctx, t, `${userText}\n${assistantText}`))) return [];
  // 1) the turn is always searchable as an episode, even if extraction later fails
  tx(ctx.db, () => indexTurn(ctx, t, userText, assistantText));
  // a Kora hand-off brief is Kora's words, not the user's: it stays searchable but memory never learns from it
  if (userText.length < 8 || input.learn === false) return [];

  // 2) obvious corrections ("I moved to Austin", "not Dallas anymore") apply right now, with no model: they must not
  //    wait for (or depend on) the extractor, which may be rate-limited for hours.
  const preEmbed: string[] = [];
  const pre = tx(ctx.db, () => applyDeterministic(ctx, t, userText, preEmbed));

  // 3) closest existing facts (numbered aliases so a small model never has to copy an id)
  const near = searchVisible(ctx, { blobId: t.blobId, includeTeam: !!t.allowTeam }, `${userText} ${assistantText.slice(0, 300)}`, { limit: 8 })
    .sort((a, b) => b.lex + b.sem - (a.lex + a.sem))
    .slice(0, 8);
  // "I moved to Austin" shares no word with "Lives in Dallas": the newest facts are always candidates for an update/retire.
  const have = new Set(near.map((h) => h.fact.id));
  const candidates: Fact[] = [...near.map((h) => h.fact), ...recentVisible(ctx, { blobId: t.blobId, includeTeam: !!t.allowTeam }, 4).filter((f) => !have.has(f.id))].slice(0, 10);
  const alias = new Map<string, Fact>();
  candidates.forEach((f, i) => alias.set(`F${i + 1}`, f));
  const existing = candidates.length
    ? candidates.map((f, i) => `F${i + 1} [${f.scope}]: ${renderFact(f.text)}`).join('\n')
    : '(none)';
  const hint = looksLikeCorrection(userText) ? '\nNote: this message may correct something stored. If so, prefer update/retire with explicit true.' : '';
  const prompt = `Today: ${new Date(t.at).toISOString().slice(0, 10)}\nExisting facts:\n${existing}${hint}\n\nUSER said:\n${trunc(userText, 1200)}\n\nASSISTANT replied:\n${trunc(assistantText, 600)}\n\nJSON:`;

  const ops = await askJson(ctx, { system: EXTRACT_SYSTEM, prompt, maxTokens: 600 }, parseOps);
  if (!ops || ops.length === 0 || ctx.closed) {
    await embedFacts(ctx, preEmbed);
    return pre;
  }

  // 4) apply atomically (synchronous), then embed in the background of this call
  const toEmbed: string[] = [...preEmbed];
  const receipts = tx(ctx.db, () => applyOps(ctx, t, ops, alias, toEmbed, { userText }));
  await embedFacts(ctx, toEmbed);
  return [...pre, ...receipts];
}

/** The no-model pass: replace / retire stored facts the user's own words obviously contradict. */
function applyDeterministic(ctx: Ctx, t: NormTurn, userText: string, toEmbed: string[]): Receipt[] {
  const facts = allVisible(ctx, { blobId: t.blobId, includeTeam: !!t.allowTeam });
  const actions = detectCorrections(userText, facts);
  if (!actions.length) return [];
  const alias = new Map<string, Fact>();
  const key = (f: Fact) => { const k = `P${alias.size + 1}`; alias.set(k, f); return k; };
  const ops: Op[] = [];
  for (const a of actions) {
    if (a.kind === 'retire') { ops.push({ op: 'retire', target: key(a.target), explicit: true }); continue; }
    const [first, ...rest] = a.targets;
    ops.push({ op: 'update', scope: a.scope, text: a.text, target: key(first), confidence: 0.95, important: a.important, explicit: true });
    for (const f of rest) ops.push({ op: 'retire', target: key(f), explicit: true });
  }
  return applyOps(ctx, t, ops, alias, toEmbed, null);
}

function indexTurn(ctx: Ctx, t: NormTurn, userText: string, assistantText: string): void {
  const text = `User: ${userText}\nAssistant: ${assistantText}`;
  if (ctx.db.prepare('SELECT 1 FROM turns WHERE thread_id = ? AND message_id = ?').get(t.threadId, t.messageId)) return;
  const id = newId('t');
  ctx.db.prepare('INSERT INTO turns(id, thread_id, blob_id, message_id, text, at) VALUES(?,?,?,?,?,?)').run(id, t.threadId, t.blobId, t.messageId, text, t.at);
  ctx.db.prepare("INSERT INTO ep_fts(body, kind, ref, blob_id, thread_id, at) VALUES(?, 'turn', ?, ?, ?, ?)").run(text, id, t.blobId, t.threadId, t.at);
}

interface Gate {
  pending: boolean;
  reason: 'sensitive' | 'low_confidence';
}

export function gate(text: string, op: Pick<Op, 'sensitive' | 'confidence'>): Gate {
  if (op.sensitive || looksSensitive(text) || isOtherPersonContact(text)) return { pending: true, reason: 'sensitive' };
  if (clamp01(op.confidence ?? 0.7) < LIMITS.minConfidence) return { pending: true, reason: 'low_confidence' };
  return { pending: false, reason: 'low_confidence' };
}

/** "You live in Austin." / "The user lives in Austin." / "Lives in Austin." are one fact: compare what they say, not how. */
export function sameFactText(a: string, b: string): boolean {
  if (normalize(renderFact(a)) === normalize(renderFact(b))) return true;
  return jaccard(a, b) >= 0.85;
}

export function addPending(ctx: Ctx, t: Pick<NormTurn, 'blobId' | 'threadId' | 'messageId'>, p: { kind: 'add' | 'update'; scope: Scope; text: string; target?: string; reason: Gate['reason']; confidence: number; important: boolean }): Receipt | null {
  const blobId = p.scope === 'blob' ? t.blobId : null;
  // one card per fact: the remember tool and the turn extractor (and a retry of either) must not each raise their own
  const open = ctx.db.prepare("SELECT id, text FROM pending WHERE status = 'open' AND scope = ? AND COALESCE(blob_id,'') = ?").all(p.scope, blobId ?? '') as Row[];
  if (open.some((r) => sameFactText(r.text, p.text))) return null;
  const id = newId('p');
  ctx.db
    .prepare('INSERT INTO pending(id, kind, scope, blob_id, text, target_fact_id, reason, confidence, important, thread_id, message_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, p.kind, p.scope, blobId, p.text, p.target ?? null, p.reason, p.confidence, p.important ? 1 : 0, t.threadId, t.messageId, ctx.now());
  return addReceipt(ctx, { kind: 'pending', factId: '', pendingId: id, blobId: t.blobId, text: p.text, undo: { pendingId: id } });
}

/**
 * Apply the extractor's ops. `model` is set for ops that came from a model (never for the deterministic correction pass):
 * those are vetted first (explicit subject, nothing the user did not say, replace/retire only with the user's own words
 * as evidence - see subject.ts). A vetted-out op is dropped or turned into a question, never applied.
 */
function applyOps(ctx: Ctx, t: NormTurn, ops: Op[], alias: Map<string, Fact>, toEmbed: string[], model: { userText: string } | null): Receipt[] {
  const out: Receipt[] = [];
  for (const op of ops) {
    if (op.op === 'ignore') continue;
    let text = cleanText(op.text, LIMITS.factMaxChars);
    if (text && looksLikeSecret(text)) continue;
    let scope: Scope = op.scope ?? 'blob';
    if (scope === 'team' && !t.allowTeam) scope = 'blob';
    const live = op.target ? alias.get(op.target.trim().toUpperCase()) : undefined;
    // re-read: an earlier op in this batch may already have retired the target
    const targetRow = live ? getFact(ctx, live.id) : undefined;
    let activeTarget = targetRow && targetRow.until == null ? targetRow : undefined;
    const confidence = clamp01(op.confidence ?? 0.7);
    const important = !!op.important;
    let explicit = !!op.explicit;

    if (model && text) {
      // an instruction for the agent, test scaffolding or a one-off task constraint is never a fact about the user; and in
      // a message that is itself a task ("Write an invite to Riley, a new teammate") only what the user says about
      // THEMSELVES counts
      if (op.op !== 'retire' && (looksLikeTaskInstruction(text) || (scope !== 'blob' && isTaskRequest(model.userText) && !statedAboutSelf(text, model.userText) && !statesLastingPreference(model.userText, text)))) continue;
      // every fact about the user (or the team) says WHO it is about; one that cannot be given a subject safely is dropped
      if ((scope === 'you' || scope === 'team') && !isOtherPersonContact(text)) {
        const fixed = withExplicitSubject(text, model.userText);
        if (!fixed) continue;
        text = fixed;
      }
      if (hasUngroundedDetail(text, model.userText)) continue; // a date / year the user never said
    }

    if (op.op === 'retire') {
      if (!activeTarget) continue;
      // a model may retire only what the user's own words say is over; a free model's say-so is never enough
      const allowed = model ? retireEvidence(model.userText, activeTarget.text) : explicit;
      if (allowed) {
        if (retireFact(ctx, activeTarget.id, 'corrected')) {
          out.push(addReceipt(ctx, { kind: 'retired', factId: activeTarget.id, blobId: t.blobId, text: activeTarget.text, undo: { factId: activeTarget.id } }));
        }
      } else if (!model || !mentionsOtherActor(model.userText, contentTokens(activeTarget.text))) {
        q(ctx, t, activeTarget, `Is this still true: "${renderFact(activeTarget.text)}"?`);
      }
      continue;
    }

    if (!text) continue;

    if (model && activeTarget) {
      // a fact about somebody else, or about another kind of thing, is not a replacement for the target: add it beside
      const sa = slotOf(text);
      const sb = slotOf(activeTarget.text);
      const sameKind = subjectKey(text) === subjectKey(activeTarget.text) && ((!sa && !sb) || (!!sa && !!sb && sa.slot === sb.slot));
      if (!sameKind) activeTarget = undefined;
      else if (op.op === 'update') {
        if (refines(text, activeTarget.text) || correctionEvidence({ userText: model.userText, newText: text, targetText: activeTarget.text })) explicit = true;
        else {
          // the user is talking about somebody else ("my friend Sam moved to Austin"): nothing to ask, nothing to change
          if (mentionsOtherActor(model.userText, contentTokens(`${text} ${activeTarget.text}`))) continue;
          // nothing in the user's words says the old fact stopped being true: ask, do not guess
          q(ctx, t, activeTarget, `Earlier: "${renderFact(activeTarget.text)}". Now: "${text}". Which is right?`, text);
          continue;
        }
      }
    }

    if (op.op === 'conflict') {
      if (activeTarget) q(ctx, t, activeTarget, `Earlier: "${renderFact(activeTarget.text)}". Now: "${text}". Which is right?`, text);
      continue;
    }

    const blobId = scope === 'blob' ? t.blobId : null;
    const dupe = findDuplicate(ctx, scope, blobId, text);
    if (dupe) {
      // same thing said again: strengthen, don't duplicate
      ctx.db.prepare('UPDATE facts SET last_used_at = ?, confidence = MAX(confidence, ?) WHERE id = ?').run(ctx.now(), confidence, dupe.id);
      // the remember tool saved it mid-turn without a message link: the extractor's pass over the same turn supplies it
      if (!dupe.source.messageId && t.messageId) ctx.db.prepare('UPDATE facts SET thread_id = ?, message_id = ? WHERE id = ?').run(t.threadId, t.messageId, dupe.id);
      continue;
    }

    const g = gate(text, op);

    if (op.op === 'add' || !activeTarget) {
      if (g.pending) {
        const r = addPending(ctx, t, { kind: 'add', scope, text, reason: g.reason, confidence, important });
        if (r) out.push(r);
        continue;
      }
      const f = insertFact(ctx, { scope, blobId, text, since: t.at, confidence, important, threadId: t.threadId, messageId: t.messageId });
      toEmbed.push(f.id);
      out.push(addReceipt(ctx, { kind: 'added', factId: f.id, blobId: t.blobId, text, undo: { factId: f.id } }));
      continue;
    }

    // op === 'update' with an active target
    if (!explicit && activeTarget.important) {
      q(ctx, t, activeTarget, `Earlier: "${renderFact(activeTarget.text)}". Now: "${text}". Which is right?`, text);
      continue;
    }
    if (explicit) {
      // a correction is applied at once: the old fact stops being true for every blob right now
      if (g.pending) {
        if (retireFact(ctx, activeTarget.id, 'corrected')) {
          out.push(addReceipt(ctx, { kind: 'retired', factId: activeTarget.id, blobId: t.blobId, text: activeTarget.text, undo: { factId: activeTarget.id } }));
        }
        const r = addPending(ctx, t, { kind: 'add', scope, text, reason: g.reason, confidence, important });
        if (r) out.push(r);
        continue;
      }
    } else if (g.pending) {
      const r = addPending(ctx, t, { kind: 'update', scope, text, target: activeTarget.id, reason: g.reason, confidence, important });
      if (r) out.push(r);
      continue;
    }
    // one detail of a multi-part fact: merge it in; unmergeable -> store beside the old one (pl7 S2-3)
    const merge = mergeCorrection(activeTarget.text, text);
    if (merge && 'keep' in merge) {
      const f = insertFact(ctx, { scope, blobId, text, since: t.at, confidence, important, threadId: t.threadId, messageId: t.messageId });
      toEmbed.push(f.id);
      out.push(addReceipt(ctx, { kind: 'added', factId: f.id, blobId: t.blobId, text, undo: { factId: f.id } }));
      continue;
    }
    const merged = merge ? merge.text : text;
    const f = insertFact(ctx, { scope, blobId, text: merged, since: t.at, confidence, important: important || activeTarget.important, threadId: t.threadId, messageId: t.messageId });
    retireFact(ctx, activeTarget.id, explicit ? 'corrected' : 'superseded', f.id);
    toEmbed.push(f.id);
    out.push(addReceipt(ctx, { kind: 'updated', factId: f.id, blobId: t.blobId, text: merged, previousText: activeTarget.text, undo: { newFactId: f.id, oldFactId: activeTarget.id } }));
  }
  return out;
}

function q(ctx: Ctx, t: NormTurn, target: Fact, text: string, proposed?: string): void {
  addQuestion(ctx, { blobId: t.blobId, scope: target.scope, text, factIds: [target.id], proposed, threadId: t.threadId, messageId: t.messageId });
}

// ---------- pending approval / undo ----------

export async function approvePending(ctx: Ctx, id: string): Promise<Receipt | null> {
  const row = ctx.db.prepare("SELECT * FROM pending WHERE id = ? AND status = 'open'").get(id) as Row | undefined;
  if (!row) return null;
  const p: PendingItem = rowToPending(row);
  const toEmbed: string[] = [];
  const receipt = tx(ctx.db, () => {
    ctx.db.prepare("UPDATE pending SET status = 'approved' WHERE id = ?").run(id);
    const blobId = p.blobId ?? '';
    const target = p.targetFactId ? getFact(ctx, p.targetFactId) : undefined;
    const f = insertFact(ctx, { scope: p.scope, blobId: p.blobId, text: p.text, since: ctx.now(), confidence: Math.max(p.confidence, 0.9), important: !!row.important, threadId: p.source.threadId, messageId: p.source.messageId });
    toEmbed.push(f.id);
    if (p.kind === 'update' && target && target.until == null) {
      retireFact(ctx, target.id, 'superseded', f.id);
      return addReceipt(ctx, { kind: 'updated', factId: f.id, blobId, text: p.text, previousText: target.text, undo: { newFactId: f.id, oldFactId: target.id } });
    }
    return addReceipt(ctx, { kind: 'added', factId: f.id, blobId, text: p.text, undo: { factId: f.id } });
  });
  await embedFacts(ctx, toEmbed);
  return receipt;
}

export function rejectPending(ctx: Ctx, id: string): boolean {
  return Number(ctx.db.prepare("UPDATE pending SET status = 'rejected' WHERE id = ? AND status = 'open'").run(id).changes) > 0;
}

export function undo(ctx: Ctx, receiptId: string): boolean {
  return tx(ctx.db, () => {
    const r = ctx.db.prepare('SELECT * FROM receipts WHERE id = ? AND undone_at IS NULL').get(receiptId) as Row | undefined;
    if (!r) return false;
    const u = JSON.parse(r.undo) as { factId?: string; newFactId?: string; oldFactId?: string; alsoOldFactIds?: string[]; pendingId?: string };
    // Only the USER's own edit of the wording blocks an undo (it would throw their words away). Anything the system does
    // on its own - marking a fact important, recall touching it, embedding it - leaves the text alone and never counts.
    const untouched = (id: string | undefined): boolean => {
      if (!id) return true;
      const f = getFact(ctx, id);
      return !!f && (!r.text || f.text === r.text);
    };
    let ok = false;
    if (r.kind === 'added' && u.factId) ok = untouched(u.factId) && retireFact(ctx, u.factId, 'undone');
    else if (r.kind === 'updated' && u.newFactId && u.oldFactId) {
      if (!untouched(u.newFactId)) return false;
      const a = retireFact(ctx, u.newFactId, 'undone');
      reactivateFact(ctx, u.oldFactId);
      for (const id of u.alsoOldFactIds ?? []) reactivateFact(ctx, id);
      ok = a;
    } else if (r.kind === 'retired' && u.factId) {
      ok = reactivateFact(ctx, u.factId);
      if (ok) ctx.db.prepare('DELETE FROM forgotten WHERE fact_id = ?').run(u.factId); // un-forgotten: no tombstone
    }
    else if (r.kind === 'pending' && u.pendingId) ok = rejectPending(ctx, u.pendingId);
    if (ok) ctx.db.prepare('UPDATE receipts SET undone_at = ? WHERE id = ?').run(ctx.now(), receiptId);
    return ok;
  });
}

/** Settle a flagged contradiction: 'new' applies the proposed claim, 'old' keeps what is stored. */
export async function resolveQuestion(ctx: Ctx, id: string, keep: 'old' | 'new'): Promise<Receipt | null> {
  const row = ctx.db.prepare("SELECT * FROM questions WHERE id = ? AND status = 'open'").get(id) as Row | undefined;
  if (!row) return null;
  const factIds: string[] = JSON.parse(row.fact_ids);
  const toEmbed: string[] = [];
  const receipt = tx(ctx.db, () => {
    ctx.db.prepare("UPDATE questions SET status = 'resolved' WHERE id = ?").run(id);
    const old = factIds.map((i) => getFact(ctx, i)).find((f) => f && f.until == null);
    if (keep === 'old' || !old) return null;
    if (row.proposed) {
      const f = insertFact(ctx, { scope: old.scope, blobId: old.blobId, text: row.proposed, since: ctx.now(), confidence: 0.9, important: old.important, threadId: row.thread_id, messageId: row.message_id });
      retireFact(ctx, old.id, 'corrected', f.id);
      toEmbed.push(f.id);
      return addReceipt(ctx, { kind: 'updated', factId: f.id, blobId: row.blob_id ?? '', text: row.proposed, previousText: old.text, undo: { newFactId: f.id, oldFactId: old.id } });
    }
    retireFact(ctx, old.id, 'corrected');
    return addReceipt(ctx, { kind: 'retired', factId: old.id, blobId: row.blob_id ?? '', text: old.text, undo: { factId: old.id } });
  });
  await embedFacts(ctx, toEmbed);
  return receipt;
}
