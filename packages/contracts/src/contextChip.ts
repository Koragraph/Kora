import * as Schema from "effect/Schema";

import { LenientArray, NonblankString, WholeNumber } from "./primitives.ts";

export const CONTEXT_CHIP_KINDS = [
  "terminal",
  "element",
  "preview-annotation",
  "review-comment",
  "mention",
  "skill",
] as const;
export type KnownContextChipKind = (typeof CONTEXT_CHIP_KINDS)[number];

export const CONTEXT_CHIP_LABEL_MAX_CHARS = 200;
export const CONTEXT_CHIP_REVIEW_TEXT_MAX_CHARS = 16_000;
/** Exported so producers clamp to exactly what the schema accepts. */
export const CONTEXT_CHIP_REVIEW_DIFF_MAX_CHARS = 32_000;
export const CONTEXT_CHIP_MAX_RECORDS = 200;

const ID_MAX_CHARS = 128;
const TERMINAL_TEXT_MAX_CHARS = 64_000;
const HTML_PREVIEW_MAX_CHARS = 8_000;
const STYLES_MAX_CHARS = 8_000;
const ANNOTATION_COMMENT_MAX_CHARS = 8_000;
const ALL_RECORDS_MAX_CHARS = 16_000_000;
const UNKNOWN_PAYLOAD_MAX_CHARS = 64_000;

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Short = bounded(2048);
const NullableShort = Schema.NullOr(Short);
const idPattern = Schema.isPattern(/^[a-z0-9_-]+$/i);

/** Durable identity of one payload; every chip that refers to it shares the id. */
export const ContextChipId = NonblankString.check(Schema.isMaxLength(ID_MAX_CHARS), idPattern).pipe(
  Schema.brand("ContextChipId"),
);
export type ContextChipId = typeof ContextChipId.Type;

/** Identity of one occurrence in a document (differs when a chip is duplicated). */
export const ContextChipReferenceId = NonblankString.check(
  Schema.isMaxLength(ID_MAX_CHARS),
  idPattern,
).pipe(Schema.brand("ContextChipReferenceId"));
export type ContextChipReferenceId = typeof ContextChipReferenceId.Type;

/** Open set: kinds this build does not know are still well-formed. */
export const ContextTagKind = NonblankString.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,39}$/));
export type ContextTagKind = typeof ContextTagKind.Type;

const baseFields = {
  version: Schema.Literal(1),
  contextId: ContextChipId,
  label: bounded(CONTEXT_CHIP_LABEL_MAX_CHARS),
};

/** A record of one known kind: the shared head, the `kind` literal, then the kind's fields. */
const chipRecord = <const Kind extends string, const Fields extends Schema.Struct.Fields>(
  kind: Kind,
  fields: Fields,
) => Schema.Struct({ ...baseFields, kind: Schema.Literal(kind), ...fields });

/** `high` must not come before `low` (a line range, a diff index range). */
const notBefore = <const Low extends string, const High extends string>(low: Low, high: High) =>
  Schema.makeFilter((record: Record<Low | High, number>) => record[high] >= record[low]);

const atMost = <S extends Schema.Top>(item: S, max: number) =>
  Schema.Array(item).check(Schema.isMaxLength(max));

export const PtyContextRecord = chipRecord("terminal", {
  terminalId: NonblankString.check(Schema.isMaxLength(255)),
  terminalLabel: NonblankString.check(Schema.isMaxLength(255)),
  lineStart: WholeNumber,
  lineEnd: WholeNumber,
  text: bounded(TERMINAL_TEXT_MAX_CHARS),
}).check(notBefore("lineStart", "lineEnd"));
export type PtyContextRecord = typeof PtyContextRecord.Type;

export const ElementContextSource = Schema.Struct({
  fileName: NullableShort,
  functionName: NullableShort,
  lineNumber: Schema.NullOr(WholeNumber),
  columnNumber: Schema.NullOr(WholeNumber),
});
export type ElementContextSource = typeof ElementContextSource.Type;

const pickedNodeFields = {
  pageUrl: Short,
  pageTitle: NullableShort,
  tagName: NonblankString.check(Schema.isMaxLength(255)),
  selector: NullableShort,
  htmlPreview: bounded(HTML_PREVIEW_MAX_CHARS),
  componentName: NullableShort,
  source: Schema.NullOr(ElementContextSource),
  styles: bounded(STYLES_MAX_CHARS),
};

export const PickedNodeDetails = Schema.Struct(pickedNodeFields);
export type PickedNodeDetails = typeof PickedNodeDetails.Type;

export const ElementContextRecord = chipRecord("element", {
  ...pickedNodeFields,
});
export type ElementContextRecord = typeof ElementContextRecord.Type;

