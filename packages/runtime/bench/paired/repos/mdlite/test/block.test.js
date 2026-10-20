import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/index.js';

test('atx headings', () => {
  assert.equal(render('# One\n\n### Three ###'), '<h1>One</h1>\n<h3>Three</h3>\n');
});

test('setext headings', () => {
  assert.equal(render('Title\n=====\n\nSub\n---'), '<h1>Title</h1>\n<h2>Sub</h2>\n');
});

test('paragraphs keep soft line breaks', () => {
  assert.equal(render('one\ntwo\n\nthree'), '<p>one\ntwo</p>\n<p>three</p>\n');
});

test('fenced code with a language', () => {
  assert.equal(render('```js\nconst a = 1 < 2;\n```'), '<pre><code class="language-js">const a = 1 &lt; 2;</code></pre>\n');
});

test('tilde fences work too and keep blank lines', () => {
  assert.equal(render('~~~\na\n\nb\n~~~'), '<pre><code>a\n\nb</code></pre>\n');
});

test('block quotes nest blocks', () => {
  assert.equal(render('> # Q\n> text'), '<blockquote>\n<h1>Q</h1>\n<p>text</p>\n</blockquote>\n');
});

test('horizontal rules', () => {
  assert.equal(render('a\n\n***\n\nb'), '<p>a</p>\n<hr>\n<p>b</p>\n');
});

test('raw html is escaped', () => {
  assert.equal(render('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n');
});

test('windows line endings are normalised', () => {
  assert.equal(render('a\r\n\r\nb'), '<p>a</p>\n<p>b</p>\n');
});
