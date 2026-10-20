import {
  collectContextChipReferences,
  sanitizeContextChipLabel,
} from "@kora/shared/contextChipReferences";
import { upgradeLegacyContextMessage } from "@kora/shared/contextChipLegacy";
import { encodeContextChipFragment } from "@kora/shared/contextChipClipboard";
import {
  type WebMarkupPayload,
  type WebMarkupContextRecord,
  type ThreadMessageContext,
  type ThreadId,
  type ReviewCommentChipRecord,
  type PtyContextRecord,
  type KnownContextChipRecord,
  type ItemId,
  type HostId,
  type ContextChipRecord,
  type ContextChipId,
  CONTEXT_CHIP_REVIEW_TEXT_MAX_CHARS,
  CONTEXT_CHIP_REVIEW_DIFF_MAX_CHARS,
} from "@kora/contracts";

import {
  type TerminalExcerptDraft,
  normalizeTerminalExcerptText,
  formatTerminalExcerptLabel,
} from "./terminalContext";
import { normalizeElementContextSelection } from "./elementContext";
import {
  type ContextChipReference,
  toKindScopedContextChipId,
  producerIdFromContextChipId,
} from "./contextChipReferences";
import type { ReviewCommentContext } from "../thread/reviewCommentContext";

const TRUNCATION_MARKER = "\n… truncated …";
const WEB_MARKUP_LABEL_MAX = 48;
const UNSET = "(unset)";
const STYLE_CHANGE_LINE = /^(.*?): (.*) → (.*)$/s;

// ---------- labels ----------

function rangeLabelForDisplay(rangeLabel: string): string {
  const diffForm = /^([+-])(\d+)(?: to \1(\d+))?$/.exec(rangeLabel);
  if (!diffForm) return rangeLabel;
  const [, sign, from, to] = diffForm;
  const span = to === undefined ? `L${from}` : `L${from} to L${to}`;
  return sign === "-" ? `${span} (before)` : span;
}

export function reviewCommentContextLabel(
  remark: ReviewCommentContext | ReviewCommentChipRecord,
): string {
  const fileRef = remark.filePath.split(/[\\/]/).pop() ?? remark.filePath;
  return `${fileRef} ${rangeLabelForDisplay(remark.rangeLabel)}`;
}

export function webMarkupContextLabel(markup: WebMarkupPayload): string {
  const remark = markup.comment.replace(/\s+/g, " ").trim();
  if (remark) {
    return remark.length > WEB_MARKUP_LABEL_MAX
      ? `${remark.slice(0, WEB_MARKUP_LABEL_MAX - 1)}…`
      : remark;
  }
  return markup.pageTitle?.trim() || "Preview annotation";
}

// ---------- ids and references ----------

export function terminalExcerptReference(excerpt: TerminalExcerptDraft): ContextChipReference {
  return {
    kind: "terminal" as ContextChipReference["kind"],
    contextId: toKindScopedContextChipId("terminal" as never, excerpt.id),
    label: formatTerminalExcerptLabel(excerpt),
  };
}

export const reviewCommentContextId = (commentId: string): ContextChipId =>
  toKindScopedContextChipId("review-comment" as never, commentId);

// The screenshot attachment reuses the annotation id; the chip id must stay distinct from it.
export const webMarkupContextId = (annotationId: string): ContextChipId =>
  toKindScopedContextChipId("preview-annotation" as never, annotationId);

export function reviewCommentContextReference(remark: ReviewCommentContext): ContextChipReference {
  return {
    kind: "review-comment" as ContextChipReference["kind"],
    contextId: reviewCommentContextId(remark.id),
    label: reviewCommentContextLabel(remark),
  };
}

export function webMarkupContextReference(markup: WebMarkupPayload): ContextChipReference {
  return {
    kind: "preview-annotation" as ContextChipReference["kind"],
    contextId: webMarkupContextId(markup.id),
    label: webMarkupContextLabel(markup),
  };
}

// ---------- drafts -> records ----------

