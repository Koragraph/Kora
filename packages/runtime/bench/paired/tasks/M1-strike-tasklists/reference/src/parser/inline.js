// Inline scanner: text → array of inline nodes.
const ESCAPABLE = '\\`*_[]()#>!<~|';

function findCodeEnd(src, from, run) {
  let j = from;
  while (j < src.length) {
    const k = src.indexOf('`', j);
    if (k < 0) return -1;
    let n = 0;
    while (src[k + n] === '`') n++;
    if (n === run) return k;
    j = k + n;
  }
  return -1;
}

function findClosingBracket(src, from) {
  let depth = 0;
  for (let j = from; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '[') depth++;
    else if (src[j] === ']') { if (depth === 0) return j; depth--; }
  }
  return -1;
}

// `(url "title")` starting at src[from] === '('. Returns { url, title, end } or null.
function parseLinkTarget(src, from) {
  if (src[from] !== '(') return null;
  const m = /^\(\s*(<[^>]*>|(?:[^\s()]|\([^\s()]*\))*)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)/.exec(src.slice(from));
  if (!m) return null;
  const url = m[1].startsWith('<') ? m[1].slice(1, -1) : m[1];
  return { url, title: m[2] ?? m[3] ?? null, end: from + m[0].length };
}

// Try emphasis at src[i] (a '*' or '_'). Returns { node, end } or null.
function parseEmphasis(src, i) {
  const ch = src[i];
  const prev = src[i - 1] ?? ' ';
  if (ch === '_' && /\w/.test(prev)) return null; // snake_case_word is not emphasis
  let run = 0;
  while (src[i + run] === ch) run++;
  const len = Math.min(run, 3);
  const delim = ch.repeat(len);
  if (/\s/.test(src[i + len] ?? ' ')) return null;
  for (let j = i + len; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (!src.startsWith(delim, j) || /\s/.test(src[j - 1])) continue;
    if (ch === '_' && /\w/.test(src[j + len] ?? ' ')) continue;
    const inner = parseInline(src.slice(i + len, j));
    let node;
    if (len === 3) node = { type: 'strong', children: [{ type: 'em', children: inner }] };
    else if (len === 2) node = { type: 'strong', children: inner };
    else node = { type: 'em', children: inner };
    return { node, end: j + len };
  }
  return null;
}

// Strikethrough: ~~text~~, the delimiters must hug the text (no whitespace just inside them).
function parseStrike(src, i) {
  if (/\s/.test(src[i + 2] ?? ' ')) return null;
  for (let j = i + 2; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src.startsWith('~~', j) && !/\s/.test(src[j - 1])) {
      return { node: { type: 'del', children: parseInline(src.slice(i + 2, j)) }, end: j + 2 };
    }
  }
  return null;
}

export function parseInline(src) {
  const nodes = [];
  let text = '';
  const flush = () => {
    if (text) nodes.push({ type: 'text', value: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      let run = 0;
      while (src[i + run] === '`') run++;
      const end = findCodeEnd(src, i + run, run);
      if (end > 0) {
        flush();
        nodes.push({ type: 'code', value: src.slice(i + run, end).replace(/^ (.*) $/, '$1') });
        i = end + run;
      } else {
        text += '`'.repeat(run);
        i += run;
      }
      continue;
    }
    if (ch === '!' && src[i + 1] === '[') {
      const close = findClosingBracket(src, i + 2);
      const target = close > 0 ? parseLinkTarget(src, close + 1) : null;
      if (target) {
        flush();
        nodes.push({ type: 'image', alt: src.slice(i + 2, close), src: target.url, title: target.title });
        i = target.end;
        continue;
      }
    }
    if (ch === '[') {
      const close = findClosingBracket(src, i + 1);
      const target = close > 0 ? parseLinkTarget(src, close + 1) : null;
      if (target) {
        flush();
        nodes.push({ type: 'link', href: target.url, title: target.title, children: parseInline(src.slice(i + 1, close)) });
        i = target.end;
        continue;
      }
    }
    if (ch === '<') {
      const m = /^<(https?:\/\/[^\s>]+)>/.exec(src.slice(i));
      if (m) {
        flush();
        nodes.push({ type: 'autolink', href: m[1] });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '~' && src[i + 1] === '~') {
      const strike = parseStrike(src, i);
      if (strike) {
        flush();
        nodes.push(strike.node);
        i = strike.end;
        continue;
      }
    }
    if (ch === '*' || ch === '_') {
      const em = parseEmphasis(src, i);
      if (em) {
        flush();
        nodes.push(em.node);
        i = em.end;
        continue;
      }
    }
    if (ch === '\n' && text.endsWith('  ')) {
      text = text.replace(/ +$/, '');
      flush();
      nodes.push({ type: 'linebreak' });
      i += 1;
      continue;
    }
    text += ch;
    i += 1;
  }
  flush();
  return nodes;
}
