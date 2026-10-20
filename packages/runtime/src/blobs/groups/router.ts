// Who answers. The decision is made by code, in this order (docs/bots/GROUPS.md):
//   1. @mentions always win (`@all` = every member but the author). Used by users AND by members handing over.
//   2. nothing mentioned, the author is a member (a hand-over reply with no mention): nobody. Members never start chains
//      by themselves; that is the loop guard's first line.
//   3. the user wrote with no mention: the group's rule - `mention` -> nobody, `lead` -> the lead, `auto` -> a cheap model
//      picks ONE member from the capability cards, and the lead answers on timeout, doubt or no model at all.
import { renderCard, type CapabilityCard } from '../cards';
import type { OneShot } from '../types';
import { parseMentions, type MentionTarget } from './mentions';
import type { GroupMessage, GroupProfile } from './types';

export type RouteReason = 'mention' | 'all' | 'lead' | 'auto' | 'auto-fallback' | 'single' | 'no-mention' | 'member-silent';
export interface RouteDecision {
  /** Member ids that should reply, in order. */
  recipients: string[];
  reason: RouteReason;
  /** Why auto fell back to the lead (timeout / doubt / no-model / bad-answer), for the log and the tooltip. */
  detail?: string;
  /** Milliseconds the pick took (auto only). */
  pickMs?: number;
  /** The model that picked, when one did. */
  model?: string;
}

/** ~2 s on a warm Haiku session (measured 2.7 s for the first answer of a fresh one); then the lead answers and the chip says why. */
export const AUTO_PICK_BUDGET_MS = 3_000;
/** How much recent conversation the picker sees (follow-ups like "and the budget?" need it). */
export const PICK_CONTEXT_MESSAGES = 4;
const PICK_CLIP = 220;

export interface RouteInput {
  group: Pick<GroupProfile, 'memberIds' | 'leadId' | 'rule'>;
  members: readonly MentionTarget[];
  text: string;
  /** `user` or a member's blob id. */
  authorId: string;
  cards?: readonly CapabilityCard[];
  recent?: readonly GroupMessage[];
  oneShot?: OneShot | null;
  budgetMs?: number;
  /** Test seam. */
  now?: () => number;
}

/**
 * Deterministic pre-router: when the message names a kind of work and exactly one member's card says they do it, that
 * member answers at once, with no model call. Ambiguity (no match, a tie, a message that spans two roles) returns null
 * and the model decides. Matching is on the card's own words (name, title, does, skills, apps, computer, good-at).
 */
const ROLE_RULES: ReadonlyArray<{ ask: RegExp; has: RegExp }> = [
  { ask: /\b(spreadsheets?|xlsx|excel|csv|formulas?|pivot|budget|forecast|financials?|statistics|numbers|totals?|data analysis)\b/i, has: /\b(analy\w*|spreadsheets?|excel|xlsx|finance|financial|data|numbers|budget\w*|accountant|statistic\w*)\b/i },
  { ask: /\b(research|links?|sources?|look up|find out|competitors?|market|compare|survey|investigate|articles?|papers?|news)\b/i, has: /\b(research\w*|investigat\w*|sources?|scout|fact.?check\w*)\b/i },
  { ask: /\b(write|draft|rewrite|proofread|edit my|essay|blog|newsletter|copy|caption|email|letter|post)\b/i, has: /\b(writ\w*|editor|copy\w*|content|author|drafts?|communications?)\b/i },
  { ask: /\b(docx|word doc(ument)?|pptx|slides?|deck|presentation|powerpoint|pdf|report)\b/i, has: /\b(docs?|documents?|slides?|presentations?|decks?|reports?|writ\w*)\b/i },
  { ask: /\b(code|bug|function|refactor|script|repo|compile|unit tests?|stack trace|typescript|python|javascript)\b/i, has: /\b(engineer\w*|develop\w*|coder|programm\w*|software|code|coding)\b/i },
  { ask: /\b(book|browse|website|web ?page|click|sign up|buy|order|tickets?|showtimes?|reserve)\b/i, has: /\b(web|browser|browse\w*|booking|shopper|errands?)\b/i },
];

