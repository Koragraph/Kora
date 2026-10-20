/**
 * The transcript: messages, proposed plans and work rows in time order.
 *
 * Re-sorting everything on every streamed token is wasted work, so a projection carries what it was built from:
 * a text-only update of a streaming message is patched in place, and items only appended are merged into the
 * existing order. Anything else is sorted from scratch. All three paths give the same order: by time, and on a
 * tie messages before plans before work, earlier items before later ones.
 */
import { shallow } from "zustand/vanilla/shallow";

import type { ChatMessage, PlanProposal } from "../../types";
import type { WorkLogEntry } from "./entries";

export type TranscriptItem =
  | { kind: "message"; id: string; createdAt: string; message: ChatMessage }
  | { kind: "proposed-plan"; id: string; createdAt: string; proposedPlan: PlanProposal }
  | { kind: "work"; id: string; createdAt: string; entry: WorkLogEntry };

export interface TranscriptEntriesProjection {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly proposedPlans: ReadonlyArray<PlanProposal>;
  readonly workEntries: ReadonlyArray<WorkLogEntry>;
  readonly entries: TranscriptItem[];
}

const asItem = {
  message: (message: ChatMessage): TranscriptItem => ({
    id: message.id,
    createdAt: message.createdAt,
    kind: "message",
    message,
  }),
  plan: (proposedPlan: PlanProposal): TranscriptItem => ({
    kind: "proposed-plan",
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }),
  work: (entry: WorkLogEntry): TranscriptItem => ({
    kind: "work",
    id: entry.id,
    createdAt: entry.createdAt,
    entry,
  }),
};

const SOURCE_RANK: Record<TranscriptItem["kind"], number> = {
  message: 0,
  "proposed-plan": 1,
  work: 2,
};
const byTime = (a: TranscriptItem, b: TranscriptItem) => a.createdAt.localeCompare(b.createdAt);
/** `a` (already placed) goes before `b` (new): earlier, or same time and not of a later source. */
const goesFirst = (a: TranscriptItem, b: TranscriptItem) => {
  const t = byTime(a, b);
  return t === 0 ? SOURCE_RANK[a.kind] <= SOURCE_RANK[b.kind] : t < 0;
};

/** `next` starts with exactly the items of `previous` (same objects, same order). */
function extends_<T>(previous: ReadonlyArray<T>, next: ReadonlyArray<T>): boolean {
  return (
    previous === next ||
    (next.length >= previous.length && previous.every((item, i) => item === next[i]))
  );
}

/** Merges new items (sorted among themselves) into an ordered list. */
function mergeIn(
  placed: ReadonlyArray<TranscriptItem>,
  added: ReadonlyArray<TranscriptItem>,
): TranscriptItem[] {
  const last = placed.at(-1);
  const addedInOrder = added.every((item, i) => i === 0 || byTime(added[i - 1]!, item) <= 0);
  if (added.length === 0 || (addedInOrder && (!last || goesFirst(last, added[0]!))))
    return [...placed, ...added];
  const out: TranscriptItem[] = [];
  let [i, j] = [0, 0];
  while (i < placed.length || j < added.length) {
    const take = j >= added.length || (i < placed.length && goesFirst(placed[i]!, added[j]!));
    out.push(take ? placed[i++]! : added[j++]!);
  }
  return out;
}

/** A message without what changes while it streams (its text and when that last changed). */
const withoutStreamedText = ({ text: _text, updatedAt: _at, ...rest }: ChatMessage) => rest;
const isStreamingReply = (m: ChatMessage) => m.role === "assistant" && m.streaming;

/** Only the text (and its timestamp) of a streaming assistant message changed: the transcript's shape did not. */
export const isStreamingMessageTextUpdate = (previous: ChatMessage, next: ChatMessage): boolean =>
  isStreamingReply(previous) &&
  isStreamingReply(next) &&
  shallow(withoutStreamedText(previous), withoutStreamedText(next));

/** The previous items with streamed messages swapped for their newer versions, or null if more than text changed. */
function patchStreaming(
  messages: ReadonlyArray<ChatMessage>,
  previous: TranscriptEntriesProjection,
): TranscriptItem[] | null {
  if (messages.length !== previous.messages.length) return null;
  const changed = new Map<ChatMessage, ChatMessage>();
  messages.forEach((now, i) => {
    const before = previous.messages[i]!;
    if (now !== before) changed.set(before, now);
  });
  for (const [before, now] of changed) if (!isStreamingMessageTextUpdate(before, now)) return null;
  if (changed.size === 0) return previous.entries;
  return previous.entries.map((item) =>
    item.kind === "message" && changed.has(item.message)
      ? asItem.message(changed.get(item.message)!)
      : item,
  );
}

export function deriveTranscriptEntriesWithState(
  messages: ReadonlyArray<ChatMessage>,
  proposedPlans: ReadonlyArray<PlanProposal>,
  workEntries: ReadonlyArray<WorkLogEntry>,
  previous: TranscriptEntriesProjection | null = null,
): TranscriptEntriesProjection {
  const result = (entries: TranscriptItem[]) => ({ messages, proposedPlans, workEntries, entries });

  // Only streamed text changed.
  const unchanged = <T>(before: ReadonlyArray<T>, now: ReadonlyArray<T>) =>
    before.length === now.length && extends_(before, now);
  const patched =
    previous &&
    unchanged(previous.proposedPlans, proposedPlans) &&
    unchanged(previous.workEntries, workEntries)
      ? patchStreaming(messages, previous)
      : null;
  if (patched) return result(patched);

  // A user message that only carried an answer to a question shows inside that question's row instead.
  const answeredInRow = new Set(
    workEntries.flatMap((e) =>
      e.questionAnswer ? [`async-answer:${e.questionAnswer.requestId}`] : [],
    ),
  );
  const shown = (m: ChatMessage) => m.role !== "user" || !answeredInRow.has(m.id);
  const items = (from: { messages: number; plans: number; work: number }) =>
    [
      ...messages.slice(from.messages).filter(shown).map(asItem.message),
      ...proposedPlans.slice(from.plans).map(asItem.plan),
      ...workEntries.slice(from.work).map(asItem.work),
    ].toSorted(byTime);

  // Only appended (and nothing already shown is now hidden).
  const appendOnly =
    previous !== null &&
    previous.entries.every((item) => item.kind !== "message" || shown(item.message)) &&
    extends_(previous.messages, messages) &&
    extends_(previous.proposedPlans, proposedPlans) &&
    extends_(previous.workEntries, workEntries);
  if (appendOnly) {
    const added = items({
      messages: previous.messages.length,
      plans: previous.proposedPlans.length,
      work: previous.workEntries.length,
    });
    return result(mergeIn(previous.entries, added));
  }
  return result(items({ messages: 0, plans: 0, work: 0 }));
}

export const deriveTranscriptEntries = (
  messages: ReadonlyArray<ChatMessage>,
  proposedPlans: ReadonlyArray<PlanProposal>,
  workEntries: ReadonlyArray<WorkLogEntry>,
): TranscriptItem[] =>
  deriveTranscriptEntriesWithState(messages, proposedPlans, workEntries).entries;
