import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeUrl, slugify, renderHtml, attrs, RENDERERS } from '../src/renderer/html.js';
import { render } from '../src/index.js';

test('sanitizeUrl keeps http, https and relative URLs', () => {
  assert.equal(sanitizeUrl('https://a.b/c?d=1'), 'https://a.b/c?d=1');
  assert.equal(sanitizeUrl('http://a.b'), 'http://a.b');
  assert.equal(sanitizeUrl('/docs/x.md'), '/docs/x.md');
  assert.equal(sanitizeUrl('#section'), '#section');
});

test('sanitizeUrl blocks script-like schemes, however they are written', () => {
  assert.equal(sanitizeUrl('javascript:alert(1)'), '#');
  assert.equal(sanitizeUrl('JaVaScRiPt:alert(1)'), '#');
  assert.equal(sanitizeUrl(' java\tscript:alert(1)'), '#');
  assert.equal(sanitizeUrl('data:text/html,hi'), '#');
  assert.equal(sanitizeUrl('vbscript:x'), '#');
});

test('sanitizeUrl turns an empty URL into #', () => {
  assert.equal(sanitizeUrl('   '), '#');
});

test('links and images go through sanitizeUrl', () => {
  assert.equal(render('[x](javascript:alert(1))'), '<p><a href="#">x</a></p>\n');
  assert.equal(render('![x](data:image/png;base64,AAAA)'), '<p><img src="#" alt="x"></p>\n');
});

test('slugify', () => {
  assert.equal(slugify('Hello, World! Ünïcode  text'), 'hello-world-unicode-text');
});

test('attrs skips empty values and escapes', () => {
  assert.equal(attrs({ a: 'x"y', b: undefined, c: true, d: false }), ' a="x&quot;y" c');
});

test('anchored headings get ids', () => {
  assert.equal(render('# Hello World', { anchors: true }), '<h1 id="hello-world">Hello World</h1>\n');
});

test('helper renderers: admonition and table', () => {
  const html = renderHtml([{ type: 'admonition', kind: 'tip', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'hi' }] }] }]);
  assert.equal(html, '<aside class="admonition tip">\n<p class="admonition-title">Tip</p>\n<p>hi</p>\n</aside>\n');
  assert.ok(RENDERERS.table);
});

test('helper renderers: toc nests lists', () => {
  const html = renderHtml([{ type: 'toc', headings: [{ depth: 1, text: 'A', id: 'a' }, { depth: 2, text: 'B', id: 'b' }] }]);
  assert.equal(html, '<nav class="toc">\n<ul>\n<li><a href="#a">A</a></li>\n<ul>\n<li><a href="#b">B</a></li>\n</ul>\n</ul>\n</nav>\n');
});
