import { REPLY_FOOTNOTE_CONTEXT_LENGTH, type ReplyFootnote } from "@kora/contracts";

export type AssistantTextSelector = {
  readonly suffix: string;
  readonly prefix: string;
  readonly end: number;
  readonly start: number;
  readonly text: string;
};

/** Live DOM handles for a citation; never persisted. */
export type ReplyFootnoteSourceAnchor = {
  viewport: HTMLElement;
  range: Range;
  source: HTMLElement;
};

const SOURCE_SELECTOR = "[data-reply-footnote-source]";
const VIEWPORT_SELECTOR = "[data-reply-footnote-viewport]";
// Controls, hidden content and non-text subtrees never contribute to the quote stream.
const EXCLUDED_SELECTOR =
  "button, input, textarea, select, [role=button], [contenteditable], [hidden], [aria-hidden=true], script, style, template, noscript, svg";

const BLOCK_TAGS = new Set(
  "ADDRESS ARTICLE ASIDE BLOCKQUOTE DD DIV DL DT FIGCAPTION FIGURE FOOTER H1 H2 H3 H4 H5 H6 HEADER HR LI MAIN NAV OL P PRE SECTION TABLE TD TH TR UL".split(
    " ",
  ),
);

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

const collapse = (str: string) => str.replace(/\s+/g, " ");
const isBlank = (str: string) => /^\s*$/.test(str);
const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

// ---------- selectors over plain text ----------

export function createAssistantTextSelector(
  str: string,
  rawStart: number,
  rawEnd: number,
): AssistantTextSelector | null {
  const quote = str.slice(rawStart, rawEnd);
  if (isBlank(quote)) return null;

  const normalizedBefore = collapse(str.slice(0, rawStart)).length;
  const startsInsideWhitespace =
    rawStart > 0 && /\s/.test(str[rawStart - 1]!) && /\s/.test(str[rawStart] ?? "");
  const begin = normalizedBefore - (startsInsideWhitespace ? 1 : 0);
  const until = collapse(str.slice(0, rawEnd)).length;

  const flat = collapse(str);
  let lead = flat.slice(Math.max(0, begin - REPLY_FOOTNOTE_CONTEXT_LENGTH), begin);
  let ending = flat.slice(until, until + REPLY_FOOTNOTE_CONTEXT_LENGTH);
  // Never leave half a surrogate pair at the clipped edge.
  if (lead.length > 0 && isLowSurrogate(lead.charCodeAt(0)) && begin - lead.length > 0) {
    lead = lead.slice(1);
  }
  if (
    ending.length > 0 &&
    isHighSurrogate(ending.charCodeAt(ending.length - 1)) &&
    until + ending.length < flat.length
  ) {
    ending = ending.slice(0, -1);
  }
  return { text: quote, start: begin, end: until, prefix: lead, suffix: ending };
}

export function findReplyFootnoteText(
  str: string,
  selector: AssistantTextSelector,
): { start: number; end: number } | null {
  if (isBlank(selector.text)) return null;
  const flat = collapse(str);
  const quote = collapse(selector.text);
  const lead = collapse(selector.prefix);
  const ending = collapse(selector.suffix);

  const contextMatches = (startAt: number, destination: number) =>
    flat.slice(Math.max(0, startAt - lead.length), startAt) === lead &&
    flat.slice(destination, destination + ending.length) === ending;

  const occurrences: number[] = [];
  for (let when = flat.indexOf(quote); when >= 0; when = flat.indexOf(quote, when + 1))
    occurrences.push(when);

  const withContext = occurrences.filter((when) => contextMatches(when, when + quote.length));
  // Saved offsets are only a hint: they never choose between equally good candidates.
  if (withContext.length === 1)
    return { start: withContext[0]!, end: withContext[0]! + quote.length };
  if (withContext.length === 0 && occurrences.length === 1) {
    return { start: occurrences[0]!, end: occurrences[0]! + quote.length };
  }
  return null;
}

// ---------- DOM text stream ----------

type Chunk = { node: Text; start: number; end: number };
type Stream = { text: string; chunks: Chunk[] };

