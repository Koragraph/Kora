import * as Schema from "effect/Schema";

import { HostId, ItemId, ThreadId } from "./primitives.ts";
import { CONTEXT_CHIP_MAX_RECORDS, ContextChipRecord } from "./contextChip.ts";
import { LenientArray } from "./primitives.ts";

/**
 * Structured clipboard payload for context copied between drafts and messages. Carries the
 * records behind the copied links plus where they came from, never bytes or URLs; the receiver
 * resolves binaries through its own environment.
 */
export const CONTEXT_CHIP_CLIPBOARD_MIME = "web application/x-kora-context-fragment+json";

export const ContextChipClipboardFragment = Schema.Struct({
  version: Schema.Literal(1),
  source: Schema.Struct({
    hostId: HostId,
    threadId: Schema.optional(ThreadId),
    messageId: Schema.optional(ItemId),
  }),
  // The bound applies to the raw input, as in `ThreadMessageContext`: forward-compatible
  // decoding drops unknown records first, so a checked output length never sees the flood.
  records: Schema.Array(Schema.Unknown)
    .check(Schema.isMaxLength(CONTEXT_CHIP_MAX_RECORDS))
    .pipe(Schema.decodeTo(LenientArray(ContextChipRecord))),
});
export type ContextChipClipboardFragment = typeof ContextChipClipboardFragment.Type;
