import { plainText } from '../parser/utils.js';

function inline(nodes) {
  return plainText(nodes);
}

function block(node, depth = 0) {
  switch (node.type) {
    case 'heading':
      return `${inline(node.children)}\n${(node.depth === 1 ? '=' : '-').repeat(Math.max(3, inline(node.children).length))}\n`;
    case 'paragraph':
      return inline(node.children) + '\n';
    case 'fence':
      return node.value.split('\n').map((l) => '    ' + l).join('\n') + '\n';
    case 'blockquote':
      return node.children.map((b) => block(b, depth)).join('').split('\n').map((l) => (l ? '> ' + l : l)).join('\n');
    case 'hr':
      return '-----\n';
    case 'list':
      return node.items
        .map((item, i) => {
          const marker = node.ordered ? `${(node.start ?? 1) + i}.` : '*';
          const nested = (item.blocks ?? []).map((b) => block(b, depth + 1)).join('');
          return `${'  '.repeat(depth)}${marker} ${inline(item.children)}\n${nested}`;
        })
        .join('');
    default:
      return '';
  }
}

export function renderPlainText(blocks) {
  return blocks.map((b) => block(b)).join('\n');
}