function readAssistantText(root: Element): Stream {
  let str = "";
  const chunks: Chunk[] = [];
  let breakPending = false;

  const visit = (node: Node) => {
    if (node.nodeType === TEXT_NODE) {
      const blob = (node as Text).data;
      if (blob.length === 0) return;
      if (breakPending && str.length > 0) str += "\n";
      breakPending = false;
      chunks.push({ node: node as Text, start: str.length, end: str.length + blob.length });
      str += blob;
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const el = node as Element;
    if (el !== root && el.matches(EXCLUDED_SELECTOR)) return;
    const marker = el.tagName.toUpperCase();
    const block = BLOCK_TAGS.has(marker);
    if (block || marker === "BR") breakPending = true;
    for (const kid of Array.from(el.childNodes)) visit(kid);
    if (block) breakPending = true;
  };
  visit(root);
  return { text: str, chunks };
}

/** Collapsed position -> raw stream position (whitespace runs count as one unit). */
function rawTextOffset(unparsed: string, normalizedOffset: number): number {
  let normalized = 0;
  let consumed = 0;
  for (const matched of unparsed.matchAll(/\s+|\S+/g)) {
    const exec = matched[0];
    const whitespace = /^\s/.test(exec);
    const width = whitespace ? 1 : exec.length;
    if (normalizedOffset <= normalized + width) {
      if (!whitespace) return consumed + (normalizedOffset - normalized);
      return normalizedOffset === normalized ? consumed : consumed + exec.length;
    }
    normalized += width;
    consumed += exec.length;
  }
  return unparsed.length;
}

const elementOf = (node: Node): Element | null =>
  node.nodeType === ELEMENT_NODE ? (node as Element) : node.parentElement;

const inExcluded = (node: Node) => elementOf(node)?.closest(EXCLUDED_SELECTOR) != null;

function usableRange(span: Range, root: Element): boolean {
  if (span.collapsed) return false;
  if (!root.contains(span.startContainer) || !root.contains(span.endContainer)) return false;
  return !inExcluded(span.startContainer) && !inExcluded(span.endContainer);
}

function textNodesUnder(root: Node): Text[] {
  const located: Text[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === TEXT_NODE) located.push(node as Text);
    else for (const kid of Array.from(node.childNodes)) walk(kid);
  };
  walk(root);
  return located;
}

// ---------- capture / resolve ----------

export function captureAssistantTextSelection(
  viewport: HTMLElement,
  picked: Selection | null,
): { source: HTMLElement; selector: AssistantTextSelector; range: Range } | null {
  if (!picked || picked.isCollapsed || picked.rangeCount !== 1) return null;
  const original = picked.getRangeAt(0);
  const span = original.cloneRange();

  // Find the text nodes that really contain selected characters; the range ends can sit on
  // element boundaries (backward drags, the start of the next block, a parent container).
  let first: { node: Text; offset: number } | null = null;
  let last: { node: Text; offset: number } | null = null;
  for (const node of textNodesUnder(span.commonAncestorContainer)) {
    if (!span.intersectsNode(node)) continue;
    const startOffset = node === span.startContainer ? span.startOffset : 0;
    const destination = node === span.endContainer ? span.endOffset : node.length;
    if (destination <= startOffset) continue;
    first ??= { node: node, offset: startOffset };
    last = { node: node, offset: destination };
  }
  if (!first || !last) return null;

  const origin = first.node.parentElement?.closest(SOURCE_SELECTOR) as HTMLElement | null;
  if (!origin || !viewport.contains(origin)) return null;

  span.setStart(first.node, first.offset);
  span.setEnd(last.node, last.offset);
  if (!usableRange(span, origin)) return null;

  const flow = readAssistantText(origin);
  const firstChunk = flow.chunks.find((ch) => ch.node === first.node);
  const lastChunk = flow.chunks.find((ch) => ch.node === last.node);
  if (!firstChunk || !lastChunk) return null;

  const selector = createAssistantTextSelector(
    flow.text,
    firstChunk.start + first.offset,
    lastChunk.start + last.offset,
  );
  return selector ? { source: origin, selector: selector, range: span } : null;
}

export function resolveReplyFootnoteRange(
  container: HTMLElement,
  anchor: AssistantTextSelector,
): Range | null {
  if (container.closest(EXCLUDED_SELECTOR)) return null;
  const flow = readAssistantText(container);
  const located = findReplyFootnoteText(flow.text, anchor);
  if (!located) return null;

  const rawStart = rawTextOffset(flow.text, located.start);
  const rawEnd = rawTextOffset(flow.text, located.end);
  const head = flow.chunks.find((ch) => ch.end > rawStart);
  const tail = [...flow.chunks].reverse().find((ch) => ch.start < rawEnd);
  if (!head || !tail) return null;

  const within = (piece: Chunk, unparsed: number) =>
    Math.min(piece.node.length, Math.max(0, unparsed - piece.start));
  const span = container.ownerDocument.createRange();
  span.setStart(head.node, within(head, rawStart));
  span.setEnd(tail.node, within(tail, rawEnd));
  return usableRange(span, container) ? span : null;
}

export function findReplyFootnoteSourceAnchor(
  document: Document,
  citation: ReplyFootnote,
): ReplyFootnoteSourceAnchor | null {
  for (const cand of Array.from(document.querySelectorAll<HTMLElement>(SOURCE_SELECTOR))) {
    if (
      cand.getAttribute("data-reply-footnote-source") !== citation.messageId ||
      cand.getAttribute("data-assistant-citation-host") !== citation.hostId ||
      cand.getAttribute("data-reply-footnote-thread") !== citation.threadId
    ) {
      continue;
    }
    const viewport = cand.closest<HTMLElement>(VIEWPORT_SELECTOR);
    if (!viewport) return null;
    const span = resolveReplyFootnoteRange(cand, citation);
    return span ? { source: cand, range: span, viewport } : null;
  }
  return null;
}
