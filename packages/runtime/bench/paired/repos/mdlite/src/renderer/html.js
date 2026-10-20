// HTML renderer. `renderHtml(blocks, options)` is the entry point; every node type has a renderer in RENDERERS.
// The second half of this file holds the helper renderers that plugins build nodes for (tables, footnotes,
// admonitions, definition lists, embeds, ...). They are reachable through RENDERERS as well.
import { escapeHtml, escapeAttr } from '../parser/escape.js';
import { plainText } from '../parser/utils.js';

// ---------------------------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------------------------

export function attrs(map = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(map)) {
    if (value === undefined || value === null || value === false) continue;
    if (value === true) parts.push(key);
    else parts.push(`${key}="${escapeAttr(value)}"`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

export function classNames(...names) {
  return names.flat().filter(Boolean).join(' ') || undefined;
}

export function tag(name, attributes, inner = '') {
  return `<${name}${attrs(attributes)}>${inner}</${name}>`;
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');
}

function renderChildren(children = [], ctx) {
  return children.map((node) => renderNode(node, ctx)).join('');
}

function renderBlocks(blocks = [], ctx) {
  return blocks.map((node) => renderNode(node, ctx)).join('');
}

export function renderNode(node, ctx) {
  const render = RENDERERS[node.type];
  if (!render) {
    if (ctx.strict) throw new Error(`no renderer for node type "${node.type}"`);
    return '';
  }
  return render(node, ctx);
}

// ---------------------------------------------------------------------------------------------------------------
// block renderers
// ---------------------------------------------------------------------------------------------------------------

function renderHeading(node, ctx) {
  const id = ctx.anchors ? slugify(plainText(node.children)) : undefined;
  return tag(`h${node.depth}`, { id }, renderChildren(node.children, ctx)) + '\n';
}

function renderParagraph(node, ctx) {
  return `<p>${renderChildren(node.children, ctx)}</p>\n`;
}

function renderFence(node) {
  const code = tag('code', { class: node.lang ? `language-${node.lang}` : undefined }, escapeHtml(node.value));
  return `<pre>${code}</pre>\n`;
}

function renderBlockquote(node, ctx) {
  return `<blockquote>\n${renderBlocks(node.children, ctx)}</blockquote>\n`;
}

function renderHr() {
  return '<hr>\n';
}

function renderList(node, ctx) {
  const name = node.ordered ? 'ol' : 'ul';
  const start = node.ordered && node.start !== 1 ? node.start : undefined;
  return `<${name}${attrs({ start })}>\n${node.items.map((item) => renderItem(item, ctx)).join('')}</${name}>\n`;
}

function renderItem(item, ctx) {
  const inline = renderChildren(item.children, ctx);
  if (!item.blocks || item.blocks.length === 0) return `<li>${inline}</li>\n`;
  return `<li>${inline}\n${renderBlocks(item.blocks, ctx)}</li>\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// inline renderers
// ---------------------------------------------------------------------------------------------------------------

function renderText(node) {
  return escapeHtml(node.value);
}

function renderCode(node) {
  return `<code>${escapeHtml(node.value)}</code>`;
}

function renderEm(node, ctx) {
  return `<em>${renderChildren(node.children, ctx)}</em>`;
}

function renderStrong(node, ctx) {
  return `<strong>${renderChildren(node.children, ctx)}</strong>`;
}

function renderLinebreak() {
  return '<br>\n';
}

function renderLink(node, ctx) {
  const href = sanitizeUrl(node.href);
  return tag('a', { href, title: node.title }, renderChildren(node.children, ctx));
}

function renderAutolink(node) {
  const href = sanitizeUrl(node.href);
  return tag('a', { href }, escapeHtml(node.href));
}

function renderImage(node) {
  return `<img${attrs({ src: sanitizeUrl(node.src), alt: node.alt, title: node.title })}>`;
}

// ---------------------------------------------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------------------------------------------

const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

// URLs that come from the document are untrusted. Returns the URL, or '#' when it is not allowed:
//  - control characters and whitespace inside the URL are ignored when looking for a scheme
//    (browsers do the same, so "java\tscript:" is still javascript:)
//  - a URL with a scheme must be on the allow-list
//  - a URL without a scheme is relative and passes
export function sanitizeUrl(raw, { allowRelative = true } = {}) {
  const trimmed = String(raw).trim();
  const compact = trimmed.replace(/[\u0000-\u001f\u007f\s]+/g, '');
  if (compact === '') return '#';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  if (!scheme) return allowRelative ? trimmed : '#';
  return SAFE_PROTOCOLS.has(scheme[1].toLowerCase() + ':') ? trimmed : '#';
}

export function isExternalUrl(url) {
  return /^https?:\/\//i.test(url);
}

export function externalLinkAttrs(url, ctx) {
  if (!ctx.externalLinksInNewTab || !isExternalUrl(url)) return {};
  return { target: '_blank', rel: 'noopener noreferrer' };
}

// ---------------------------------------------------------------------------------------------------------------
// helper renderers for plugin-built nodes
// ---------------------------------------------------------------------------------------------------------------

function renderTable(node, ctx) {
  const align = (i) => (node.align?.[i] ? { style: `text-align:${node.align[i]}` } : {});
  const head = node.head.map((cell, i) => tag('th', align(i), renderChildren(cell, ctx))).join('');
  const rows = node.rows
    .map((row) => `<tr>${row.map((cell, i) => tag('td', align(i), renderChildren(cell, ctx))).join('')}</tr>\n`)
    .join('');
  return `<table>\n<thead>\n<tr>${head}</tr>\n</thead>\n<tbody>\n${rows}</tbody>\n</table>\n`;
}

function renderFootnoteRef(node) {
  const n = escapeHtml(node.label);
  return `<sup${attrs({ class: 'footnote-ref' })}><a href="#fn-${n}" id="fnref-${n}">${n}</a></sup>`;
}

function renderFootnotes(node, ctx) {
  const items = node.notes
    .map((note) => {
      const n = escapeHtml(note.label);
      return `<li id="fn-${n}">${renderChildren(note.children, ctx)} <a href="#fnref-${n}" class="footnote-back">↩</a></li>\n`;
    })
    .join('');
  return `<section class="footnotes">\n<ol>\n${items}</ol>\n</section>\n`;
}

const ADMONITION_KINDS = new Set(['note', 'tip', 'warning', 'danger', 'info']);

function renderAdmonition(node, ctx) {
  const kind = ADMONITION_KINDS.has(node.kind) ? node.kind : 'note';
  const title = node.title ?? kind[0].toUpperCase() + kind.slice(1);
  return `<aside${attrs({ class: classNames('admonition', kind) })}>\n<p class="admonition-title">${escapeHtml(title)}</p>\n${renderBlocks(node.children, ctx)}</aside>\n`;
}

function renderDefinitionList(node, ctx) {
  const body = node.entries
    .map((entry) => `<dt>${renderChildren(entry.term, ctx)}</dt>\n${entry.definitions.map((d) => `<dd>${renderChildren(d, ctx)}</dd>\n`).join('')}`)
    .join('');
  return `<dl>\n${body}</dl>\n`;
}

function renderDetails(node, ctx) {
  const open = node.open ? ' open' : '';
  return `<details${open}>\n<summary>${renderChildren(node.summary, ctx)}</summary>\n${renderBlocks(node.children, ctx)}</details>\n`;
}

function renderMathInline(node) {
  return `<span class="math inline">\\(${escapeHtml(node.value)}\\)</span>`;
}

function renderMathBlock(node) {
  return `<div class="math display">\\[${escapeHtml(node.value)}\\]</div>\n`;
}

const EMBED_PROVIDERS = {
  youtube: (id) => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`,
  vimeo: (id) => `https://player.vimeo.com/video/${encodeURIComponent(id)}`,
};

function renderEmbed(node) {
  const build = EMBED_PROVIDERS[node.provider];
  if (!build) return '';
  const src = sanitizeUrl(build(node.id), { allowRelative: false });
  if (src === '#') return '';
  return `<iframe${attrs({ src, width: node.width ?? 560, height: node.height ?? 315, allowfullscreen: true, loading: 'lazy' })}></iframe>\n`;
}

function renderBadge(node) {
  return tag('span', { class: classNames('badge', node.tone && `badge-${node.tone}`) }, escapeHtml(node.label));
}

function renderKbd(node) {
  return node.keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('+');
}

function renderMark(node, ctx) {
  return `<mark>${renderChildren(node.children, ctx)}</mark>`;
}

function renderSub(node, ctx) {
  return `<sub>${renderChildren(node.children, ctx)}</sub>`;
}

function renderSup(node, ctx) {
  return `<sup>${renderChildren(node.children, ctx)}</sup>`;
}

function renderAbbr(node) {
  return tag('abbr', { title: node.title }, escapeHtml(node.text));
}

function renderFigure(node, ctx) {
  const caption = node.caption ? `<figcaption>${renderChildren(node.caption, ctx)}</figcaption>\n` : '';
  return `<figure>\n${renderBlocks(node.children, ctx)}${caption}</figure>\n`;
}

function renderRawText(node) {
  return escapeHtml(node.value) + '\n';
}

function renderComment(node) {
  return node.keep === true ? `<!-- ${String(node.value).replace(/--+/g, '-')} -->\n` : '';
}

function renderToc(node) {
  const min = node.min ?? 1;
  const max = node.max ?? 6;
  const headings = node.headings.filter((h) => h.depth >= min && h.depth <= max);
  if (headings.length === 0) return '';
  const base = Math.min(...headings.map((h) => h.depth));
  let html = '<nav class="toc">\n';
  let depth = base - 1;
  for (const h of headings) {
    while (depth < h.depth) { html += '<ul>\n'; depth++; }
    while (depth > h.depth) { html += '</ul>\n'; depth--; }
    html += `<li><a href="#${escapeAttr(h.id)}">${escapeHtml(h.text)}</a></li>\n`;
  }
  while (depth >= base) { html += '</ul>\n'; depth--; }
  return html + '</nav>\n';
}

function renderTimestamp(node) {
  const date = new Date(node.iso);
  if (Number.isNaN(date.getTime())) return escapeHtml(node.iso);
  return `<time datetime="${date.toISOString()}">${escapeHtml(node.label ?? date.toISOString().slice(0, 10))}</time>`;
}

function renderMention(node, ctx) {
  const base = ctx.mentionBase ?? '/users/';
  return tag('a', { href: sanitizeUrl(base + encodeURIComponent(node.name)), class: 'mention' }, '@' + escapeHtml(node.name));
}

function renderHashtag(node, ctx) {
  const base = ctx.tagBase ?? '/tags/';
  return tag('a', { href: sanitizeUrl(base + encodeURIComponent(node.name)), class: 'hashtag' }, '#' + escapeHtml(node.name));
}

function renderEmoji(node) {
  const known = { smile: '😄', tada: '🎉', warning: '⚠️', check: '✅', x: '❌', rocket: '🚀' };
  return known[node.name] ?? `:${escapeHtml(node.name)}:`;
}

function renderProgress(node) {
  const value = Math.max(0, Math.min(100, Number(node.value) || 0));
  return `<progress${attrs({ max: 100, value })}>${value}%</progress>`;
}

function renderCallout(node, ctx) {
  return `<div${attrs({ class: classNames('callout', node.tone) })}>\n${renderBlocks(node.children, ctx)}</div>\n`;
}

function renderColumns(node, ctx) {
  const cols = node.columns.map((blocks) => `<div class="column">\n${renderBlocks(blocks, ctx)}</div>\n`).join('');
  return `<div class="columns columns-${node.columns.length}">\n${cols}</div>\n`;
}

function renderTabs(node, ctx) {
  const tabs = node.tabs.map((t, i) => `<button${attrs({ role: 'tab', 'aria-selected': i === 0 })}>${escapeHtml(t.title)}</button>`).join('');
  const panels = node.tabs.map((t, i) => `<div${attrs({ role: 'tabpanel', hidden: i !== 0 })}>\n${renderBlocks(t.children, ctx)}</div>\n`).join('');
  return `<div class="tabs">\n<div role="tablist">${tabs}</div>\n${panels}</div>\n`;
}

function renderCodeGroup(node) {
  const blocks = node.blocks.map((b) => `<pre><code${attrs({ class: b.lang ? `language-${b.lang}` : undefined, 'data-title': b.title })}>${escapeHtml(b.value)}</code></pre>\n`).join('');
  return `<div class="code-group">\n${blocks}</div>\n`;
}

function renderDiff(node) {
  const lines = String(node.value).split('\n').map((line) => {
    const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
    return `<span class="diff-${kind}">${escapeHtml(line)}</span>`;
  });
  return `<pre class="diff"><code>${lines.join('\n')}</code></pre>\n`;
}

function renderCsvTable(node, ctx) {
  const rows = String(node.value).trim().split('\n').map((l) => l.split(',').map((c) => [{ type: 'text', value: c.trim() }]));
  return renderTable({ head: rows[0] ?? [], rows: rows.slice(1), align: node.align }, ctx);
}

function renderQuoteCite(node, ctx) {
  const cite = node.cite ? `<footer>— ${escapeHtml(node.cite)}</footer>\n` : '';
  return `<blockquote class="cited">\n${renderBlocks(node.children, ctx)}${cite}</blockquote>\n`;
}

function renderHeadingAnchorLink(node, ctx) {
  const id = slugify(plainText(node.children));
  const link = `<a class="anchor" href="#${escapeAttr(id)}" aria-label="Link to this section">#</a>`;
  return tag(`h${node.depth}`, { id }, renderChildren(node.children, ctx) + ' ' + link) + '\n';
}

function renderSpoiler(node, ctx) {
  return `<span class="spoiler" tabindex="0">${renderChildren(node.children, ctx)}</span>`;
}

function renderRuby(node) {
  return `<ruby>${escapeHtml(node.base)}<rp>(</rp><rt>${escapeHtml(node.reading)}</rt><rp>)</rp></ruby>`;
}

function renderPageBreak() {
  return '<div class="page-break" style="page-break-after:always"></div>\n';
}

function renderLineNumbers(node) {
  const numbered = String(node.value).split('\n').map((line, i) => `<span class="ln">${i + 1}</span>${escapeHtml(line)}`);
  return `<pre class="numbered"><code>${numbered.join('\n')}</code></pre>\n`;
}

function renderDefinitionAbbrList(node) {
  const rows = Object.entries(node.entries).map(([abbr, title]) => `<dt><abbr title="${escapeAttr(title)}">${escapeHtml(abbr)}</abbr></dt>\n<dd>${escapeHtml(title)}</dd>\n`);
  return `<dl class="abbr-list">\n${rows.join('')}</dl>\n`;
}

function renderBreadcrumbs(node) {
  const items = node.items.map((item, i) => {
    const last = i === node.items.length - 1;
    return last ? `<li aria-current="page">${escapeHtml(item.label)}</li>` : `<li><a href="${escapeAttr(sanitizeUrl(item.href))}">${escapeHtml(item.label)}</a></li>`;
  });
  return `<nav aria-label="Breadcrumb"><ol class="breadcrumbs">${items.join('')}</ol></nav>\n`;
}

function renderPagination(node) {
  const prev = node.prev ? `<a rel="prev" href="${escapeAttr(sanitizeUrl(node.prev.href))}">${escapeHtml(node.prev.label)}</a>` : '';
  const next = node.next ? `<a rel="next" href="${escapeAttr(sanitizeUrl(node.next.href))}">${escapeHtml(node.next.label)}</a>` : '';
  return `<nav class="pagination">${prev}${next}</nav>\n`;
}

function renderAuthorByline(node) {
  const when = node.date ? ` <time datetime="${escapeAttr(node.date)}">${escapeHtml(node.date)}</time>` : '';
  return `<p class="byline">By ${escapeHtml(node.author)}${when}</p>\n`;
}

function renderReadingTime(node) {
  const words = Number(node.words) || 0;
  const minutes = Math.max(1, Math.round(words / (node.wpm ?? 200)));
  return `<span class="reading-time">${minutes} min read</span>`;
}

function renderLicense(node) {
  const href = sanitizeUrl(node.url ?? '#');
  return `<p class="license">Licensed under <a${attrs({ href, rel: 'license' })}>${escapeHtml(node.name)}</a></p>\n`;
}

function renderStatusPill(node) {
  const tone = { ok: 'green', warn: 'amber', fail: 'red' }[node.status] ?? 'grey';
  return `<span class="pill pill-${tone}">${escapeHtml(node.status)}</span>`;
}

function renderChangelogEntry(node, ctx) {
  const changes = node.changes.map((c) => `<li><strong>${escapeHtml(c.kind)}</strong> ${renderChildren(c.children, ctx)}</li>\n`).join('');
  return `<section class="changelog-entry">\n<h3>${escapeHtml(node.version)} <small>${escapeHtml(node.date ?? '')}</small></h3>\n<ul>\n${changes}</ul>\n</section>\n`;
}

function renderGlossaryTerm(node) {
  return `<dfn${attrs({ id: `term-${slugify(node.term)}` })}>${escapeHtml(node.term)}</dfn>`;
}

function renderCitation(node) {
  return `<cite>${escapeHtml(node.text)}</cite>`;
}

function renderRedacted(node) {
  return `<span class="redacted" aria-label="redacted">${'█'.repeat(Math.max(3, String(node.value).length))}</span>`;
}

// ---------------------------------------------------------------------------------------------------------------
// dispatch table and entry point
// ---------------------------------------------------------------------------------------------------------------

export const RENDERERS = {
  heading: renderHeading,
  'heading-anchored': renderHeadingAnchorLink,
  paragraph: renderParagraph,
  fence: renderFence,
  blockquote: renderBlockquote,
  hr: renderHr,
  list: renderList,
  item: renderItem,
  text: renderText,
  code: renderCode,
  em: renderEm,
  strong: renderStrong,
  linebreak: renderLinebreak,
  link: renderLink,
  autolink: renderAutolink,
  image: renderImage,
  table: renderTable,
  'footnote-ref': renderFootnoteRef,
  footnotes: renderFootnotes,
  admonition: renderAdmonition,
  'definition-list': renderDefinitionList,
  details: renderDetails,
  'math-inline': renderMathInline,
  'math-block': renderMathBlock,
  embed: renderEmbed,
  badge: renderBadge,
  kbd: renderKbd,
  mark: renderMark,
  sub: renderSub,
  sup: renderSup,
  abbr: renderAbbr,
  figure: renderFigure,
  raw: renderRawText,
  comment: renderComment,
  toc: renderToc,
  timestamp: renderTimestamp,
  mention: renderMention,
  hashtag: renderHashtag,
  emoji: renderEmoji,
  progress: renderProgress,
  callout: renderCallout,
  columns: renderColumns,
  tabs: renderTabs,
  'code-group': renderCodeGroup,
  diff: renderDiff,
  'csv-table': renderCsvTable,
  'quote-cite': renderQuoteCite,
  spoiler: renderSpoiler,
  ruby: renderRuby,
  'page-break': renderPageBreak,
  'line-numbers': renderLineNumbers,
  'abbr-list': renderDefinitionAbbrList,
  breadcrumbs: renderBreadcrumbs,
  pagination: renderPagination,
  byline: renderAuthorByline,
  'reading-time': renderReadingTime,
  license: renderLicense,
  'status-pill': renderStatusPill,
  'changelog-entry': renderChangelogEntry,
  'glossary-term': renderGlossaryTerm,
  citation: renderCitation,
  redacted: renderRedacted,
};

export function renderHtml(blocks, options = {}) {
  const ctx = { anchors: false, strict: false, ...options };
  return renderBlocks(blocks, ctx);
}
