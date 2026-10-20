// Class decisions for the Blobs transcript skin, kept pure so they can be tested without rendering.
import type { TranscriptRowEntry } from "../../thread/ThreadTranscript.logic";
import type { BlobSkin } from "../chat/blobSkin";
import type { BubbleGroups, BubblePosition } from "./grouping";

/** Gutter the avatar sits in; tool rows and cards indent by gutter + gap so they line up with the bubbles. */
export const BLOB_GUTTER_PX = 28;
const BLOB_GUTTER_GAP_PX = 10;
export const BLOB_AVATAR_SIZE = 28;

/** Rows that belong to the blob (tool activity, cards): indented under its bubbles. */
const INDENTED_KINDS: ReadonlySet<TranscriptRowEntry["kind"]> = new Set([
  "work",
  "work-live",
  "work-toggle",
  "blob-card",
]);

/** The row wrapper's padding for the skin. Merged last (tailwind-merge) so it overrides the default `pb-*`. */
export function blobRowClassName(
  row: TranscriptRowEntry,
  skin: BlobSkin | null,
  groups: BubbleGroups | null,
): string | undefined {
  if (skin === null) return undefined;
  if (row.kind === "message") {
    const position = groups?.get(row.id);
    return position === undefined || position.last ? "pb-3" : "pb-0.5";
  }
  if (row.kind === "assistant-meta" || row.kind === "working" || row.kind === "thinking") {
    return "pb-3";
  }
  if (row.kind === "blob-card") return "pb-1 pl-[2.375rem]";
  if (INDENTED_KINDS.has(row.kind)) return "pl-[2.375rem]";
  return undefined;
}

/**
 * Corner shape for a bubble. The corner toward the author is always tight (the "tail", and the join to the next
 * bubble); the top corner on that side is tight too once the bubble continues a burst. Literal class names, so the
 * Tailwind scanner sees them.
 */
export function bubbleShapeClassName(
  side: "left" | "right",
  position: BubblePosition | undefined,
): string {
  const first = position?.first ?? true;
  if (side === "left") {
    return first ? "rounded-[1.25rem] rounded-bl-[0.4rem]" : "rounded-[1.25rem] rounded-l-[0.4rem]";
  }
  return first ? "rounded-[1.25rem] rounded-br-[0.4rem]" : "rounded-[1.25rem] rounded-r-[0.4rem]";
}
