import * as Schema from "effect/Schema";
import { HostId, ItemId, WholeNumber, ThreadId } from "./primitives.ts";

export const REPLY_FOOTNOTE_MAX_TEXT_LENGTH = 8_000;
export const REPLY_FOOTNOTE_MAX_COMMENT_LENGTH = 8_000;
export const REPLY_FOOTNOTE_CONTEXT_LENGTH = 32;

/**
 * A quote of rendered assistant text with an optional user comment.
 * Positions are UTF-16 offsets, not Markdown offsets.
 */
export const ReplyFootnote = Schema.Struct({
  version: Schema.Literal(1),
  hostId: HostId.check(Schema.isMaxLength(512)),
  threadId: ThreadId.check(Schema.isMaxLength(512)),
  messageId: ItemId.check(Schema.isMaxLength(512)),
  text: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(REPLY_FOOTNOTE_MAX_TEXT_LENGTH),
  ),
  comment: Schema.optional(
    Schema.String.check(Schema.isMaxLength(REPLY_FOOTNOTE_MAX_COMMENT_LENGTH)),
  ),
  start: WholeNumber.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  end: WholeNumber.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  prefix: Schema.String.check(Schema.isMaxLength(REPLY_FOOTNOTE_CONTEXT_LENGTH)),
  suffix: Schema.String.check(Schema.isMaxLength(REPLY_FOOTNOTE_CONTEXT_LENGTH)),
}).check(
  Schema.makeFilter((citation) => citation.end > citation.start && citation.text.trim().length > 0),
);
export type ReplyFootnote = typeof ReplyFootnote.Type;