export function keywordPick(i: Pick<RouteInput, 'members' | 'text' | 'cards'>): { id: string; role: string } | null {
  const cards = i.cards ?? [];
  if (!cards.length || i.members.length < 2) return null;
  const hits = ROLE_RULES.filter((r) => r.ask.test(i.text));
  if (!hits.length) return null;
  const score = new Map<string, number>();
  for (const m of i.members) {
    const c = cards.find((x) => x.blobId === m.id);
    if (!c) continue;
    const hay = [m.name, c.title, c.does, c.skills.join(' '), c.goodAt.join(' ')].join(' ');
    const n = hits.filter((r) => r.has.test(hay)).length;
    if (n > 0) score.set(m.id, n);
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  // a clear winner: strictly ahead of everyone else AND covering every role the message asked for (a spread is ambiguous)
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  if (ranked[0][1] < hits.length) return null;
  const who = i.members.find((m) => m.id === ranked[0][0]);
  return who ? { id: who.id, role: who.name } : null;
}

const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

export function pickPrompt(i: Pick<RouteInput, 'members' | 'text' | 'cards' | 'recent'>): string {
  const cards = (i.cards ?? []).length
    ? i.cards!.map((c) => renderCard(c)).join('\n\n')
    : i.members.map((m) => m.name).join('\n');
  const recent = (i.recent ?? []).filter((m) => m.kind === 'message').slice(-PICK_CONTEXT_MESSAGES)
    .map((m) => `${m.authorName}: ${clip(m.text, PICK_CLIP)}`).join('\n');
  return [
    'You route messages in a group chat of AI coworkers. Pick the ONE member best suited to answer the newest message.',
    'Reply with JSON only: {"pick":"<exact member name>"} or {"pick":"none"} when no member clearly fits or you are unsure.',
    '',
    'Members:', cards,
    ...(recent ? ['', 'Recent chat:', recent] : []),
    '', 'Newest message:', clip(i.text, 600),
  ].join('\n');
}

/** Read a picker's answer: JSON {"pick":..}, or a bare name. Returns a member id, `'none'` for doubt, or null if unreadable. */
export function readPick(raw: string, members: readonly MentionTarget[]): string | 'none' | null {
  let pick: string | null = null;
  const json = /\{[\s\S]*?\}/.exec(raw);
  if (json) { try { const j = JSON.parse(json[0]); if (typeof j?.pick === 'string') pick = j.pick; else if (typeof j?.member === 'string') pick = j.member; } catch { /* fall through */ } }
  if (pick == null) pick = raw.trim().split('\n')[0] ?? '';
  const norm = pick.replace(/^[@"'`\s]+|[@"'`.\s]+$/g, '').toLowerCase();
  if (!norm) return null;
  if (norm === 'none' || norm === 'unsure' || norm === 'unknown' || norm === 'null') return 'none';
  return members.find((m) => m.name.trim().toLowerCase() === norm)?.id ?? null;
}

export async function routeMessage(i: RouteInput): Promise<RouteDecision> {
  const mentions = parseMentions(i.text, i.members, { exclude: i.authorId });
  const memberIds = new Set(i.group.memberIds);
  // the lead is always one of the members; a stale lead (a retired blob) hands over to the first member, never to a stranger
  const lead = memberIds.has(i.group.leadId) ? i.group.leadId : (i.group.memberIds[0] ?? i.group.leadId);

  if (mentions.any) {
    const recipients = mentions.ids.filter((id) => memberIds.has(id));
    // a member who only @mentions themselves (or @all in a two-person group where the only other is gone) addresses nobody
    return { recipients, reason: mentions.all ? 'all' : 'mention' };
  }
  if (i.authorId !== 'user') return { recipients: [], reason: 'member-silent' };

  if (i.group.rule === 'mention') return { recipients: [], reason: 'no-mention' };
  if (i.group.rule === 'lead') return { recipients: [lead], reason: 'lead' };
  if (i.group.memberIds.length === 1) return { recipients: [i.group.memberIds[0]], reason: 'single' };

  // auto
  const fallback = (detail: string, pickMs?: number): RouteDecision => ({ recipients: [lead], reason: 'auto-fallback', detail, ...(pickMs != null ? { pickMs } : {}) });
  const quick = keywordPick(i);
  if (quick && i.group.memberIds.includes(quick.id)) return { recipients: [quick.id], reason: 'auto', detail: 'keyword', pickMs: 0 };
  if (!i.oneShot) return fallback('no-model');
  const now = i.now ?? Date.now;
  const budget = i.budgetMs ?? AUTO_PICK_BUDGET_MS;
  const t0 = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), budget); timer.unref?.(); });
  try {
    const answer = await Promise.race([i.oneShot(pickPrompt(i), { budgetMs: budget, json: true, fast: true }).catch(() => null), timeout]);
    const ms = now() - t0;
    if (answer === 'timeout') return fallback('timeout', ms);
    if (!answer || !answer.text) return fallback('no-model', ms);
    const pick = readPick(answer.text, i.members);
    if (pick === 'none') return fallback('doubt', ms);
    if (pick == null || !memberIds.has(pick)) return fallback('bad-answer', ms);
    return { recipients: [pick], reason: 'auto', pickMs: ms, model: answer.model };
  } finally { if (timer) clearTimeout(timer); }
}
