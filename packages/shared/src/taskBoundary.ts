/**
 * Task-boundary detection (overnight B5). A long thread (60k+ tokens) pays for all of its history on every message, so when
 * the user's next prompt starts something unrelated, a fresh start is cheaper than carrying the old task along. This decides
 * whether to OFFER one: it never acts. Pure, so the composer can run it on every keystroke.
 *
 * The word extraction follows the graph injection's `distillQuery` (runtime graph/prompt-inject.ts): identifiers first
 * (camelCase / snake_case / dotted), then content words of five letters or more minus filler. The web client cannot import the
 * runtime, hence this copy; keep the two regexes alike.
 */

export const TASK_BOUNDARY_MIN_TOKENS = 60_000;
/** How much of a long thread's size compaction typically removes (117k -> ~40k measured in the master plan). */
export const COMPACTION_SHRINK = 0.6;

const STOP = new Set([
  "about",
  "after",
  "again",
  "before",
  "being",
  "between",
  "could",
  "every",
  "first",
  "going",
  "having",
  "inside",
  "might",
  "other",
  "please",
  "should",
  "since",
  "still",
  "their",
  "there",
  "these",
  "thing",
  "things",
  "think",
  "those",
  "through",
  "under",
  "until",
  "using",
  "where",
  "which",
  "while",
  "would",
  "write",
  "make",
  "makes",
  "want",
  "need",
  "like",
  "also",
  "some",
  "that",
  "this",
  "with",
  "from",
  "have",
  "what",
  "when",
  "will",
  "your",
  "just",
  "then",
  "them",
  "they",
  "into",
  "does",
  "work",
  "working",
  "look",
  "looks",
  "file",
  "files",
  "code",
  "change",
  "changes",
  "check",
  "tell",
  "show",
  "help",
  "next",
  "good",
  "great",
  "okay",
  "thanks",
  "thank",
]);
const IDENT =
  /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g;
const PATHISH = /[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/g;
/** A prompt that continues the previous one ("and also...", "now run it", "yes") is not a new task. */
const CONTINUES =
  /^\s*(and|also|then|now|ok|okay|yes|yeah|no|nope|thanks|thank you|sure|go ahead|continue|keep going|that|this|it|those|same|again|retry|try)\b/i;

/** Lower-cased comparison tokens of a text: identifiers (whole and split into parts), path segments, content words. */
export function taskTokens(text: string): Set<string> {
  const out = new Set<string>();
  const t = text || "";
  const add = (w: string) => {
    const x = w.toLowerCase().replace(/^[._-]+|[._-]+$/g, "");
    if (x.length >= 4 && !STOP.has(x)) out.add(x);
  };
  for (const m of t.match(IDENT) ?? []) {
    add(m);
    for (const part of m.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/)) add(part);
  }
  for (const m of t.match(PATHISH) ?? []) for (const part of m.split(/[/.]+/)) add(part);
  for (const w of t
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/))
    if (w.length >= 5) add(w);
  return out;
}

export interface TaskBoundaryInput {
  /** what the user is about to send */
  draft: string;
  /** the text of the last three turns (their prompts and the replies) */
  recent: readonly string[];
  usedTokens: number | null | undefined;
  /** user prompts in the thread so far */
  userTurns: number;
}
export interface TaskBoundaryVerdict {
  offer: boolean;
  overlap: number;
  savedTokens: number;
}

/** Tokens a compaction would take off every later message. */
export function compactionSaving(usedTokens: number): number {
  return Math.round(usedTokens * COMPACTION_SHRINK);
}

export function taskBoundaryVerdict(i: TaskBoundaryInput): TaskBoundaryVerdict {
  const none = { offer: false, overlap: 1, savedTokens: 0 };
  const used = i.usedTokens ?? 0;
  const draft = (i.draft || "").trim();
  if (used < TASK_BOUNDARY_MIN_TOKENS || i.userTurns < 3) return none;
  if (draft.length < 24 || draft.startsWith("/") || CONTINUES.test(draft)) return none;
  const d = taskTokens(draft);
  if (d.size < 3) return none;
  const r = new Set<string>();
  for (const text of i.recent) for (const w of taskTokens(text)) r.add(w);
  let shared = 0;
  for (const w of d) if (r.has(w)) shared++;
  const overlap = shared / d.size;
  // Few shared words: none at all, or one in ten at most.
  const offer = shared === 0 || overlap <= 0.1;
  return { offer, overlap, savedTokens: offer ? compactionSaving(used) : 0 };
}

/** What the "Compact first" chip sends: the slash command with the keep-list the compactor should follow. */
export const COMPACT_KEEP_INSTRUCTIONS =
  "Keep decisions and preferences, every file changed and why, failing tests or errors, open TODOs and the next step. Drop file bodies and long output.";
export function compactCommandText(): string {
  return `/compact ${COMPACT_KEEP_INSTRUCTIONS}`;
}
