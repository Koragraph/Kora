// Small text helpers: token estimates, FTS query building, similarity, sensitivity checks.

export const estimateTokens = (s: string): number => Math.ceil(s.length / 3.6);

const STOP = new Set(
  `a an and are as at be but by for from had has have he her his i if in into is it its me my of on or our she so than that the their them then there they this to was we were what when where which who will with you your about can do does did not no just like get got how also been being am us up out over user`.split(
    /\s+/,
  ),
);

export function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** `stem` plus the silent e: "live" / "lives" / "living" / "lived" are one word when facts are compared. */
export function stemMatch(w: string): string {
  const r = stem(w);
  return r.length > 3 && r.endsWith('e') ? r.slice(0, -1) : r;
}

export function words(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) as string[];
}

/** Stemmed, stop-word-free tokens. */
export function contentTokens(s: string): string[] {
  const out: string[] = [];
  for (const w of words(s)) if (w.length >= 2 && !STOP.has(w)) out.push(stemMatch(w));
  return out;
}

/** FTS5 MATCH expression (quoted terms OR'd; the porter tokenizer stems), or null when nothing useful. */
export function ftsQuery(s: string): string | null {
  const seen = new Set<string>();
  for (const w of words(s)) {
    if (w.length < 2 || STOP.has(w)) continue;
    seen.add(w);
    if (seen.size >= 24) break;
  }
  if (seen.size === 0) return null;
  return [...seen].map((w) => `"${w}"`).join(' OR ');
}

export const normalize = (s: string): string => words(s).join(' ');

export function jaccard(a: string, b: string): number {
  const A = new Set(contentTokens(a));
  const B = new Set(contentTokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Fraction of the query's content tokens that appear in `text`. */
export function coverage(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) return 0;
  const T = new Set(contentTokens(text));
  let hit = 0;
  for (const q of queryTokens) if (T.has(q)) hit++;
  return hit / queryTokens.length;
}

const SECRET =
  /(\bsk-[A-Za-z0-9_-]{16,}|\b(?:\d[ -]?){13,19}\b|\b\d{3}-\d{2}-\d{4}\b|\b(password|passcode|api[_ -]?key|secret|token)\b\s*(is|:|=)\s*\S+|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{20,}\b)/i;
/** Credentials and ID numbers are never stored, not even as pending. */
export const looksLikeSecret = (s: string): boolean => SECRET.test(s);

const SECRET_MARK = '[secret removed]';
/** Token shapes that are credentials on their own, whatever surrounds them. */
const SECRET_TOKENS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
];
/** "my password is X", "PIN: 1234", "api key = X": the keyword stays, the value goes. A value already scrubbed is left
 * alone: turns are scrubbed in BlobRuntime.afterTurn and again in ingestTurn ("[secret removed] removed]", plv S3-1). */
const SECRET_PHRASE = /\b((?:pass(?:word|code|phrase)|passwd|pwd|pin(?:\s*code)?|api[_ -]?key|secret(?:\s*key)?|access[_ -]?token|auth[_ -]?token|token|security code|cvv|cvc)\b(?:\s+(?:for|to|on)\s+[\w.@-]+)?\s*(?:is|was|=|:|-)\s*)(?!\[secret removed\])(["'`]?)([^\s"'`]+)\2/gi;
const luhn = (digits: string): boolean => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};
const entropy = (s: string): number => {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const v of n.values()) { const p = v / s.length; h -= p * Math.log2(p); }
  return h;
};
/** A long random-looking word (mixed case + digits, high entropy, not a path or a hex hash): an unlabelled key or token. */
const looksRandomKey = (w: string): boolean =>
  w.length >= 32 && /[a-z]/.test(w) && /[A-Z]/.test(w) && /\d/.test(w) && !/^[0-9a-f]+$/i.test(w) &&
  (!w.includes('/') || /=$/.test(w)) && entropy(w) >= 4;

/**
 * Remove credentials from text before it is stored or indexed (raw turns, episode search, summaries, the retry queue):
 * labelled values ("my password is X"), known token shapes (sk-, ghp_, AKIA…, JWTs, private keys), card numbers (Luhn)
 * and long high-entropy strings. Over-scrubbing costs a word of context; under-scrubbing keeps a password searchable.
 */
export function scrubSecrets(s: string): string {
  if (!s) return s;
  let t = s;
  for (const re of SECRET_TOKENS) t = t.replace(re, SECRET_MARK);
  t = t.replace(SECRET_PHRASE, (_m, lead: string) => `${lead}${SECRET_MARK}`);
  t = t.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => (luhn(m.replace(/\D/g, '')) ? SECRET_MARK : m));
  t = t.replace(/[A-Za-z0-9_+\-/=]{32,}/g, (m) => (looksRandomKey(m) ? SECRET_MARK : m));
  return t;
}

