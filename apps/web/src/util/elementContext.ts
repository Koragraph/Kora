import type { PickedNodePayload, PickedElementStackFrame, WebMarkupPayload } from "@kora/contracts";

const ELEMENT_CONTEXT_HTML_VIEW_LIMIT = 4000;
const ELEMENT_CONTEXT_STYLES_LIMIT = 4000;

/**
 * Stable, persistable element selection captured from the in-app preview
 * browser. We deliberately keep the shape JSON-serializable so it can ride
 * through `localStorage` persistence, draft restoration, and transcript
 * snapshots without bespoke marshalling.
 */
export interface ElementContextSelection {
  /** Author CSS (no UA defaults). May be empty. */
  styles: string;
  /** Source frame (file + line) — null when unavailable. */
  source: PickedElementStackFrame | null;
  /** Nearest React component display name, or null. */
  componentName: string | null;
  /** Truncated outer-HTML preview. */
  htmlPreview: string;
  /** CSS selector — may be null when react-grab can't compute one. */
  selector: string | null;
  /** Lowercase tag, e.g. `"button"`. */
  tagName: string;
  /** Best-effort `<title>`. */
  pageTitle: string | null;
  /** Page URL where the element was picked. */
  pageUrl: string;
}

function truncateString(val: string, limit: number): string {
  if (val.length <= limit) return val;
  return `${val.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeText(val: string): string {
  return val.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

/**
 * Sanitize a payload coming back from the desktop bridge before it lands in
 * the composer draft. Trims/clamps every string field so we never persist a
 * 5MB outerHTML blob and silently break `localStorage`.
 */
export function normalizeElementContextSelection(
  unparsed: PickedNodePayload,
): ElementContextSelection | null {
  const pageUrl = unparsed.pageUrl.trim();
  const tagName = unparsed.tagName.trim().toLowerCase();
  if (pageUrl.length === 0 || tagName.length === 0) {
    return null;
  }
  const stackFrame = unparsed.source ?? unparsed.stack[0] ?? null;
  return {
    pageUrl,
    pageTitle: unparsed.pageTitle?.trim() ?? null,
    tagName,
    selector: unparsed.selector?.trim() || null,
    htmlPreview: truncateString(
      normalizeText(unparsed.htmlPreview),
      ELEMENT_CONTEXT_HTML_VIEW_LIMIT,
    ),
    componentName: unparsed.componentName?.trim() || null,
    source: stackFrame
      ? {
          columnNumber: stackFrame.columnNumber ?? null,
          lineNumber: stackFrame.lineNumber ?? null,
          fileName: stackFrame.fileName?.trim() || null,
          functionName: stackFrame.functionName?.trim() || null,
        }
      : null,
    styles: truncateString(normalizeText(unparsed.styles), ELEMENT_CONTEXT_STYLES_LIMIT),
  };
}

/** Converts a saved element pick into the annotation shape used by current drafts. */
export function elementContextToWebMarkup(
  elem: ElementContextSelection,
  ident: string,
  pickedAt: string,
): WebMarkupPayload {
  return {
    createdAt: pickedAt,
    screenshot: null,
    styleChanges: [],
    strokes: [],
    regions: [],
    elements: [
      {
        id: ident,
        element: { ...elem, stack: [], pickedAt },
        rect: { x: 0, y: 0, width: 0, height: 0 },
      },
    ],
    comment: "",
    pageTitle: elem.pageTitle,
    pageUrl: elem.pageUrl,
    id: ident,
  };
}