/** One edited CSS property, before and after. */
const StyleChangeDetail = Schema.Struct({
  targetId: Short,
  selector: NullableShort,
  property: Short,
  previousValue: bounded(8_000),
  value: bounded(8_000),
});

export const WebMarkupContextRecord = chipRecord("preview-annotation", {
  annotationId: Short,
  pageUrl: Short,
  pageTitle: NullableShort,
  comment: bounded(ANNOTATION_COMMENT_MAX_CHARS),
  targetSummary: Short,
  styleChanges: atMost(Short, 200),
  elements: Schema.optional(atMost(PickedNodeDetails, 50)),
  elementIds: Schema.optionalKey(atMost(Short, 50)),
  // Geometry is dropped on purpose; only the counts survive, for the target summary.
  regionCount: Schema.optionalKey(WholeNumber),
  strokeCount: Schema.optionalKey(WholeNumber),
  styleChangeDetails: Schema.optionalKey(atMost(StyleChangeDetail, 200)),
});
export type WebMarkupContextRecord = typeof WebMarkupContextRecord.Type;

export const ReviewCommentChipRecord = chipRecord("review-comment", {
  sectionId: NonblankString.check(Schema.isMaxLength(255)),
  sectionTitle: Short,
  filePath: NonblankString.check(Schema.isMaxLength(2048)),
  startIndex: WholeNumber,
  endIndex: WholeNumber,
  rangeLabel: Short,
  text: bounded(CONTEXT_CHIP_REVIEW_TEXT_MAX_CHARS),
  diff: bounded(CONTEXT_CHIP_REVIEW_DIFF_MAX_CHARS),
  fenceLanguage: Schema.optionalKey(bounded(64)),
}).check(notBefore("startIndex", "endIndex"));
export type ReviewCommentChipRecord = typeof ReviewCommentChipRecord.Type;

export const MentionContextRecord = chipRecord("mention", {
  path: NonblankString.check(Schema.isMaxLength(2048)),
});
export type MentionContextRecord = typeof MentionContextRecord.Type;

export const SkillContextRecord = chipRecord("skill", {
  name: NonblankString.check(Schema.isMaxLength(255)),
});
export type SkillContextRecord = typeof SkillContextRecord.Type;

// A kind that merely looks unknown must not be one of the known ones: otherwise a
// malformed known record would pass as "unknown" instead of failing its own schema.
const notAKnownKind = Schema.isPattern(new RegExp(`^(?!(?:${CONTEXT_CHIP_KINDS.join("|")})$)`));

const payloadFits = (payload: unknown): boolean => {
  try {
    const json = JSON.stringify(payload);
    return json !== undefined && json.length <= UNKNOWN_PAYLOAD_MAX_CHARS;
  } catch {
    return false;
  }
};

export const UnknownContextRecord = Schema.Struct({
  ...baseFields,
  kind: ContextTagKind.check(notAKnownKind),
  payload: Schema.Unknown,
}).check(Schema.makeFilter((record) => payloadFits(record.payload)));
export type UnknownContextRecord = typeof UnknownContextRecord.Type;

export const KnownContextChipRecord = Schema.Union([
  PtyContextRecord,
  ElementContextRecord,
  WebMarkupContextRecord,
  ReviewCommentChipRecord,
  MentionContextRecord,
  SkillContextRecord,
]);
export type KnownContextChipRecord = typeof KnownContextChipRecord.Type;

export const ContextChipRecord = Schema.Union([
  PtyContextRecord,
  ElementContextRecord,
  WebMarkupContextRecord,
  ReviewCommentChipRecord,
  MentionContextRecord,
  SkillContextRecord,
  UnknownContextRecord,
]);
export type ContextChipRecord = typeof ContextChipRecord.Type;

const rawRecordsFitSize = (records: ReadonlyArray<unknown>): boolean => {
  try {
    return JSON.stringify(records).length <= ALL_RECORDS_MAX_CHARS;
  } catch {
    return false;
  }
};

export const ThreadMessageContext = Schema.Struct({
  version: Schema.Literal(1),
  // Limits apply to the raw input; the lenient decode below then drops records this
  // build cannot read instead of failing the message.
  records: Schema.Array(Schema.Unknown)
    .check(Schema.isMaxLength(CONTEXT_CHIP_MAX_RECORDS), Schema.makeFilter(rawRecordsFitSize))
    .pipe(
      Schema.decodeTo(
        LenientArray(ContextChipRecord).check(
          Schema.makeFilter(
            (records: ReadonlyArray<ContextChipRecord>) =>
              new Set(records.map((record) => record.contextId)).size === records.length,
          ),
        ),
      ),
    ),
});
export type ThreadMessageContext = typeof ThreadMessageContext.Type;
