import { slugify } from '../renderer/html.js';
import { plainText } from '../parser/utils.js';

export function collectHeadings(blocks) {
  return blocks
    .filter((b) => b.type === 'heading' || b.type === 'heading-anchored')
    .map((b) => {
      const text = plainText(b.children);
      return { depth: b.depth, text, id: b.slug ?? slugify(text) };
    });
}

// Insert a table of contents node at the top of the document.
export function tocPlugin(options = {}) {
  return (blocks) => [{ type: 'toc', headings: collectHeadings(blocks), ...options }, ...blocks];
}
