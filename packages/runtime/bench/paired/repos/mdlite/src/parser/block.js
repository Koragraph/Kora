import { parseInline } from './inline.js';
import { parseList, LIST_MARKER } from './lists.js';
import { isBlank } from './utils.js';

const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ATX = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const QUOTE = /^ {0,3}>/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;

function startsBlock(line) {
  return FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line) || LIST_MARKER.test(line);
}

export function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    let m;
    if ((m = FENCE.exec(line))) {
      const fence = m[1];
      const body = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(fence[0].repeat(fence.length)) && lines[i].trim().replace(new RegExp(`^\\${fence[0]}+`), '') === '')) body.push(lines[i++]);
      i++; // closing fence
      blocks.push({ type: 'fence', lang: m[2] || null, value: body.join('\n') });
    } else if ((m = ATX.exec(line))) {
      blocks.push({ type: 'heading', depth: m[1].length, children: parseInline(m[2]) });
      i++;
    } else if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
    } else if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      blocks.push({ type: 'blockquote', children: parseBlocks(inner) });
    } else if (LIST_MARKER.test(line)) {
      const { node, next } = parseList(lines, i, parseBlocks);
      blocks.push(node);
      i = next;
    } else {
      const para = [line];
      i++;
      let setext = null;
      while (i < lines.length && !isBlank(lines[i])) {
        if (SETEXT.test(lines[i])) { setext = lines[i].trim()[0] === '=' ? 1 : 2; i++; break; }
        if (startsBlock(lines[i])) break;
        para.push(lines[i++]);
      }
      const text = para.map((l) => l.replace(/^\s+/, '')).join('\n').replace(/\s+$/, '');
      blocks.push(setext ? { type: 'heading', depth: setext, children: parseInline(text) } : { type: 'paragraph', children: parseInline(text) });
    }
  }
  return blocks;
}

export function parse(markdown) {
  return parseBlocks(String(markdown).replace(/\r\n?/g, '\n').split('\n'));
}
