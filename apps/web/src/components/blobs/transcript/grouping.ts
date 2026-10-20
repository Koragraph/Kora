// Bubble grouping for the Blobs transcript skin: which message rows belong to one "burst" from one author, so the
// transcript can draw the avatar once, tighten the spacing and join the bubble corners. Pure: it reads transcript rows
// and answers a position per message row id. Tool rows, thinking rows and meta rows never break a burst (they are
// tucked between bubbles); a card, a plan, a notice, a compaction or a queued message does.
import type { TranscriptRowEntry } from "../../thread/ThreadTranscript.logic";

export interface BubblePosition {
  readonly role: "user" | "assistant";
  readonly first: boolean;
  readonly last: boolean;
  /** True while any message of the burst is still streaming (drives the avatar's `talking` state). */
  readonly streaming: boolean;
}

export type BubbleGroups = ReadonlyMap<string, BubblePosition>;

/** Two messages further apart than this start a new burst even from the same author (iMessage-style). */
export const BUBBLE_GROUP_GAP_MS = 5 * 60_000;

interface OpenGroup {
  role: "user" | "assistant";
  ids: string[];
  streaming: boolean;
  lastAt: number;
}

const NEUTRAL_ROW_KINDS: ReadonlySet<TranscriptRowEntry["kind"]> = new Set([
  "assistant-meta",
  "work",
  "work-live",
  "work-toggle",
  "turn-fold",
  "working",
  "thinking",
]);

export function deriveBubbleGroups(rows: ReadonlyArray<TranscriptRowEntry>): BubbleGroups {
  const result = new Map<string, BubblePosition>();
  let open: OpenGroup | null = null;

  const close = () => {
    if (open === null) return;
    const { ids, role, streaming } = open;
    ids.forEach((id, index) => {
      result.set(id, { role, first: index === 0, last: index === ids.length - 1, streaming });
    });
    open = null;
  };

  for (const row of rows) {
    if (
      row.kind === "message" &&
      (row.message.role === "user" || row.message.role === "assistant")
    ) {
      const role = row.message.role;
      const at = Date.parse(row.message.createdAt);
      const gapped =
        open !== null &&
        Number.isFinite(at) &&
        Number.isFinite(open.lastAt) &&
        at - open.lastAt > BUBBLE_GROUP_GAP_MS;
      if (open === null || open.role !== role || gapped) {
        close();
        open = { role, ids: [], streaming: false, lastAt: at };
      }
      open.ids.push(row.id);
      open.streaming ||= Boolean(row.message.streaming);
      open.lastAt = Number.isFinite(at) ? at : open.lastAt;
      continue;
    }
    if (NEUTRAL_ROW_KINDS.has(row.kind)) continue;
    close();
  }
  close();
  return result;
}

/** Lets the transcript keep the previous map (and so its context value) while streaming text grows. */
export function sameBubbleGroups(a: BubbleGroups, b: BubbleGroups): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [id, position] of a) {
    const other = b.get(id);
    if (
      other === undefined ||
      other.role !== position.role ||
      other.first !== position.first ||
      other.last !== position.last ||
      other.streaming !== position.streaming
    ) {
      return false;
    }
  }
  return true;
}