function clampWithMarker(val: string, max: number): string {
  if (val.length <= max) return val;
  return val.slice(0, Math.max(0, max - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
}

export function terminalExcerptRecord(excerpt: TerminalExcerptDraft): PtyContextRecord {
  const reference = terminalExcerptReference(excerpt);
  return {
    version: 1,
    contextId: reference.contextId as ContextChipId,
    kind: "terminal",
    label: sanitizeContextChipLabel(reference.label, "terminal" as never),
    terminalId: excerpt.terminalId,
    terminalLabel: excerpt.terminalLabel,
    lineStart: excerpt.lineStart,
    lineEnd: excerpt.lineEnd,
    text: normalizeTerminalExcerptText(excerpt.text),
  };
}

export function reviewCommentContextRecord(remark: ReviewCommentContext): ReviewCommentChipRecord {
  return {
    version: 1,
    contextId: reviewCommentContextId(remark.id),
    kind: "review-comment",
    label: reviewCommentContextLabel(remark),
    sectionId: remark.sectionId,
    sectionTitle: remark.sectionTitle,
    filePath: remark.filePath,
    startIndex: remark.startIndex,
    endIndex: remark.endIndex,
    rangeLabel: remark.rangeLabel,
    // Oversized selections are clamped so the record still passes the wire bounds.
    text: clampWithMarker(remark.text, CONTEXT_CHIP_REVIEW_TEXT_MAX_CHARS),
    diff: clampWithMarker(remark.diff, CONTEXT_CHIP_REVIEW_DIFF_MAX_CHARS),
    ...(remark.fenceLanguage !== undefined ? { fenceLanguage: remark.fenceLanguage } : {}),
  };
}

function targetSummary(markup: WebMarkupPayload): string {
  const fragment = (n: number, noun: string) =>
    n > 0 ? `${n} ${noun}${n === 1 ? "" : "s"}` : null;
  return [
    fragment(markup.elements.length, "selected element"),
    fragment(markup.regions.length, "marked region"),
    fragment(markup.strokes.length, "drawing"),
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}

export function webMarkupContextRecord(markup: WebMarkupPayload): WebMarkupContextRecord {
  const elements: Array<NonNullable<WebMarkupContextRecord["elements"]>[number]> = [];
  const elementIds: string[] = [];
  for (const dest of markup.elements) {
    const element = normalizeElementContextSelection(dest.element);
    if (!element) continue;
    elements.push(element);
    elementIds.push(dest.id);
  }
  return {
    version: 1,
    contextId: webMarkupContextId(markup.id),
    kind: "preview-annotation",
    label: sanitizeContextChipLabel(webMarkupContextLabel(markup), "preview-annotation" as never),
    annotationId: markup.id,
    pageUrl: markup.pageUrl,
    pageTitle: markup.pageTitle,
    comment: markup.comment.trim(),
    targetSummary: targetSummary(markup),
    styleChanges: markup.styleChanges.map(
      (ch) => `${ch.property}: ${ch.previousValue || UNSET} → ${ch.value}`,
    ),
    ...(elements.length > 0 ? { elements, elementIds } : {}),
    styleChangeDetails: markup.styleChanges.map((ch) => ({ ...ch })),
    ...(markup.regions.length > 0 ? { regionCount: markup.regions.length } : {}),
    ...(markup.strokes.length > 0 ? { strokeCount: markup.strokes.length } : {}),
  };
}

export function buildMessageContext(args: {
  terminalContexts: ReadonlyArray<TerminalExcerptDraft>;
  reviewComments: ReadonlyArray<ReviewCommentContext>;
  previewAnnotations: ReadonlyArray<WebMarkupPayload>;
}): ThreadMessageContext | undefined {
  const records: ContextChipRecord[] = [
    ...args.terminalContexts.map(terminalExcerptRecord),
    ...args.reviewComments.map(reviewCommentContextRecord),
    ...args.previewAnnotations.map(webMarkupContextRecord),
  ];
  return records.length === 0 ? undefined : { version: 1, records };
}

// ---------- record inspection ----------

export function asKnownContextRecord(
  chipRecord: ContextChipRecord | undefined,
): KnownContextChipRecord | undefined {
  if (chipRecord === undefined || "payload" in chipRecord) return undefined;
  return chipRecord as KnownContextChipRecord;
}

export function contextChipImportLookupIds(
  chipRecord: KnownContextChipRecord,
): ReadonlyArray<ContextChipId> {
  const destination = toKindScopedContextChipId(
    chipRecord.kind,
    producerIdFromContextChipId(chipRecord.kind, chipRecord.contextId),
  );
  return destination === chipRecord.contextId
    ? [chipRecord.contextId]
    : [destination, chipRecord.contextId];
}

export function selectedMessageContextFragment(args: {
  markdown: string;
  records: ReadonlyArray<ContextChipRecord>;
  hostId: HostId;
  threadId?: ThreadId;
  messageId: ItemId;
}): string | null {
  const referenced = new Set(
    collectContextChipReferences(args.markdown).map((obj) => obj.contextId),
  );
  const records = args.records.filter((res) => referenced.has(res.contextId));
  if (records.length === 0) return null;
  return encodeContextChipFragment({
    version: 1,
    source: {
      hostId: args.hostId,
      ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
      messageId: args.messageId,
    },
    records,
  });
}

export interface ResolvedUserMessageContext {
  text: string;
  records: ReadonlyArray<ContextChipRecord>;
  recordsById: ReadonlyMap<string, ContextChipRecord>;
}

export function resolveUserMessageContext(msg: {
  text: string;
  context?: ThreadMessageContext | undefined;
}): ResolvedUserMessageContext {
  const settled = msg.context
    ? { text: msg.text, records: msg.context.records }
    : upgradeLegacyContextMessage(msg.text);
  return {
    text: settled.text,
    records: settled.records,
    recordsById: new Map(settled.records.map((res) => [res.contextId as string, res])),
  };
}

// ---------- records -> drafts ----------

export function terminalExcerptDraftFromRecord(
  ptyRecord: PtyContextRecord,
  threadKey: ThreadId,
): TerminalExcerptDraft {
  return {
    id: producerIdFromContextChipId("terminal" as never, ptyRecord.contextId),
    threadId: threadKey,
    createdAt: new Date().toISOString(),
    terminalId: ptyRecord.terminalId,
    terminalLabel: ptyRecord.terminalLabel,
    lineStart: ptyRecord.lineStart,
    lineEnd: ptyRecord.lineEnd,
    text: ptyRecord.text,
  };
}

export function reviewCommentFromRecord(
  reviewRecord: ReviewCommentChipRecord,
): ReviewCommentContext {
  return {
    id: producerIdFromContextChipId("review-comment" as never, reviewRecord.contextId),
    sectionId: reviewRecord.sectionId,
    sectionTitle: reviewRecord.sectionTitle,
    filePath: reviewRecord.filePath,
    startIndex: reviewRecord.startIndex,
    endIndex: reviewRecord.endIndex,
    rangeLabel: reviewRecord.rangeLabel,
    text: reviewRecord.text,
    diff: reviewRecord.diff,
    ...(reviewRecord.fenceLanguage !== undefined
      ? { fenceLanguage: reviewRecord.fenceLanguage }
      : {}),
  };
}

const ZERO_RECT = { x: 0, y: 0, width: 0, height: 0 } as const;

/** Lossy by design: geometry and the screenshot never travel, so placeholders stand in. */
export function webMarkupFromRecord(markupRecord: WebMarkupContextRecord): WebMarkupPayload {
  const clock = new Date().toISOString();
  const annotationId =
    markupRecord.annotationId ||
    producerIdFromContextChipId("preview-annotation" as never, markupRecord.contextId);

  const elements = (markupRecord.elements ?? []).map((elem, idx) => ({
    id: markupRecord.elementIds?.[idx] ?? `${markupRecord.contextId}-element-${idx + 1}`,
    rect: { ...ZERO_RECT },
    element: { ...elem, stack: [], pickedAt: clock },
  }));
  const regions = Array.from({ length: markupRecord.regionCount ?? 0 }, (_, idx) => ({
    id: `${markupRecord.contextId}-region-${idx + 1}`,
    rect: { ...ZERO_RECT },
  }));
  const strokes = Array.from({ length: markupRecord.strokeCount ?? 0 }, (_, idx) => ({
    id: `${markupRecord.contextId}-stroke-${idx + 1}`,
    color: "",
    width: 0,
    points: [],
    bounds: { ...ZERO_RECT },
  }));

  const fallbackTarget = elements[0]?.id ?? `${markupRecord.contextId}-element-1`;
  const styleChanges =
    markupRecord.styleChangeDetails?.map((ch) => ({ ...ch })) ??
    markupRecord.styleChanges.flatMap((ln) => {
      const matched = STYLE_CHANGE_LINE.exec(ln);
      if (!matched) return [];
      const [, property, previous, value] = matched;
      return [
        {
          targetId: fallbackTarget,
          selector: null,
          property: property!,
          previousValue: previous === UNSET ? "" : previous!,
          value: value!,
        },
      ];
    });

  return {
    id: annotationId,
    pageUrl: markupRecord.pageUrl,
    pageTitle: markupRecord.pageTitle,
    comment: markupRecord.comment,
    elements,
    regions,
    strokes,
    styleChanges,
    screenshot: null,
    createdAt: clock,
  };
}

// ---------- comparison ----------

function canonicalJson(val: unknown): string {
  const sorted = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sorted);
    if (typeof node === "object" && node !== null) {
      return Object.fromEntries(
        Object.entries(node)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, inner]) => [k, sorted(inner)]),
      );
    }
    return node;
  };
  return JSON.stringify(sorted(val));
}

/** Labels are display text and context ids are folded producer ids: neither is identity. */
export function isSameContextChipPayload(
  leftSide: ContextChipRecord,
  rightSide: ContextChipRecord,
): boolean {
  if (leftSide.kind !== rightSide.kind) return false;
  const strip = ({ label: _label, contextId: _id, ...rest }: ContextChipRecord) => rest;
  return canonicalJson(strip(leftSide)) === canonicalJson(strip(rightSide));
}
