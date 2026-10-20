/**
 * Is the caret on the first (or last) visual line of the editor, soft wraps included? Prompt history takes
 * ArrowUp/ArrowDown only there, so the arrows still move the caret inside a multi-line prompt.
 */

/** A visible rect from `rects`, from the end that is farther from `edge`. */
function pick(rects: DOMRectList, edge: "start" | "end"): DOMRect | undefined {
  const visible = Array.from(rects).filter((r) => r.height > 0);
  return edge === "start" ? visible.at(-1) : visible[0];
}

function charRect(text: Text, at: number): DOMRect | null {
  const range = document.createRange();
  range.setStart(text, at);
  range.setEnd(text, at + 1);
  const rect = pick(range.getClientRects(), "end") ?? range.getBoundingClientRect();
  return rect.height > 0 ? rect : null;
}

/**
 * The rect of the line a collapsed caret is on. A caret at a soft wrap belongs to two lines and gets a rect for
 * each: the one farther from `edge` is used, so an ambiguous caret never claims the key. Where the collapsed range
 * has no height, the neighbouring character (or the chip beside it, or the line itself) is measured instead.
 */
export function caretLineRect(caret: Range, edge: "start" | "end"): DOMRect | null {
  const direct = pick(caret.getClientRects(), edge);
  if (direct) return direct;

  const container = caret.startContainer;
  if (container instanceof Text) {
    if (container.data.length === 0) return null;
    const at = edge === "start" ? caret.startOffset : caret.startOffset - 1;
    return charRect(container, Math.max(0, Math.min(at, container.data.length - 1)));
  }
  if (!(container instanceof HTMLElement)) return null;

  // Between the paragraph's children: Lexical's caret position next to a chip.
  const children = container.childNodes;
  const left = children[caret.startOffset - 1];
  const neighbour = left ?? children[caret.startOffset];
  if (neighbour instanceof HTMLElement) {
    const rect = neighbour.getBoundingClientRect();
    if (rect.height > 0) return rect;
  } else if (neighbour instanceof Text && neighbour.data.length > 0) {
    // The character on the caret's side: a wrapped text node's first rect may be another line.
    const rect = charRect(neighbour, neighbour === left ? neighbour.data.length - 1 : 0);
    if (rect) return rect;
  }
  const own = container.getBoundingClientRect();
  return own.height > 0 ? own : null;
}

/**
 * `prompt` and the caret's expanded offset in it decide the easy cases (an empty prompt is on both edges; a newline
 * on the edge's side means it is not); otherwise the caret's line is measured against the editor's outer line.
 */
export function isCaretOnVisualEdge(
  root: HTMLElement | null,
  prompt: string,
  caret: number,
  edge: "start" | "end",
): boolean {
  if (prompt === "") return true;
  const towardEdge = edge === "start" ? prompt.slice(0, caret) : prompt.slice(caret);
  if (towardEdge.includes("\n")) return false;
  const dom = window.getSelection();
  if (
    !root ||
    !dom?.isCollapsed ||
    dom.rangeCount === 0 ||
    !dom.anchorNode ||
    !root.contains(dom.anchorNode)
  ) {
    return false;
  }
  const line = caretLineRect(dom.getRangeAt(0), edge);
  if (!line) return false;
  const outer = (
    (edge === "start" ? root.firstElementChild : root.lastElementChild) ?? root
  ).getBoundingClientRect();
  const gap = edge === "start" ? line.top - outer.top : outer.bottom - line.bottom;
  return gap < line.height / 2;
}
