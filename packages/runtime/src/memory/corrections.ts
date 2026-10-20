// Deterministic correction handling: no model involved. Two jobs:
//   1. `slotOf` names the "slot" a fact fills (where the user lives, where they work, their name ...) so a new value for
//      the same slot retires the old one ("Lives in Dallas." -> "Lives in Austin.").
//   2. `detectCorrections` reads the user's own words for the obvious cases ("I moved to Austin", "I live in Austin now,
//      not Dallas", "I don't eat meat anymore", "that's wrong, I work at Acme now") and says which stored facts to
//      replace or retire. It only ever acts on facts that are actually stored, so a false positive is a no-op.
import type { Fact, Scope } from './types';
import { contentTokens, coverage, jaccard, normalize } from './text';
import { firstPersonBefore, mentionsOtherActor, subjectKey } from './subject';

export type Slot = 'residence' | 'employer' | 'name' | 'timezone' | 'role';

const PLACE_STOP = new Set(['now', 'not', 'but', 'and', 'instead', 'for', 'since', 'with', 'these', 'as', 'because', 'so', 'though', 'anymore', 'any', 'also', 'too', 'actually', 'which', 'where', 'when', 'after', 'before', 'last', 'this', 'that', 'in', 'from', 'currently', 'permanently', 'full', 'recently']);

