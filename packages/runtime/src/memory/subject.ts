// Who a stored sentence is ABOUT, and whether the user's own words back a change to it.
//
// Live QA #2 (2026-10-09): a free extractor wrote "Lives in Austin." for "my friend Sam lives in Austin", the single-valued
// "residence" slot treated it as the USER's new home and retired "Lives in Dallas.", and later "where does Sam live" read the
// subject-less line as Sam's. The cure is structural, not a better prompt:
//   1. every fact the model writes about the user starts with an explicit subject ("You live in Austin.", "Sam lives in
//      Austin."); a sentence with no subject is repaired when that is safe and dropped when it is not;
//   2. a slot (where you live, who you work for ...) is only ever compared between facts with the SAME subject;
//   3. a model may replace or retire a stored fact only when the user's own words in this turn contain the correction, said
//      in the first person (deterministic check below), or when the new sentence is a pure refinement of the old one.
import { contentTokens, normalize } from './text';

export type Subject = { kind: 'user' } | { kind: 'other'; name: string } | { kind: 'implicit' };

const USER_SUBJECT = /^(?:you|your|yours|you're|you've|you'd|you'll|the user|the user's|user|user's)(?=$|[\s,.'’])/i;

/** Third-person present verbs a legacy "Lives in Dallas." starts with (the model wrote the user's facts without a subject). */
const VERBS = new Set(
  `lives works prefers likes loves hates dislikes wants needs has owns uses speaks plays eats drinks avoids runs goes wakes studies enjoys keeps wears drives rides reads writes watches listens travels visits moves relocated moved started joined left quit stopped tends usually always never often is was does did wants hopes plans thinks believes feels takes makes sends asks gets gives calls tells says sees knows trusts cares manages leads teaches trains lifts cooks bakes paints draws sings dances sleeps studied graduated married divorced owes pays earns saves spends buys sells rents hosts attends celebrates follows grew was were`.split(
    /\s+/,
  ),
);
/** Attribute nouns a subject-less line starts with ("Name is Dana.", "Timezone is PST."): the thing belongs to the user. */
const ATTRIBUTE_NOUNS = new Set(`name timezone birthday favorite favourite job role title email phone address age dog cat pet car wife husband partner mother mom father dad brother sister cofounder boss manager company employer team office home city country language languages hobby hobbies diet goal goals budget schedule workday routine allergy allergies pronouns`.split(/\s+/));

/** Words that can follow a bare verb-first sentence ("Lives IN Dallas") - used to tell "Lives in x" from a name. */
const AFTER_VERB = new Set(['in', 'at', 'for', 'to', 'a', 'an', 'the', 'as', 'from', 'with', 'on', 'by', 'about', 'mostly', 'only', 'not', 'no', 'his', 'her', 'their', 'my', 'our', 'near', 'around', 'since', 'every', 'each', 'when', 'after', 'before', 'both', 'two', 'three', 'one', 'half', 'vegetarian', 'allergic']);
const PLAIN_VERB_AFTER_NAME = new Set(`is was has had lives works prefers likes loves hates dislikes wants needs owns uses speaks plays eats drinks avoids runs goes wakes studies enjoys moved relocated started joined left quit stopped got says said asked told thinks knows manages leads teaches runs founded co-founded cofounded builds built can could will would should may might must shall also always never usually just recently now still really often sometimes cannot doesn't isn't wasn't won't wants`.split(/\s+/));

/** "I live" -> "You live" and friends; applied before the subject is read. */
export function secondPerson(text: string): string {
  return text
    .replace(/^\s*I['’]m\b/, "You're")
    .replace(/^\s*I['’]ve\b/, "You've")
    .replace(/^\s*I['’]d\b/, "You'd")
    .replace(/^\s*I['’]ll\b/, "You'll")
    .replace(/^\s*I\b/, 'You')
    .replace(/^\s*(?:my|our)\b/i, 'Your')
    .replace(/^\s*me\b/i, 'You')
    .replace(/^\s*we\b/i, 'You');
}

/** "Your sister Priya lives ..." / "Your friend works ...": somebody ELSE is the subject of the sentence ("Your cofounder is Sam." stays the user's). */
const YOUR_RELATIVE = /^(?:your|the user['’]s)\s+(?:friend|brother|sister|wife|husband|partner|mom|mother|dad|father|boss|colleague|coworker|cofounder|co-founder|son|daughter|uncle|aunt|cousin|neighbou?r|manager|girlfriend|boyfriend|roommate|landlord|client|dog|cat|pet|kid|child)\b(?:\s+\p{Lu}\p{Ll}+)?(?=\s+(?:just\s+|recently\s+|also\s+|now\s+)?(?:lives?|works?|worked|moved|relocated|joined|switched|started|quit|left|got|stopped|owns|prefers|likes|eats|studies|studied|graduated|teaches|plays)\b)/iu;

const NAME_RUN =/^((?:\p{Lu}[\p{L}'’.-]*)(?:\s+\p{Lu}[\p{L}'’.-]*){0,2})(?:['’]s)?(?=\s|$|[,.])/u;

export function subjectOf(raw: string): Subject {
  const text = raw.trim();
  if (!text) return { kind: 'implicit' };
  // "Your sister Priya lives in Lisbon." is about the sister, not the user (the "Your" is a possessive, not the subject)
  const rel = YOUR_RELATIVE.exec(text);
  if (rel) return { kind: 'other', name: normalize(rel[0]) };
  if (USER_SUBJECT.test(text)) return { kind: 'user' };
  const first = text.split(/\s+/)[0]!.replace(/[^\p{L}'’-]/gu, '').toLowerCase();
  if (VERBS.has(first) || ATTRIBUTE_NOUNS.has(first)) return { kind: 'implicit' };
  const m = NAME_RUN.exec(text);
  if (!m) return { kind: 'implicit' };
  const rest = text.slice(m[0].length).trim();
  const next = (rest.split(/\s+/)[0] ?? '').replace(/[^\p{L}'’-]/gu, '').toLowerCase();
  const possessive = /^\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*){0,2}['’]s\b/u.test(text);
  // "Lives in Dallas." (verb) vs "Sam lives in Dallas." (a name): a bare capitalised word followed by a preposition is a verb
  if (!possessive && AFTER_VERB.has(next) && !PLAIN_VERB_AFTER_NAME.has(next) && m[1]!.split(/\s+/).length === 1 && first.endsWith('s')) return { kind: 'implicit' };
  if (!possessive && !PLAIN_VERB_AFTER_NAME.has(next) && !/(?:s|ed)$/.test(next)) return { kind: 'implicit' };
  if (possessive) {
    // "Sam's brother lives in Austin": the subject is the brother (up to the first verb), not Sam
    const words = text.split(/\s+/);
    const end = words.findIndex((w, i) => i > 0 && PLAIN_VERB_AFTER_NAME.has(w.toLowerCase().replace(/[^\p{L}'’-]/gu, '')));
    return { kind: 'other', name: normalize((end > 0 ? words.slice(0, end) : words.slice(0, 3)).join(' ')) };
  }
  return { kind: 'other', name: normalize(m[1]!) };
}

/** Key used to compare subjects: 'user' (an implicit subject is the user, the way every pre-2026-10-09 fact was written) or a name. */
export function subjectKey(text: string): string {
  const s = subjectOf(text);
  return s.kind === 'other' ? s.name : 'user';
}

const IRREGULAR: Record<string, string> = { is: 'are', has: 'have', does: 'do', goes: 'go', was: 'were' };
const conjugate = (w: string): string => {
  const lower = w.toLowerCase();
  if (IRREGULAR[lower]) return IRREGULAR[lower]!;
  if (/ies$/.test(lower) && lower.length > 4) return `${lower.slice(0, -3)}y`;
  if (/(?:ss|x|z|ch|sh|o)es$/.test(lower)) return lower.slice(0, -2);
  if (/s$/.test(lower) && !/ss$/.test(lower)) return lower.slice(0, -1);
  return lower;
};

/** "Lives in Dallas." -> "You live in Dallas." Only for a verb-first sentence; null when the sentence is not one. */
export function toYouForm(text: string): string | null {
  const t = text.trim();
  const head = (/^\p{L}[\p{L}'’-]*/u.exec(t)?.[0] ?? '').toLowerCase();
  if (ATTRIBUTE_NOUNS.has(head)) return `Your ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
  const m = /^(\p{L}[\p{L}'’-]*)(\s+[\s\S]*|[.!]?)$/u.exec(t);
  if (!m) return null;
  const w = m[1]!;
  const lower = w.toLowerCase();
  const verbish = VERBS.has(lower) || (/s$/.test(lower) && !/ss$/.test(lower) && AFTER_VERB.has((m[2] ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''));
  if (!verbish) return null;
  return `You ${conjugate(w)}${m[2] ?? ''}`;
}

/** A fact as the blob should read it: an old subject-less line gets "You ..." (render only; storage is left alone). */
export function renderFact(text: string): string {
  const s = subjectOf(text);
  if (s.kind !== 'implicit') return text;
  return toYouForm(text) ?? text;
}

/** A machine-written Core note, with every bullet that has no subject given one ("- Lives in Dallas." -> "- You live in Dallas."). */
export function renderCoreText(text: string): string {
  return text.replace(/^(\s*[-*]\s+)(.+)$/gm, (_m, bullet: string, body: string) => `${bullet}${renderFact(body)}`);
}

/**
 * The text a model proposed, with an explicit subject, or null when none can be given safely.
 * Repair is only offered when the user's own words are first person and name nobody else as the one doing it.
 */
export function withExplicitSubject(text: string, userText: string): string | null {
  const t = secondPerson(text.trim());
  const s = subjectOf(t);
  if (s.kind !== 'implicit') return t;
  const you = toYouForm(t);
  if (!you) return null;
  if (!FIRST_PERSON.test(userText) || mentionsOtherActor(userText, contentTokens(t))) return null;
  return you;
}

/** For a caller that is itself a model speaking about the user (the remember tool): an explicit subject or null. */
export function explicitSubjectOrNull(text: string): string | null {
  const t = secondPerson(text.trim());
  if (subjectOf(t).kind !== 'implicit') return t;
  return toYouForm(t);
}

// ---------- what the user's own words say ----------

const FIRST_PERSON = /\b(?:I|I['’]m|I['’]ve|I['’]d|I['’]ll|we|we['’]re|we['’]ve|my|our|me)\b/i;
const FIRST_PERSON_TOKENS = new Set(['i', "i'm", "i've", "i'd", "i'll", 'we', "we're", "we've", 'me', 'my', 'our']);
const PRONOUN_SUBJECT_TOKENS = new Set(['i', "i'm", "i've", "i'd", "i'll", 'we', "we're", "we've"]);
const FILLER = new Set(['just', 'recently', 'also', 'finally', 'now', 'already', 'actually', 'officially', 'then', 'really', 'only', 'even', 'still', 'soon', 'currently', 'permanently', 'since', 'and', 'so', 'but', 'that', 'because', 'when', 'after', 'before', 'if', 'though', 'while', 'yeah', 'ok', 'okay', 'well', 'update', 'fyi', 'btw', 'correction', 'note', 'hey', 'hi', 'yes', 'no', 'oh', 'um', 'uh', 'have', "'ve", 'had', 'am', "'m", 'was', 'will', "'ll", 'did', 'do', 'thanks', 'sorry', 'wait', 'right', 'ah']);
const THIRD_PARTY_NOUNS = new Set(['friend', 'brother', 'sister', 'wife', 'husband', 'partner', 'mom', 'mother', 'dad', 'father', 'boss', 'colleague', 'coworker', 'cofounder', 'co-founder', 'son', 'daughter', 'kid', 'child', 'uncle', 'aunt', 'cousin', 'neighbor', 'neighbour', 'manager', 'team', 'company', 'he', 'she', 'they', 'him', 'her', 'them', 'his', 'their', 'someone', 'somebody', 'girlfriend', 'boyfriend', 'roommate', 'landlord', 'client', 'customer']);

const lowerTokens = (s: string): string[] => s.toLowerCase().replace(/[’]/g, "'").split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')).filter(Boolean);

/**
 * The text just before a verb ("... Sam just " / "Update: I "): is the one doing it the user? True for "I", "we" (after
 * any filler) and for an elliptical sentence with no subject at all ("Moved to Austin last month").
 */
export function firstPersonBefore(prefix: string): boolean {
  const tail = prefix.split(/[,;:.!?()—–]|\s-\s/).pop() ?? '';
  const toks = lowerTokens(tail);
  while (toks.length && FILLER.has(toks[toks.length - 1]!)) {
    // "I have moved": drop the auxiliary, keep the pronoun. A filler that IS the whole clause means no explicit subject.
    toks.pop();
  }
  if (!toks.length) return true;
  const last = toks[toks.length - 1]!;
  return PRONOUN_SUBJECT_TOKENS.has(last);
}

const OTHER_ACTOR = /(?:^|[.!?]\s+|,\s+|;\s+|:\s+|\band\s+|\bbut\s+|\bthat\s+)(?!(?:I|I['’]m|I['’]ve|We|Actually|Update|Also|Now|So|But|And|Yes|No|Well|Note|FYI|BTW|Today|Recently|Currently|Hey|Hi|Thanks|Ok|Okay|Just|Please|Remember|Wait|Correction|Sorry|Oh|My|Our)\b)(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)?)\s+(?:just\s+|recently\s+|also\s+|now\s+)?(?:lives?|live|moved|relocated|works?|worked|joined|switched|started|quit|left|got|is|has|was|had|stopped|owns|prefers|likes|eats|doesn['’]?t|isn['’]?t|no longer)\b/gu;
const HE_SHE = /\b(?:he|she|they)\s+(?:just\s+|recently\s+|also\s+|now\s+)?(?:lives?|moved|relocated|works?|worked|joined|switched|started|quit|left|got|is|has|was|had|stopped|owns|prefers|likes|eats|doesn['’]?t|isn['’]?t|no longer)\b/i;
const MY_RELATIVE = /\b(?:my|our)\s+(?:friend|brother|sister|wife|husband|partner|mom|mother|dad|father|boss|colleague|coworker|cofounder|co-founder|son|daughter|uncle|aunt|cousin|neighbou?r|manager|girlfriend|boyfriend|roommate|landlord|client)(?:\s+\p{Lu}\p{Ll}+)?\s+(?:just\s+|recently\s+|also\s+|now\s+)?(?:lives?|moved|relocated|works?|worked|joined|switched|started|quit|left|got|stopped|owns|prefers|likes|eats|doesn['’]?t|isn['’]?t|no longer)\b/iu;

/**
 * Does the message talk about somebody ELSE doing something (a name, "she", "my brother")? `known` are words the caller
 * already treats as VALUES ("Dallas", "Austin"): a place at the head of a clause ("Dallas is gone") is not a person.
 */
export function mentionsOtherActor(text: string, known: readonly string[] = []): boolean {
  const skip = new Set(known.map((k) => k.toLowerCase()));
  for (const m of text.matchAll(OTHER_ACTOR)) {
    const name = (m[1] ?? '').toLowerCase();
    if (name && contentTokens(name).every((t) => skip.has(t))) continue;
    return true;
  }
  return HE_SHE.test(text) || MY_RELATIVE.test(text);
}

const CHANGE_WORDS = /\b(now|moved|relocat\w+|actually|instead|no longer|any ?more|that['’]?s (?:wrong|not (?:right|true|correct)|incorrect|outdated)|not true|isn['’]?t (?:right|true)|wrong|used to|these days|currently|new job|switched|started at|joined|changed|not .{1,30} (?:but|rather)|correction|update|forget|gone|stopped|quit|no more|scrap that|never ?mind|ignore that|delete|erase)\b/i;
export const hasChangeWords = (userText: string): boolean => CHANGE_WORDS.test(userText);

/** Tokens of `text` that carry its value: no subject words, nothing the other sentence already says. */
function valueTokens(text: string, other: string): string[] {
  const o = new Set(contentTokens(other));
  return contentTokens(text.replace(USER_SUBJECT, '')).filter((t) => !o.has(t) && t !== 'user');
}

/** First words that may start an elliptical clause without a subject ("Moved to Austin", "Now vegetarian"). */
const ELLIPSIS_HEADS = new Set(['now', 'actually', 'update', 'fyi', 'correction', 'instead', 'no', 'not', 'thanks', 'sorry', 'also', 'and', 'but', 'so', 'just', 'recently', 'finally']);

/** True when the user's clause that holds `token` is first person ("I moved to Austin") and nobody else is the actor. */
function firstPersonNear(userText: string, token: string): boolean {
  const clauses = userText.split(/[,;:.!?\n]|\s-\s|\s\u2014\s|\bbut\b/i);
  for (const clause of clauses) {
    const toks = lowerTokens(clause);
    const idx = toks.findIndex((w) => contentTokens(w)[0] === token || w === token);
    if (idx < 0) continue;
    const words = clause.trim().split(/\s+/);
    let p = -1;
    for (let i = Math.min(idx, toks.length) - 1; i >= 0; i--) if (FIRST_PERSON_TOKENS.has(toks[i]!)) { p = i; break; }
    // with no pronoun the clause must at least not name anybody else ("Moved to Austin" is the user's; "Sam moved to Austin" is not)
    for (let i = p + 1; i < idx; i++) {
      const w = words[i] ?? '';
      if (THIRD_PARTY_NOUNS.has(toks[i]!)) return false;
      if (/^\p{Lu}/u.test(w) && !(p < 0 && i === 0 && (VERBS.has(toks[i]!) || ELLIPSIS_HEADS.has(toks[i]!) || FILLER.has(toks[i]!)))) return false; // a capitalised word between "I" and the value is somebody's name
    }
    return true;
  }
  return false;
}

export interface EvidenceInput {
  userText: string;
  newText: string;
  targetText: string;
}

/**
 * Deterministic: do the USER's words in this turn contain the correction? The new value must be said by the user
 * (never taken from the assistant), a change word must be there, and the clause saying it must be first person.
 */
export function correctionEvidence(i: EvidenceInput): boolean {
  if (!hasChangeWords(i.userText)) return false;
  const vals = valueTokens(i.newText, i.targetText);
  if (vals.length === 0) return false;
  const said = new Set(contentTokens(i.userText));
  if (!vals.every((v) => said.has(v))) return false;
  return vals.some((v) => firstPersonNear(i.userText, v));
}

/** Evidence for dropping a fact with no replacement ("I don't eat meat anymore"): the user names it, first person, with a change word. */
export function retireEvidence(userText: string, targetText: string): boolean {
  if (!hasChangeWords(userText)) return false;
  const vals = valueTokens(targetText, '');
  if (vals.length === 0) return false;
  const said = new Set(contentTokens(userText));
  const hit = vals.filter((v) => said.has(v));
  if (hit.length < Math.max(1, Math.ceil(vals.length * 0.67))) return false;
  if (mentionsOtherActor(userText, vals)) return false;
  return FIRST_PERSON.test(userText) || !/\b(?:he|she|they)\b/i.test(userText);
}

/** The new sentence says everything the old one did and then more ("Lives in Texas." -> "You live in Austin, Texas."). */
export function refines(newText: string, targetText: string): boolean {
  const old = contentTokens(targetText.replace(USER_SUBJECT, ''));
  if (old.length === 0) return false;
  const now = new Set(contentTokens(newText));
  return old.every((t) => now.has(t)) && contentTokens(newText).length > old.length;
}

const MONTHS = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi;
/** A date / year / number in the fact the user never said: a model's flourish ("moved from Dallas in September 2026"). */
export function hasUngroundedDetail(factText: string, userText: string): boolean {
  const said = userText.toLowerCase();
  const nums = factText.match(/\b\d[\d,.:/-]*\b/g) ?? [];
  for (const n of nums) if (!said.includes(n.toLowerCase())) return true;
  const months = factText.match(MONTHS) ?? [];
  for (const m of months) if (!new RegExp(`\\b${m}`, 'i').test(userText)) return true;
  return false;
}

// ---------- contact details ----------

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/;
export const hasContactDetail = (s: string): boolean => EMAIL.test(s) || PHONE.test(s);

/**
 * Contact details (email / phone) of anyone but the user are held for the user's OK on every path: a fact "Sam's email is
 * sam@example.com" would otherwise ride into every other blob's prompt.
 */
export function isOtherPersonContact(text: string): boolean {
  if (!hasContactDetail(text)) return false;
  const s = subjectOf(text);
  if (s.kind !== 'user') return true; // somebody else's, or nobody's we can name: held either way
  // "You can reach Sam at sam@example.com": the user is the grammatical subject but somebody else owns the number
  const stripped = text.replace(EMAIL, ' ').replace(PHONE, ' ');
  const names = stripped.match(/\b\p{Lu}\p{Ll}{1,}\b/gu) ?? [];
  const notNames = new Set(['You', 'Your', 'The', 'User', 'Email', 'Phone', 'Number', 'Contact', 'Address', 'Mobile', 'Work', 'Home', 'Personal', 'Primary', 'Gmail', 'Outlook', 'My', 'Reach']);
  return names.some((n) => !notNames.has(n));
}

export { normalize };
