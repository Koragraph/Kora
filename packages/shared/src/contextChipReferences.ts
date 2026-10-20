import {
  type PickedNodeDetails,
  type KnownContextChipRecord,
  type ContextChipRecord,
  type ContextTagKind,
  type ContextChipId,
  CONTEXT_CHIP_LABEL_MAX_CHARS,
} from "@kora/contracts";

// A chip is a Markdown link (an image link for images) whose URL carries only the chip's kind and
// id: `[label](kora-context://v1/<kind>/<id>)`. Labels are for display; the id is the identity.

const HREF_PREFIX = "kora-context://v1/";
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const ID_PATTERN = /^[a-z0-9_-]{1,128}$/i;
const LABEL_MAX_SCAN = 512;
const HREF_MAX_TAIL = 200;

export function formatContextChipHref(kind: ContextTagKind, contextId: ContextChipId): string {
  return `${HREF_PREFIX}${kind}/${contextId}`;
}

export function parseContextChipHref(
  href: string,
): { kind: ContextTagKind; contextId: ContextChipId } | null {
  if (!href.startsWith(HREF_PREFIX)) return null;
  const parts = href.slice(HREF_PREFIX.length).split("/");
  if (parts.length !== 2) return null;
  const [kind = "", contextId = ""] = parts;
  if (!KIND_PATTERN.test(kind) || !ID_PATTERN.test(contextId)) return null;
  return { kind: kind as ContextTagKind, contextId: contextId as ContextChipId };
}

export function sanitizeContextChipLabel(label: string, kind: ContextTagKind): string {
  const flattened = label.replace(/[[\]\\\r\n]/g, " ").replace(/\s+/g, " ");
  const cleaned = flattened.trim().slice(0, CONTEXT_CHIP_LABEL_MAX_CHARS).trim();
  return cleaned || kind;
}

export function formatContextChipReference(reference: {
  readonly kind: ContextTagKind;
  readonly contextId: ContextChipId;
  readonly label: string;
}): string {
  const label = sanitizeContextChipLabel(reference.label, reference.kind);
  const link = `[${label}](${formatContextChipHref(reference.kind, reference.contextId)})`;
  return reference.kind === "image" ? `!${link}` : link;
}

export interface ContextChipReferenceOccurrence {
  readonly kind: ContextTagKind;
  readonly contextId: ContextChipId;
  readonly label: string;
  readonly image: boolean;
  readonly end: number;
  readonly start: number;
  readonly source: string;
}

const referencePattern = () =>
  new RegExp(
    `(!?)\\[([^\\]\\r\\n]{0,${LABEL_MAX_SCAN}})\\]\\((kora-context://v1/[^\\s)]{1,${HREF_MAX_TAIL}})\\)`,
    "g",
  );

export function collectContextChipReferences(text: string): ContextChipReferenceOccurrence[] {
  // Plain prose has none; skip the scan.
  if (!text.includes("](kora-context:")) return [];
  const found: ContextChipReferenceOccurrence[] = [];
  for (const match of text.matchAll(referencePattern())) {
    const parsed = parseContextChipHref(match[3] ?? "");
    if (parsed === null) continue;
    const start = match.index ?? 0;
    found.push({
      kind: parsed.kind,
      contextId: parsed.contextId,
      label: sanitizeContextChipLabel(match[2] ?? "", parsed.kind),
      image: match[1] === "!",
      source: match[0],
      start,
      end: start + match[0].length,
    });
  }
  return found;
}

export function replaceContextChipReferences(
  text: string,
  replace: (occurrence: ContextChipReferenceOccurrence) => string,
): string {
  let out = "";
  let cursor = 0;
  for (const occurrence of collectContextChipReferences(text)) {
    out += text.slice(cursor, occurrence.start) + replace(occurrence);
    cursor = occurrence.end;
  }
  return out + text.slice(cursor);
}

// ---------------------------------------------------------------------------
// What the provider reads
// ---------------------------------------------------------------------------

// Captured text is data. Anything that could close or forge the envelope is defused.
const escapePayload = (text: string): string =>
  text.replace(/<(?=\/?(?:kora_context|context)\b)/gi, "&lt;");

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => "  " + line)
    .join("\n");

