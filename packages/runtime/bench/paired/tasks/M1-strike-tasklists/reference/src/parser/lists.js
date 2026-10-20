import { parseInline } from './inline.js';

export const LIST_MARKER = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;

// Parse one list starting at lines[start]. Nested items (indented deeper) become the item's children.
// Returns { node, next } where next is the index of the first line after the list.
export function parseList(lines, start, parseBlocks) {
  const first = LIST_MARKER.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_MARKER.exec(lines[i]);
    if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
    i++;
    const nested = [];
    while (i < lines.length) {
      const nm = LIST_MARKER.exec(lines[i]);
      if (nm && nm[1].length > baseIndent) { nested.push(lines[i]); i++; } else break;
    }
    const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
    items.push({
      type: 'item',
      task: task ? (task[1] === ' ' ? 'open' : 'done') : null,
      children: parseInline(task ? task[2] : m[3]),
      blocks: nested.length ? parseBlocks(nested) : [],
    });
  }
  const startNumber = ordered ? Number.parseInt(first[2], 10) : null;
  return { node: { type: 'list', ordered, start: startNumber, items }, next: i };
}
