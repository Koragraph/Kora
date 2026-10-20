import { parse } from './parser/block.js';
import { renderHtml } from './renderer/html.js';
import { renderPlainText } from './renderer/text.js';

export { parse, renderHtml, renderPlainText };
export { escapeHtml } from './parser/escape.js';
export { sanitizeUrl, slugify } from './renderer/html.js';
export { anchorPlugin } from './plugins/anchors.js';
export { tocPlugin } from './plugins/toc.js';

export function render(markdown, { plugins = [], ...options } = {}) {
  let blocks = parse(markdown);
  for (const plugin of plugins) blocks = plugin(blocks);
  return renderHtml(blocks, options);
}

export function renderText(markdown) {
  return renderPlainText(parse(markdown));
}