const kindDisplay = (kind: string): string => {
  const spaced = kind.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

export function formatContextChipAgentMarker(
  kind: ContextTagKind,
  label: string,
  contextId: ContextChipId,
): string {
  const cleaned = label
    .replace(/[\r\n;\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return escapePayload(`[${kindDisplay(kind)}: ${cleaned}; ref=${contextId}]`);
}

const sourceText = (source: NonNullable<PickedNodeDetails["source"]>): string | null => {
  if (source.fileName === null) return null;
  let text = source.fileName;
  if (source.lineNumber !== null) {
    text += `:${source.lineNumber}`;
    if (source.columnNumber !== null) text += `:${source.columnNumber}`;
  }
  return text;
};

const elementLines = (element: PickedNodeDetails): string[] => {
  const lines = [`url: ${element.pageUrl}`, `tag: ${element.tagName}`];
  if (element.pageTitle !== null) lines.push(`title: ${element.pageTitle}`);
  if (element.selector !== null) lines.push(`selector: ${element.selector}`);
  if (element.componentName !== null) lines.push(`component: ${element.componentName}`);
  const source = element.source === null ? null : sourceText(element.source);
  if (source !== null) lines.push(`source: ${source}`);
  if (element.htmlPreview.trim().length > 0)
    lines.push("html:", indent(element.htmlPreview.trim()));
  if (element.styles.trim().length > 0) lines.push("styles:", indent(element.styles.trim()));
  return lines;
};

const bodyOf = (record: KnownContextChipRecord): string => {
  switch (record.kind) {
    case "terminal": {
      const count = record.lineEnd - record.lineStart + 1;
      const numbered = record.text
        .split("\n")
        .slice(0, count)
        .map((line, index) => `${record.lineStart + index} | ${line}`);
      return [`terminal: ${record.terminalLabel}`, ...numbered].join("\n");
    }
    case "element":
      return elementLines(record).join("\n");
    case "preview-annotation": {
      const pageName = record.pageTitle?.trim() || record.pageUrl;
      const lines = ["page: " + pageName, "url: " + record.pageUrl];
      const comment = record.comment.trim();
      if (comment) lines.push("comment: " + comment);
      lines.push("targets: " + record.targetSummary);
      if (record.styleChanges.length) {
        lines.push("requested visual changes:");
        for (const change of record.styleChanges) lines.push("- " + change);
      }
      (record.elements ?? []).forEach((element, index) => {
        lines.push(`element ${index + 1}:`, indent(elementLines(element).join("\n")));
      });
      return lines.join("\n");
    }
    case "review-comment": {
      const span = `${record.rangeLabel} (${record.startIndex}-${record.endIndex})`;
      const note = record.text.trim();
      const hasDiff = record.diff.trim() !== "";
      return [
        `file: ${record.filePath}`,
        `range: ${span}`,
        `section: ${record.sectionTitle}`,
        ...(note === "" ? [] : ["comment:", indent(note)]),
        ...(hasDiff ? [`${record.fenceLanguage || "diff"}:`, indent(record.diff.trimEnd())] : []),
      ].join("\n");
    }
    case "skill":
      return "name: " + record.name;
    case "mention":
      return "path: " + record.path;
  }
};

const entryOf = (
  kind: string,
  contextId: string,
  record: ContextChipRecord | undefined,
): string => {
  const open = `<context kind="${escapeAttribute(kind)}" id="${escapeAttribute(contextId)}"`;
  if (record === undefined) return `${open} unavailable="true"/>`;
  const raw =
    "payload" in record
      ? JSON.stringify((record as { payload: unknown }).payload)
      : bodyOf(record as KnownContextChipRecord);
  return `${open}>\n${escapePayload(raw ?? "")}\n</context>`;
};

/**
 * The text a provider reads: each chip replaced in place by a short marker, and the payload
 * behind every referenced chip written once in a trailing envelope.
 */
export function projectContextChipForAgent(input: {
  readonly text: string;
  readonly records: ReadonlyArray<ContextChipRecord>;
}): string {
  const occurrences = collectContextChipReferences(input.text);
  if (occurrences.length === 0) return input.text;

  // An id carried by two records is refused rather than guessed at.
  const byId = new Map<string, ContextChipRecord | "ambiguous">();
  for (const record of input.records) {
    byId.set(record.contextId, byId.has(record.contextId) ? "ambiguous" : record);
  }
  const lookup = (id: string): ContextChipRecord | undefined => {
    const found = byId.get(id);
    return found === "ambiguous" ? undefined : found;
  };

  const entries = new Map<string, string>();
  const body = replaceContextChipReferences(input.text, (occurrence) => {
    const record = lookup(occurrence.contextId);
    const kind = record?.kind ?? occurrence.kind;
    if (!entries.has(occurrence.contextId)) {
      entries.set(occurrence.contextId, entryOf(kind, occurrence.contextId, record));
    }
    return formatContextChipAgentMarker(kind, occurrence.label, occurrence.contextId);
  });

  return `${body}\n\n<kora_context version="1">\n${[...entries.values()].join("\n")}\n</kora_context>`;
}
