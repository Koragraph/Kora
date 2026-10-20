import {
  type WebMarkupContextRecord,
  type PtyContextRecord,
  type ElementContextRecord,
  type ContextChipRecord as ContextChipRecordType,
  type ContextChipId,
  ReviewCommentChipRecord,
  ContextChipRecord,
  CONTEXT_CHIP_MAX_RECORDS,
} from "@kora/contracts";
import * as Schema from "effect/Schema";

import { formatContextChipReference } from "./contextChipReferences.ts";

// Messages written before inline context references carried their context as trailing XML-ish
// blocks. This reads them back into chip records. Stored history is never rewritten; the
// conversion is all-or-nothing, so a half-understood message is shown exactly as it was written.

export interface UpgradedLegacyContext {
  text: string;
  records: ContextChipRecordType[];
}

const isRecordList = Schema.is(
  Schema.Array(ContextChipRecord).check(Schema.isMaxLength(CONTEXT_CHIP_MAX_RECORDS)),
);
const isReviewRecord = Schema.is(ReviewCommentChipRecord);

const MAYBE_LEGACY = /<(?:terminal_context|element_context|preview_annotation|review_comment)\b|￼/;

const BLOCK_TAGS = ["terminal_context", "element_context", "preview_annotation"] as const;
type BlockTag = (typeof BLOCK_TAGS)[number];

/** Raised for any block this reader cannot account for; the whole conversion is then abandoned. */
class Unreadable extends Error {}
const fail = (): never => {
  throw new Unreadable();
};

const idOf = (kind: string, n: number) => `legacy_${kind}_${n}` as ContextChipId;
const lineRange = (text: string): string[] => text.split("\n");
const trimTrailingBlank = (lines: string[]): string[] => {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  return lines.slice(0, end);
};

// ---- Review blocks ---------------------------------------------------------------------------

const REVIEW_CLOSE = "</review_comment>";

