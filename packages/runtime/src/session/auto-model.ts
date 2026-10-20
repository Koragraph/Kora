// Auto model (the composer's "Auto" pick): a thread picks its model from its first prompt, before the first API call, so
// the choice costs no cache. Light work (a question about the code, a lookup, a mechanical one-place edit, a chore) runs on
// Haiku 5.5, about 1/20 of Sonnet 5.5 per token; everything else runs on the user's own model (the "ceiling", their
// Default). The pick then sticks: a mid-thread switch re-writes the whole context at the new model's cache-write price.
// The one exception is an ESCALATION, up only: the user says the light model got it wrong, asks for a stronger model, or
// hands the thread real work; that switch is cheap because a light thread's context is small.
//
// PURE and deterministic (no model call, no I/O): an explainable rule list, so a wrong pick can be read and fixed. When in
// doubt it answers "standard": a missed saving costs money, a wrong light pick costs the user's trust.

export type AutoTier = 'light' | 'standard';
export interface AutoDecision { tier: AutoTier; reason: string }
export interface AutoInput {
  text: string;
  images?: number;        // attached pictures (a screenshot of a bug is rarely a one-liner)
  orchestrator?: boolean; // a lead that delegates plans for everyone: never light
}

/** The light model Auto runs: a full id, so an older Claude Code that does not know the alias still launches it. */
export const AUTO_LIGHT_MODEL = 'claude-haiku-5-5';