/** Take a short proper-noun-ish phrase (a city, a company) from the start of `s`. */
export function takePhrase(s: string, maxWords = 3): string {
  const cut = s.split(/[,;!?]|\.(?:\s|$)|\s[-—–]\s/)[0] ?? '';
  const out: string[] = [];
  for (const w of cut.trim().split(/\s+/)) {
    if (!w) continue;
    const bare = w.replace(/[^\p{L}\p{N}'.&-]/gu, '');
    if (!bare) break;
    if (PLACE_STOP.has(bare.toLowerCase()) && out.length) break;
    if (PLACE_STOP.has(bare.toLowerCase()) && !out.length) return '';
    out.push(bare.replace(/\.$/, ''));
    if (out.length >= maxWords) break;
  }
  return out.join(' ');
}

const titleIfLower = (s: string): string => (s === s.toLowerCase() ? s.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : s);

const SLOT_RES: Array<{ slot: Slot; re: RegExp }> = [
  { slot: 'residence', re: /\b(?:lives?|living|resides?|is based|based|is located|located|moved|relocated|now lives?)\s+(?:in|to|into|at)\s+(.+)/i },
  { slot: 'employer', re: /\b(?:works?|working|is employed|employed)\s+(?:at|for|with)\s+(.+)/i },
  { slot: 'role', re: /\b(?:works as|job title is|role is|is (?:a|an|the)\s+(?:senior |junior |lead |head of )?(?:engineer|designer|manager|developer|founder|ceo|cto|teacher|nurse|lawyer|analyst|consultant|student))\b(?:\s+(.+))?/i },
  { slot: 'name', re: /^(?:the user'?s? )?name is\s+(.+)|\bgoes by\s+(.+)|\bprefers to be called\s+(.+)/i },
  { slot: 'timezone', re: /\btime ?zone\b.*?\b(?:is|in)\s+(.+)/i },
];

/**
 * Which single-valued slot a fact fills, its normalised value, and WHO it is about ('user', or a lowercase name):
 * "Sam lives in Austin." fills Sam's residence, never the user's.
 */
export function slotOf(text: string): { slot: Slot; value: string; subject: string } | null {
  for (const { slot, re } of SLOT_RES) {
    const m = re.exec(text);
    if (!m) continue;
    const raw = m.slice(1).find(Boolean) ?? m[0];
    const value = normalize(takePhrase(raw.replace(/[.]+$/, ''), 4) || raw);
    if (value) return { slot, value, subject: subjectKey(text) };
  }
  return null;
}

export const sameValue = (a: string, b: string): boolean => a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);

export type CorrectionAction =
  | { kind: 'replace'; text: string; scope: Scope; important: boolean; targets: Fact[] }
  | { kind: 'retire'; target: Fact };

const CHANGE_MARKER = /\b(now|moved|relocat\w+|actually|instead|no longer|any ?more|that'?s (?:wrong|not (?:right|true|correct)|incorrect|outdated)|not true|isn'?t (?:right|true)|wrong|used to|these days|currently|new job|switched|started at|joined|changed)\b/i;

/** True when the message reads as the user correcting something (also used to hint the model extractor). */
export const looksLikeCorrection = (userText: string): boolean => CHANGE_MARKER.test(userText);

function bestMatches(phrase: string, facts: Fact[], exclude: Set<string>): Fact[] {
  const toks = contentTokens(phrase);
  if (toks.length === 0 || toks.length > 6) return [];
  const need = toks.length <= 2 ? 0.99 : 0.67;
  let best = 0;
  const scored: Array<{ f: Fact; c: number }> = [];
  for (const f of facts) {
    if (exclude.has(f.id)) continue;
    const c = coverage(toks, f.text);
    if (c >= need) { scored.push({ f, c }); best = Math.max(best, c); }
  }
  return scored.filter((s) => s.c === best).map((s) => s.f).slice(0, 2);
}

const clean = (s: string) => s.replace(/^(?:a|an|the|my)\s+/i, '').trim();

/**
 * @param facts every ACTIVE fact the blob can see (the caller loads them; slot facts may share no word with the message).
 */
export function detectCorrections(userText: string, facts: Fact[]): CorrectionAction[] {
  const text = userText.replace(/\s+/g, ' ').trim();
  if (text.length < 8) return [];
  const marked = CHANGE_MARKER.test(text);
  const actions: CorrectionAction[] = [];
  const touched = new Set<string>();

  // The user's own sentence only: "Sam moved to Austin" / "they work at Acme now" are about somebody else and never touch
  // what is stored about the user (live QA #2: that exact reading replaced "Lives in Dallas." with Sam's city).
  const mine = (m: RegExpExecArray | null): m is RegExpExecArray => !!m && firstPersonBefore(text.slice(0, m.index));

  // ---- 1) a new value for a single-valued slot --------------------------------------------------------------
  const places: Array<{ slot: Slot; value: string; make: (v: string) => string }> = [];
  const mv = /\b(?:moved|relocated|moving|am moving|'m moving)\s+(?:back\s+)?(?:to|into)\s+(.+)/i.exec(text);
  const lv = /\b(?:live|living|am based|'m based|based)\s+in\s+(.+)/i.exec(text);
  if (mine(mv)) places.push({ slot: 'residence', value: takePhrase(mv[1]), make: (v) => `You live in ${v}.` });
  else if (marked && mine(lv)) places.push({ slot: 'residence', value: takePhrase(lv[1]), make: (v) => `You live in ${v}.` });
  const wk = /\b(?:now\s+)?(?:work|working)\s+(?:at|for)\s+(.+)/i.exec(text) ?? /\b(?:started (?:a new job )?at|joined|switched to)\s+(.+)/i.exec(text);
  if (marked && mine(wk)) places.push({ slot: 'employer', value: takePhrase(wk[1]), make: (v) => `You work at ${v}.` });

  for (const p of places) {
    if (!p.value || p.value.length < 2) continue;
    const norm = normalize(p.value);
    const same = facts.filter((f) => { const s = slotOf(f.text); return s?.slot === p.slot && s.subject === 'user'; });
    const keep = same.find((f) => sameValue(slotOf(f.text)!.value, norm));
    const stale = same.filter((f) => f !== keep && !touched.has(f.id));
    if (keep) {
      for (const f of stale) { actions.push({ kind: 'retire', target: f }); touched.add(f.id); }
    } else if (stale.length) {
      actions.push({ kind: 'replace', text: p.make(titleIfLower(p.value)), scope: stale[0].scope, important: stale.some((f) => f.important), targets: stale });
      for (const f of stale) touched.add(f.id);
    }
  }

  // ---- 2) "not X anymore" / "no longer X" / "stopped X" ----------------------------------------------------------
  const phrases: string[] = [];
  const re1 = /(?:no longer|don'?t|do not|doesn'?t|am not|'m not|aren'?t|not)\s+(.{2,60}?)\s+(?:any ?more)\b/gi;
  for (let m = re1.exec(text); m; m = re1.exec(text)) if (mine(m)) phrases.push(m[1]);
  const re2 = /\bno longer\s+(.{2,60}?)(?:[.,;!?]|$)/gi;
  for (let m = re2.exec(text); m; m = re2.exec(text)) if (mine(m)) phrases.push(m[1]);
  const re3 = /\b(?:stopped|quit|gave up|left)\s+(.{2,50}?)(?:[.,;!?]|$)/gi;
  for (let m = re3.exec(text); m; m = re3.exec(text)) if (mine(m)) phrases.push(m[1]);
  // "I live in Austin now, not Dallas" / "that's wrong, it's Austin not Dallas"
  if (marked && !mentionsOtherActor(text)) {
    const re4 = /\bnot\s+(?:in\s+|at\s+|for\s+|with\s+)?(\p{Lu}[\p{L}'.-]*(?:\s+\p{Lu}[\p{L}'.-]*){0,2})/gu;
    for (let m = re4.exec(text); m; m = re4.exec(text)) phrases.push(m[1]);
  }
  const newValues = new Set(places.map((p) => normalize(p.value)));
  for (const raw of phrases) {
    let phrase = clean(raw.replace(/^(?:live|work|living|working|be)\s+(?:in|at|for)\s+/i, ''));
    phrase = phrase.replace(/^(?:eat|eating)\s+/i, (m) => m); // keep verbs: "eat meat" must match "Eats meat."
    if (!phrase || newValues.has(normalize(phrase))) continue;
    for (const f of bestMatches(phrase, facts.filter((x) => subjectKey(x.text) === 'user'), touched)) {
      actions.push({ kind: 'retire', target: f });
      touched.add(f.id);
    }
  }
  return actions;
}

export { jaccard };

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE_RE = /\+?\d[\d\s().-]{5,}\d/g;
const COUNT_RE = /\b(\d{1,4})\s+([a-z]{3,})/gi;
const digits = (s: string): string => s.replace(/\D/g, '');

/**
 * A correction of ONE detail of a multi-part fact must not throw the other details away (pl7 S2-3: "Actually my phone is
 * 555-0199" replaced "contact info: Sam Test, phone 555-0100, email …, 2 seats" with only the phone).
 *   null           -> a plain replacement loses nothing that matters (single-valued slot, or at most one word changes)
 *   { text }       -> the old fact with the corrected value(s) swapped in (same kind: email, phone, "N seats")
 *   { keep: true } -> the new statement can't be merged: keep the old fact and store the new one beside it
 */
export function mergeCorrection(oldText: string, newText: string): { text: string } | { keep: true } | null {
  if (slotOf(oldText)) return null;
  // only a fact that lists several details ("phone …, email …, 2 seats") is merged; "You eat meat." -> "You are
  // vegetarian." is a plain replacement
  const values = (oldText.match(EMAIL_RE) ?? []).length + (oldText.match(PHONE_RE) ?? []).length + [...oldText.matchAll(COUNT_RE)].length;
  const listy = (oldText.match(/[,;]/g) ?? []).length >= 2 && contentTokens(oldText).length >= 6;
  if (values < 2 && !listy) return null;
  const now = new Set(contentTokens(newText));
  const lost = [...new Set(contentTokens(oldText))].filter((t) => !now.has(t));
  if (lost.length <= 1) return null;
  let merged = oldText;
  let swaps = 0;
  const swapOne = (oldVals: string[], newVals: string[], same: (a: string, b: string) => boolean) => {
    const fresh = newVals.filter((n) => !oldVals.some((o) => same(o, n)));
    if (fresh.length !== 1) return;
    const cands = oldVals.filter((o) => !same(o, fresh[0]!));
    if (cands.length !== 1) return;
    merged = merged.replace(cands[0]!, fresh[0]!);
    swaps++;
  };
  swapOne(oldText.match(EMAIL_RE) ?? [], newText.match(EMAIL_RE) ?? [], (a, b) => a.toLowerCase() === b.toLowerCase());
  swapOne((oldText.match(PHONE_RE) ?? []).map((x) => x.trim()), (newText.match(PHONE_RE) ?? []).map((x) => x.trim()), (a, b) => digits(a) === digits(b));
  const counts = (t: string) => [...t.matchAll(COUNT_RE)].map((m) => ({ n: m[1]!, unit: m[2]!.toLowerCase().replace(/s$/, ''), raw: m[0]! }));
  for (const nc of counts(newText)) {
    const oc = counts(merged).filter((c) => c.unit === nc.unit && c.n !== nc.n);
    if (oc.length === 1) { merged = merged.replace(oc[0]!.raw, nc.raw); swaps++; }
  }
  return swaps ? { text: merged } : { keep: true };
}
