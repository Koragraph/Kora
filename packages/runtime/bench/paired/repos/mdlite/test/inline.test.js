import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInline } from '../src/parser/inline.js';
import { renderHtml } from '../src/renderer/html.js';

const html = (src) => renderHtml([{ type: 'paragraph', children: parseInline(src) }]).replace(/^<p>|<\/p>\n$/g, '');

test('plain text is escaped', () => {
  assert.equal(html('a < b & c'), 'a &lt; b &amp; c');
});

test('emphasis with asterisks and underscores', () => {
  assert.equal(html('*one* and _two_'), '<em>one</em> and <em>two</em>');
});

test('strong', () => {
  assert.equal(html('**bold**'), '<strong>bold</strong>');
});

test('strong and emphasis together nest as strong > em', () => {
  assert.equal(html('***both***'), '<strong><em>both</em></strong>');
});

test('emphasis inside strong', () => {
  assert.equal(html('**bold *and* more**'), '<strong>bold <em>and</em> more</strong>');
});

test('underscores inside words are literal', () => {
  assert.equal(html('use snake_case_names here'), 'use snake_case_names here');
});

test('a backslash escapes the delimiter', () => {
  assert.equal(html('\\*not em\\*'), '*not em*');
});

test('inline code keeps its content literal', () => {
  assert.equal(html('`a *b* <c>`'), '<code>a *b* &lt;c&gt;</code>');
});

test('double backtick code can contain a backtick', () => {
  assert.equal(html('``a ` b``'), '<code>a ` b</code>');
});

test('links with and without titles', () => {
  assert.equal(html('[x](https://a.b)'), '<a href="https://a.b">x</a>');
  assert.equal(html('[x](https://a.b "T")'), '<a href="https://a.b" title="T">x</a>');
});

test('link text can contain emphasis', () => {
  assert.equal(html('[*x*](/p)'), '<a href="/p"><em>x</em></a>');
});

test('images', () => {
  assert.equal(html('![alt text](/i.png)'), '<img src="/i.png" alt="alt text">');
});

test('autolinks', () => {
  assert.equal(html('<https://a.b/c>'), '<a href="https://a.b/c">https://a.b/c</a>');
});

test('hard line break needs two trailing spaces', () => {
  assert.equal(html('a  \nb'), 'a<br>\nb');
  assert.equal(html('a\nb'), 'a\nb');
});

test('unclosed delimiters stay literal', () => {
  assert.equal(html('2 * 3 and **open'), '2 * 3 and **open');
});