const SENSITIVE = [
  /\b(diagnos\w*|medicat\w*|prescri\w*|therap(y|ist)|depress\w*|anxiety|cancer|pregnan\w*|surgery|chronic|disorder|adhd|bipolar|hiv|diabet\w*|allerg\w*|illness|disease|mental health|rehab|sober|addict\w*|panic attack)\b/i,
  /(\$\s?\d|\b(salary|income|net worth|debt|mortgage|loan|bank account|credit score|savings|tax return|owes?|owed)\b)/i,
  /\b(lawsuit|divorce|arrest\w*|immigration|visa status|sexual orientation|religio\w*|political party)\b/i,
];
export const looksSensitive = (s: string): boolean => SENSITIVE.some((r) => r.test(s));

/** Collapse whitespace, strip control chars, cap length. */
export function cleanText(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).trim() : t;
}

/** Pull the first JSON object/array out of a model reply (fences, prose around it). */
export function extractJson(raw: string): unknown {
  if (typeof raw !== 'string') return undefined;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const a = s.indexOf(open);
    const b = s.lastIndexOf(close);
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1));
      } catch {
        /* try next */
      }
    }
  }
  return undefined;
}


// ---------- task instructions are not facts about the user ----------
// Launch QA (2026-10-09): "Only use my LQ- blobs" and "You are in a QA test" were saved as durable "you" facts and then
// steered the owner's real blobs. An instruction to the agent, test scaffolding or a one-off task constraint says nothing
// lasting about the user; only what they state about THEMSELVES is kept.

/** A stored sentence that is really a task / session instruction or test scaffolding. */
export function looksLikeTaskInstruction(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  return (
    /\bLQ-[\w-]*/i.test(t) ||
    /\b(qa|quality[- ]assurance)\b.{0,30}\b(test|run|session|harness)\b|\b(test(?:ing)?|dry)[- ](?:session|run|account|harness|mode)\b|\bthis is a test\b|\bin a (?:qa |test )/i.test(t) ||
    /\b(?:only|just) use\b|\buse (?:only|just)\b|\bonly (?:with|via|through) (?:your|my|the) (?:own )?\w+ ?blobs?\b/i.test(t) ||
    /\btasks? (?:handled|done|delegated)\b|\bhandled with (?:your|my|the) own\b/i.test(t) ||
    /\b(?:for|in|during) (?:this|the) (?:task|session|test|run|job|chat|conversation|thread)\b/i.test(t) ||
    /\b(?:do not|don't|never) (?:touch|use|message|ask|call|spawn)\b.{0,40}\b(?:owner|other|real) blobs?\b/i.test(t)
  );
}

/** The user's message is a request or an instruction for the agent (not the user talking about themselves). */
export function isTaskRequest(userText: string): boolean {
  const first = userText.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? '';
  return (
    /^(?:please\s+|ok(?:ay)?[, ]+|now\s+|can you\s+|could you\s+)?(?:write|draft|plan|find|make|create|build|research|summari[sz]e|compare|send|book|look up|check|run|use|only|do not|don't|keep|put|add|open|go to|search|list|show|tell|give|set up|generate|fix|update|delete|forward|reply|schedule|prepare|collect|gather|read)\b/i.test(first) ||
    looksLikeTaskInstruction(userText)
  );
}

/**
 * The user states how they want ANSWERS in general ("keep answers short, I read on my phone", "I prefer bullet
 * points"): a lasting style preference, kept even though it is phrased as an order. A constraint on one task
 * ("keep it under 200 words", "use only X") is not.
 */
export function statesLastingPreference(userText: string, factText: string): boolean {
  if (looksLikeTaskInstruction(userText) || looksLikeTaskInstruction(factText)) return false;
  const what = /\b(?:answers?|repl(?:y|ies)|responses?|explanations?|messages?|summaries)\b/i;
  const how = /\b(short|brief|concise|terse|detailed|bullet|plain|simple|formal|casual)\b/i;
  return what.test(userText) && what.test(factText) && how.test(userText) && how.test(factText) && /\b(prefer|like|want|need|read|always|usually|generally|from now on)\b/i.test(`${userText} ${factText}`);
}

/** Some sentence of the user's message is a first-person statement that this fact actually restates. */
export function statedAboutSelf(factText: string, userText: string): boolean {
  const facts = contentTokens(factText).filter((w) => !['you', 'your', 'user'].includes(w));
  if (facts.length === 0) return false;
  for (const sentence of userText.split(/(?<=[.!?])\s+|\n+/)) {
    if (!/\b(i|i'm|i am|i've|i'd|my|me|mine|we|our)\b/i.test(sentence)) continue;
    if (isTaskRequest(sentence)) continue; // "Use my LQ- blobs" is first person, but an order
    const have = new Set(contentTokens(sentence));
    const hit = facts.filter((w) => have.has(w)).length;
    if (hit / facts.length >= 0.5) return true;
  }
  return false;
}