// Checked first: any hit keeps the user's model.
const HEAVY = [
  // building and changing structure
  /\b(implement|refactor|rewrite|re-?architect|architect|migrate|optimi[sz]e|speed up|parallelize|redesign)\b/i,
  /\bdesign (a|an|the)\b/i,
  /\bbuild (a|an|me|out|up)\b/i,
  /\b(create|write|add|make) (a |an |the )?(new )?(feature|component|class|module|service|page|screen|endpoint|route|app|cli|tool|function|method|hook|test|tests|spec|migration|schema|driver|provider|integration|command)s?\b/i,
  /\b(write|add) (unit |integration |e2e )?tests?\b/i,
  /\b(add|support|implement) .{0,40}\b(feature|endpoint|screen|page|command|integration|provider|driver|mode)s?\b/i,
  // bugs and hard properties
  /\b(bug|broken|crash(es|ing)?|fails?|failing|failure|error|exception|regression|wrong|incorrect|doesn'?t work|not working|hangs?|stuck|slow)\b/i,
  /\b(race|deadlock|concurren|thread[- ]safe|memory leak|leaks?|flaky|intermittent|perf(ormance)?|security|vulnerab|exploit)/i,
  /\b(debug|investigate|root[- ]cause|diagnose|figure out|track down|why (does|is|do|are|did|would|was))\b/i,
  // thinking work
  /\b(plan|strategy|trade-?offs?|approach|proposal|review|audit|compare|evaluate|assess|recommend)\b/i,
  /\b(ultrathink|think (hard|harder|deeply|carefully|it through)|step by step|carefully|thorough(ly)?|in depth|deep dive)\b/i,
  // breadth
  /\b(all|every|each) (the |of the )?(files?|callers?|usages?|places?|tests?|modules?|occurrences?)\b/i,
  /\b(across|throughout) (the |this |our )?(repo|codebase|project|code|app)\b/i,
];

// Only reached when nothing heavy matched. A hit means the work is light.
const LIGHT = [
  // read-only questions and lookups
  /^(where|what|which|who|how (does|do|is|are|many|much)|is there|are there|does|do|can you (tell|show|find|list|explain)|show( me)?|list|find|locate|explain|summari[sz]e|describe|tell me|walk me through)\b/i,
  /\b(where is|where are|where do|what does|what is|which file|who calls|what calls|how is .{1,40} (used|called|defined))\b/i,
  // mechanical one-place edits
  /\b(rename|typo|spelling|reword|rephrase|bump|update the version|change (the )?(text|label|copy|string|wording|color|colour|title|message|name|default|value|port|timeout|version|icon|placeholder))\b/i,
  /\b(add|remove|delete|update) (a |an |the )?([\w-]+ )?(comment|docstring|jsdoc|log( line)?|console\.log|print|import|todo|badge|link|line|entry|field|key|env var|dependency)\b/i,
  /\b(format|prettier|sort (the )?imports|remove (the )?unused|fix (the )?(lint|format(ting)?|indent(ation)?|typo|spelling|import))/i,
  // chores
  /\b(commit|commit message|stage|git (status|log|diff|add|stash|branch|checkout|pull)|create (a )?branch|changelog|release notes|readme)\b/i,
  /\b(run (the )?(tests?|build|lint|linter|typecheck|script)|what changed|summari[sz]e (the )?(diff|changes|commits?))\b/i,
];

const LONG_CHARS = 700;      // a spec, a pasted log or a long brief is not light
const LONG_LINES = 12;

/** The tier for a thread's first prompt. */
export function classifyPrompt(input: AutoInput): AutoDecision {
  const text = (input.text ?? '').trim();
  if (!text) return { tier: 'standard', reason: 'empty prompt' };
  if (input.orchestrator) return { tier: 'standard', reason: 'a lead plans for its workers' };
  if ((input.images ?? 0) > 0) return { tier: 'standard', reason: 'has a picture' };
  if (text.length > LONG_CHARS || text.split('\n').length > LONG_LINES) return { tier: 'standard', reason: 'long prompt' };
  if (/```|^\s*at .+:\d+:\d+\)?$|Traceback \(most recent call last\)|^\s*(Error|TypeError|panic):/im.test(text)) return { tier: 'standard', reason: 'pasted code or a stack trace' };
  const heavy = HEAVY.find((re) => re.test(text));
  if (heavy) return { tier: 'standard', reason: 'real work' };
  const light = LIGHT.find((re) => re.test(text));
  if (light) return { tier: 'light', reason: lightReason(text) };
  return { tier: 'standard', reason: 'not clearly light' };
}

function lightReason(text: string): string {
  if (/\b(commit|git |branch|changelog|readme|docs?)\b/i.test(text)) return 'a chore';
  if (/\b(run (the )?(tests?|build|lint|typecheck))\b/i.test(text)) return 'run and report';
  if (/\b(rename|typo|bump|change|add|remove|delete|update|format|lint|sort)\b/i.test(text) && !/^(where|what|which|who|how|is|are|does|do|show|list|find|explain)\b/i.test(text)) return 'a small edit';
  return 'a question about the code';
}

/**
 * Should a thread Auto put on the light model move up to the user's model before this prompt? Up only, once.
 * `stuck`: the runaway guard fired in this thread. Null = stay.
 */
// ── Middle tier: Sonnet for ordinary work (opt-in) ──────────────────────────────────────────────────────────────────
// When the user's Default is Opus or Fable (twice Sonnet 5.5's price per token) and the middle tier is on, an Auto thread
// doing ordinary work runs on Sonnet 5.5 at high effort, its own default (at medium Sonnet 5.5 loses 7-15 points on
// Anthropic's coding tables). Decided at thread start, so it costs no cache. Work that asks for the strongest model
// outright keeps the Default, and a complaint, an explicit ask or a stuck turn moves the thread up, once.

/** The middle-tier model: a full id, like AUTO_LIGHT_MODEL. */
export const AUTO_MID_MODEL = 'claude-sonnet-5-5';

/** The Default is worth a middle tier under it: an Opus or Fable family id. */
export function hasMidTier(ceiling: string): boolean {
  return /(^|-)(opus|fable)(-|$)/i.test(ceiling);
}

/** The effort the middle tier runs: Sonnet's own default (high) unless the thread asked for more. */
export function midEffort(effort: string | null | undefined): string {
  return effort === 'xhigh' || effort === 'max' || effort === 'high' ? effort : 'high';
}

/** A prompt that asks for the strongest model's own reasoning: the thread keeps the Default. */
export function wantsCeiling(text: string): boolean {
  return /\b(ultrathink|think (hard|harder|deeply|very carefully)|use (opus|fable|the (best|strongest) model|a (stronger|smarter|better|bigger) model)|re-?architect|architecture (of|for)|security (audit|review)|threat model)\b/i.test(text ?? '');
}

/** Why a middle-tier thread moves up to the Default (once, up only), or null: stuck, a complaint, or asked for it outright. */
export function midEscalation(text: string, opts: { stuck?: boolean } = {}): string | null {
  if (opts.stuck) return 'Sonnet looked stuck';
  const why = escalation(text);
  if (why === 'you asked for a stronger model' || why === 'you said the answer was not right') return why;
  return wantsCeiling(text) ? 'you asked for a stronger model' : null;
}

export function escalation(text: string, opts: { stuck?: boolean } = {}): string | null {
  const t = (text ?? '').trim();
  if (opts.stuck) return 'the light model looked stuck';
  if (!t) return null;
  if (/\b(use|switch to|try) (a )?(sonnet|opus|smarter|stronger|better|bigger) (model)?\b|\b(ultrathink|think (hard|harder|deeply|carefully))\b/i.test(t)) return 'you asked for a stronger model';
  if (/\b(still (fails?|failing|broken|wrong|not working|doesn'?t work)|does(n'?t| not) work|did(n'?t| not) work|not working|that(?:'?s| is) (wrong|not (it|right))|wrong (answer|file|fix|place)|try again|you (broke|missed|forgot)|this is wrong|not what i (asked|wanted|meant)|no,? (that|it)'?s? (not|wrong))\b/i.test(t)) return 'you said the answer was not right';
  // A light thread stays light only while each follow-up is light too, or a bare acknowledgement. Anything else (not
  // clearly light, long, pasted code) is a new task: R6 replay, 9 of 11 follow-ups that stayed on Haiku were new tasks.
  const c = classifyPrompt({ text: t });
  if (c.tier === 'standard' && !ACK.test(t)) return 'the thread moved on to real work';
  return null;
}
// Closers only: "yes", "continue", "go ahead" often approve a plan the light model proposed (R5), so they move up.
const ACK = /^(?:(?:ok(?:ay)?|k|thanks?|thank you|ty|cool|great|nice|perfect|got it|lgtm)[\s,.!]*)+$/i;

// Auto effort (opt-in, Settings › Token savings): the effort of ONE turn, from the human message that starts it. A pure chore
// (commit, push, run the tests) runs at low; the turn right after a low one that says it went wrong runs at high, once. Every
// other turn keeps the thread's own effort. Measured on the user's 835 real turns (R5, 2026-10-16): a small lever (0-4% of a
// lead's $). Raising effort on failure wording alone costs more than it saves (it is unreliable from text), and a user's
// own high / xhigh / max is never lowered. Cache-safe: the CLI takes a new effort between turns (claude-driver setEffort).

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
// The whole message is chores and politeness, nothing else ("commit and push", "run the tests again please"). Not "yes",
// "go ahead", "continue" or "merge": those often approve a big plan or a conflict that needs thought.
const CHORE_ONLY = /^(?:(?:please|pls|now|then|and|also|ok(?:ay)?|thanks?|thank you|commit(?: (?:it|this|that|them|everything|all|the changes))?|push(?: it)?|(?:re-?)?run (?:the )?(?:tests?|suite|build|lint|linter|typecheck|type-?check)(?: again)?|rerun (?:it|them|the tests)|git (?:status|log|diff|pull|push))[\s,.!;:]*)+$/i;
const CHORE_VERB = /\b(commit|push|run|rerun|re-run|git)\b/i;

/**
 * An effort change keeps the prompt cache only on the 5.5 models and Fable 5 (live check 2026-10-16; API effort docs).
 * Elsewhere each change re-computes the whole request, so Auto effort leaves those threads alone (R6 review #8).
 */
export function effortChangeCacheSafe(modelId: string): boolean {
  return /(^|-)(opus|sonnet|haiku)-5-5(\b|$)|(^|-)fable-5/i.test(modelId);
}

export interface TurnEffort { effort: string; reason: string }
/**
 * This turn's effort when it should differ from the thread's own (`base`, the user's pick or Kora's default), else null.
 * `afterLow`: the previous real turn ran at low by this rule.
 */
export function turnEffort(text: string, base: string, opts: { afterLow?: boolean } = {}): TurnEffort | null {
  const t = (text ?? '').trim();
  const at = EFFORT_ORDER.indexOf(base);
  if (!t || at < 0) return null;
  if (opts.afterLow && escalation(t) === 'you said the answer was not right') return at < 2 ? { effort: 'high', reason: 'the low-effort turn went wrong' } : null;
  if (base === 'medium' && t.length <= 80 && CHORE_ONLY.test(t) && CHORE_VERB.test(t)) return { effort: 'low', reason: 'a chore' };
  return null;
}
