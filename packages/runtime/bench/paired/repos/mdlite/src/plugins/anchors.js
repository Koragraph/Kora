import { slugify } from '../renderer/html.js';
import { plainText } from '../parser/utils.js';

// Turn every heading into an anchored heading with a visible "#" link; duplicate slugs get -1, -2, ...
export function anchorPlugin(blocks) {
  const seen = new Map();
  return blocks.map((block) => {
    if (block.type !== 'heading') return block;
    const base = slugify(plainText(block.children));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...block, type: 'heading-anchored', slug: n ? `${base}-${n}` : base };
  });
}
