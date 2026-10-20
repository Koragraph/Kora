export function isBlank(line) {
  return /^\s*$/.test(line);
}

export function countIndent(line) {
  return /^ */.exec(line)[0].length;
}

export function dedent(lines, n) {
  return lines.map((l) => l.slice(Math.min(n, countIndent(l))));
}

export function plainText(nodes) {
  return nodes
    .map((n) => (n.type === 'text' || n.type === 'code' ? n.value : n.children ? plainText(n.children) : n.alt ?? ''))
    .join('');
}