const unescapeAttribute = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Index of the closing tag that sits outside any code fence, or -1. */
function findReviewClose(text: string, from: number): number {
  let pos = from;
  let fence = 0;
  let firstLine = true;
  for (;;) {
    const lineEnd = text.indexOf("\n", pos);
    const end = lineEnd < 0 ? text.length : lineEnd;
    const line = text.slice(pos, end);
    if (fence > 0) {
      const closing = /^(`{3,})\s*$/.exec(line);
      if (closing && closing[1]!.length >= fence) fence = 0;
    } else if (!firstLine && /^`{3,}/.test(line)) {
      fence = /^`+/.exec(line)![0].length;
    } else {
      const at = line.indexOf(REVIEW_CLOSE);
      if (at >= 0) return pos + at;
    }
    firstLine = false;
    if (lineEnd < 0) return -1;
    pos = lineEnd + 1;
  }
}

interface ReviewParts {
  readonly comment: string;
  readonly diff: string;
  readonly language: string;
}

function splitReviewBody(body: string): ReviewParts {
  const lines = lineRange(body);
  let last: { start: number; end: number; language: string } | null = null;
  let open: { start: number; fence: number; language: string } | null = null;
  lines.forEach((line, index) => {
    if (open === null) {
      const opening = index > 0 ? /^(`{3,})\s*(\S*)/.exec(line) : null;
      if (opening) open = { start: index, fence: opening[1]!.length, language: opening[2] ?? "" };
    } else {
      const closing = /^(`{3,})\s*$/.exec(line);
      if (closing && closing[1]!.length >= open.fence) {
        last = { start: open.start, end: index, language: open.language };
        open = null;
      }
    }
  });
  if (last === null) return { comment: body.trim(), diff: "", language: "diff" };
  const block = last as { start: number; end: number; language: string };
  return {
    comment: lines.slice(0, block.start).join("\n").trim(),
    diff: lines.slice(block.start + 1, block.end).join("\n"),
    language: block.language || "diff",
  };
}

function readReview(attributes: string, body: string, n: number): ContextChipRecordType | null {
  const attr: Record<string, string> = {};
  for (const match of attributes.matchAll(/([A-Za-z]+)="([^"]*)"/g)) {
    attr[match[1]!] = unescapeAttribute(match[2]!);
  }
  const filePath = attr.filePath?.trim() ?? "";
  const sectionId = attr.sectionId?.trim() ?? "";
  if (filePath === "" || sectionId === "") return null;
  if (!/^\d+$/.test(attr.startIndex ?? "") || !/^\d+$/.test(attr.endIndex ?? "")) return null;
  const first = Number(attr.startIndex);
  const second = Number(attr.endIndex);
  const parts = splitReviewBody(body);
  const rangeLabel = attr.rangeLabel || "line";
  const record = {
    version: 1,
    contextId: idOf("review-comment", n),
    kind: "review-comment",
    label: `${filePath.slice(filePath.lastIndexOf("/") + 1)} ${rangeLabel}`,
    sectionId,
    sectionTitle: attr.sectionTitle || "Review",
    filePath,
    startIndex: Math.min(first, second),
    endIndex: Math.max(first, second),
    rangeLabel,
    text: parts.comment,
    diff: parts.diff,
    fenceLanguage: parts.language,
  } as const;
  return isReviewRecord(record) ? (record as ContextChipRecordType) : null;
}

/** Line ranges of the context blocks whose contents must not be searched for reviews. */
function protectedRanges(text: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  const lines = lineRange(text);
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  for (let i = 0; i < lines.length; i += 1) {
    const tag = BLOCK_TAGS.find((candidate) => lines[i] === `<${candidate}>`);
    if (tag === undefined) continue;
    const close = lines.findIndex((line, j) => j > i && line === `</${tag}>`);
    if (close < 0) continue;
    ranges.push([starts[i]!, starts[close]! + lines[close]!.length]);
    i = close;
  }
  return ranges;
}

// ---- Entry blocks (terminal / element) -------------------------------------------------------

interface Entry {
  readonly header: string;
  readonly body: string[];
}

/** `- <header>:` lines start entries; two-space-indented lines are their bodies. */
function readEntries(lines: readonly string[]): Entry[] {
  const entries: Array<{ header: string; body: string[] }> = [];
  for (const line of lines) {
    const header = /^- (.*):$/.exec(line);
    if (header) {
      entries.push({ header: header[1]!, body: [] });
    } else if (line.startsWith("  ") && entries.length > 0) {
      entries[entries.length - 1]!.body.push(line.slice(2));
    } else if (line.trim() === "" && entries.length > 0) {
      entries[entries.length - 1]!.body.push("");
    } else if (line.trim() !== "") {
      fail();
    }
  }
  return entries.map((entry) => ({ header: entry.header, body: trimTrailingBlank(entry.body) }));
}

function readTerminal(entry: Entry, n: number): PtyContextRecord {
  const single = /^(.*) line (\d+)$/.exec(entry.header);
  const range = /^(.*) lines (\d+)-(\d+)$/.exec(entry.header);
  const match = range ?? single;
  if (match === null) return fail();
  const label = match[1]!.trim();
  const lineStart = Number(match[2]);
  const lineEnd = range ? Number(range[3]) : lineStart;
  return {
    version: 1,
    contextId: idOf("terminal", n),
    kind: "terminal",
    label: entry.header,
    terminalId: label.toLowerCase().replace(/\s+/g, "-"),
    terminalLabel: label,
    lineStart,
    lineEnd,
    text: entry.body.map((line) => line.replace(/^\d+ \| ?/, "")).join("\n"),
  };
}

type ElementFields = Omit<ElementContextRecord, "version" | "contextId" | "kind" | "label">;

function readElement(entry: Entry): { name: string; fields: ElementFields } {
  const header = /^<([^<>\s]+)>(?:\s*\(.*\))?$/.exec(entry.header);
  if (header === null) return fail();
  const name = header[1]!;

  const values: Record<string, string> = {};
  const sections: Record<string, string[]> = {};
  let section: string[] | null = null;
  for (const line of entry.body) {
    const heading = /^(html|styles):$/.exec(line);
    if (heading) {
      section = sections[heading[1]!] = [];
      continue;
    }
    if (section !== null && (line.startsWith("  ") || line === "")) {
      section.push(line.slice(2));
      continue;
    }
    section = null;
    const field = /^(url|selector|source): ?(.*)$/.exec(line);
    if (field) values[field[1]!] = field[2]!;
  }

  let source: ElementFields["source"] = null;
  if (values.source) {
    const parsed = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(values.source)!;
    source = {
      functionName: null,
      fileName: parsed[1]!,
      lineNumber: parsed[2] === undefined ? null : Number(parsed[2]),
      columnNumber: parsed[3] === undefined ? null : Number(parsed[3]),
    };
  }
  return {
    name,
    fields: {
      pageUrl: values.url ?? "",
      pageTitle: null,
      tagName: name.toLowerCase(),
      selector: values.selector || null,
      htmlPreview: trimTrailingBlank(sections.html ?? []).join("\n"),
      componentName: /[A-Z]/.test(name) ? name : null,
      source,
      styles: trimTrailingBlank(sections.styles ?? []).join("\n"),
    },
  };
}

// ---- Preview annotations -----------------------------------------------------------------------

const DELIMITER_LINES = new Set([
  ...BLOCK_TAGS.flatMap((tag) => [`<${tag}>`, `</${tag}>`]),
  REVIEW_CLOSE,
]);
const isDelimiter = (line: string) =>
  DELIMITER_LINES.has(line) || line.startsWith("<review_comment");
const SCREENSHOT_NOTE = "The attached screenshot is the annotated preview crop.";

function readPreview(lines: readonly string[], n: number): WebMarkupContextRecord {
  const fields: Record<string, string[]> = {};
  const styleChanges: string[] = [];
  const elements: Array<ElementFields> = [];
  let current: string | null = null;
  let inChanges = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line === "<element_context>") {
      const close = lines.indexOf("</element_context>", i + 1);
      if (close < 0) return fail();
      for (const entry of readEntries(lines.slice(i + 1, close)))
        elements.push(readElement(entry).fields);
      i = close;
      current = null;
      inChanges = false;
      continue;
    }
    if (line === "Preview annotation:") {
      current = null;
      continue;
    }
    if (line === "Requested visual changes:") {
      current = null;
      inChanges = true;
      continue;
    }
    if (line === SCREENSHOT_NOTE || isDelimiter(line)) {
      current = null;
      inChanges = false;
      continue;
    }
    const field = /^(Id|Page|Comment|Targets): ?(.*)$/.exec(line);
    if (field) {
      current = field[1]!;
      inChanges = false;
      fields[current] = [field[2]!];
      continue;
    }
    if (inChanges) {
      if (line.startsWith("- ")) styleChanges.push(line.slice(2));
      else inChanges = false;
      continue;
    }
    if (current !== null) fields[current]!.push(line);
  }

  const value = (name: string) => (fields[name] ?? []).join("\n").trim();
  const page = value("Page");
  const isUrl = /^https?:\/\//i.test(page);
  const record: WebMarkupContextRecord = {
    version: 1,
    contextId: idOf("preview-annotation", n),
    kind: "preview-annotation",
    label: page || "Preview annotation",
    annotationId: value("Id"),
    pageUrl: isUrl ? page : (elements[0]?.pageUrl ?? ""),
    pageTitle: isUrl || page === "" ? null : page,
    comment: value("Comment"),
    targetSummary: value("Targets"),
    styleChanges,
    ...(elements.length > 0 ? { elements } : {}),
  };
  return record;
}

// ---- Terminal labels in prose ------------------------------------------------------------------

const WORD_BEFORE = /[\p{L}\p{N}\p{M}_@.-]/u;
const WORD_AFTER = /[\p{L}\p{N}\p{M}_]/u;

/** Slug and range exactly as the send path wrote them: `@build:7`, `@terminal-1:509-510`. */
const inlineLabel = (record: PtyContextRecord): string =>
  `@${record.terminalId}:${
    record.lineStart === record.lineEnd ? record.lineStart : `${record.lineStart}-${record.lineEnd}`
  }`;

/** A label glued to neighbouring word characters is part of something else (an email, `@build:7foo`). */
function labelIsStandalone(text: string, start: number, end: number): boolean {
  const before = [...text.slice(0, start)].pop();
  if (before !== undefined && WORD_BEFORE.test(before)) return false;
  const rest = [...text.slice(end)];
  let i = 0;
  while (rest[i] !== undefined && /[@.-]/.test(rest[i]!)) i += 1;
  return rest[i] === undefined || !WORD_AFTER.test(rest[i]!);
}

function replaceStandalone(
  text: string,
  label: string,
  replacement: string,
): { text: string; found: boolean } {
  let out = "";
  let cursor = 0;
  let found = false;
  for (let at = text.indexOf(label); at >= 0; at = text.indexOf(label, at + label.length)) {
    if (!labelIsStandalone(text, at, at + label.length)) continue;
    out += text.slice(cursor, at) + replacement;
    cursor = at + label.length;
    found = true;
  }
  return { text: out + text.slice(cursor), found };
}

// ---- Putting it together --------------------------------------------------------------------------

interface Peeled {
  readonly tag: BlockTag;
  readonly lines: string[];
}

/** Removes the last context block from the end of `text`, if it ends with one. */
function peelTrailingBlock(text: string): { rest: string; block: Peeled } | null {
  const trimmed = text.replace(/\s+$/, "");
  const lines = lineRange(trimmed);
  const last = lines[lines.length - 1];
  const tag = BLOCK_TAGS.find((candidate) => last === `</${candidate}>`);
  if (tag === undefined) return null;
  let open = -1;
  for (let i = lines.length - 2; i >= 0; i -= 1) {
    if (lines[i] === `<${tag}>`) {
      open = i;
      break;
    }
  }
  if (open < 0) return null;
  const rest = lines
    .slice(0, open)
    .join("\n")
    .replace(/(\r?\n)+$/, "");
  return { rest, block: { tag, lines: lines.slice(open + 1, lines.length - 1) } };
}

function upgrade(text: string): UpgradedLegacyContext {
  // Reviews first, in place, behind tokens that cannot collide with anything in the message.
  let marker = "";
  while (text.includes(marker)) marker += marker;
  const tokenFor = (index: number) => `${marker}${index}${marker}`;

  const protectedAt = protectedRanges(text);
  const reviews: ContextChipRecordType[] = [];
  let withTokens = "";
  let cursor = 0;
  for (const open of text.matchAll(/<review_comment\b/g)) {
    const start = open.index!;
    if (start < cursor || protectedAt.some(([from, to]) => start >= from && start <= to)) continue;
    const tagEnd = text.indexOf(">", start);
    if (tagEnd < 0) continue;
    const close = findReviewClose(text, tagEnd + 1);
    if (close < 0) continue;
    const record = readReview(
      text.slice(start + "<review_comment".length, tagEnd),
      text.slice(tagEnd + 1, close),
      reviews.length + 1,
    );
    if (record === null) continue;
    withTokens += text.slice(cursor, start) + tokenFor(reviews.length);
    reviews.push(record);
    cursor = close + REVIEW_CLOSE.length;
  }
  withTokens += text.slice(cursor);

  // Trailing reviews that follow other trailing blocks belong after them.
  let work = withTokens;
  const peeledReviews: number[] = [];
  const trailingTokens = new RegExp(`(?:\\s*${marker}\\d+${marker})+\\s*$`).exec(work);
  if (trailingTokens !== null) {
    const before = work.slice(0, trailingTokens.index);
    if (/<\/(?:terminal_context|element_context|preview_annotation)>\s*$/.test(before)) {
      for (const token of trailingTokens[0].matchAll(new RegExp(`${marker}(\\d+)${marker}`, "g"))) {
        peeledReviews.push(Number(token[1]));
      }
      work = before;
    }
  }

  const peeled: Peeled[] = [];
  for (let next = peelTrailingBlock(work); next !== null; next = peelTrailingBlock(work)) {
    work = next.rest;
    peeled.unshift(next.block);
  }

  const terminals: PtyContextRecord[] = [];
  const elements: ContextChipRecordType[] = [];
  const previews: ContextChipRecordType[] = [];
  for (const block of peeled) {
    if (block.tag === "preview_annotation") {
      previews.push(readPreview(block.lines, previews.length + 1));
      continue;
    }
    const entries = readEntries(block.lines);
    if (entries.length === 0) fail();
    for (const entry of entries) {
      if (block.tag === "terminal_context") {
        terminals.push(readTerminal(entry, terminals.length + 1));
      } else {
        const { name, fields } = readElement(entry);
        elements.push({
          version: 1,
          contextId: idOf("element", elements.length + 1),
          kind: "element",
          label: `<${name}>`,
          ...fields,
        });
      }
    }
  }

  const link = (record: ContextChipRecordType) =>
    formatContextChipReference({
      kind: record.kind,
      contextId: record.contextId,
      label: record.label,
    });

  let body = work;
  for (let index = reviews.length - 1; index >= 0; index -= 1) {
    if (peeledReviews.includes(index)) continue;
    body = body.split(tokenFor(index)).join(link(reviews[index]!));
  }

  // Placeholders bind to terminals in order; surplus placeholders disappear.
  const unplaced: PtyContextRecord[] = [];
  let bound = 0;
  body = body.replace(/￼/g, () => {
    const terminal = terminals[bound];
    bound += 1;
    return terminal === undefined ? "" : link(terminal);
  });
  for (const terminal of terminals.slice(bound)) {
    const replaced = replaceStandalone(body, inlineLabel(terminal), link(terminal));
    if (replaced.found) body = replaced.text;
    else unplaced.push(terminal);
  }

  const peeledLinks = peeledReviews.map((index) => reviews[index]!);
  const appended = [...unplaced, ...elements, ...previews, ...peeledLinks].map(link);
  body = body.trimEnd();
  const tail = appended.join(" ");
  const result = tail === "" ? body : body === "" ? tail : `${body}\n\n${tail}`;

  const records: ContextChipRecordType[] = [...terminals, ...elements, ...previews, ...reviews];
  if (!isRecordList(records)) return fail();
  return { text: result, records };
}

export function upgradeLegacyContextMessage(text: string): UpgradedLegacyContext {
  if (!MAYBE_LEGACY.test(text)) return { text, records: [] };
  try {
    return upgrade(text);
  } catch (error) {
    if (error instanceof Unreadable) return { text, records: [] };
    throw error;
  }
}
