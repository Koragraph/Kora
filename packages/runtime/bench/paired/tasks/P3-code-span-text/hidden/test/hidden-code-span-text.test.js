import test from 'node:test';
import assert from 'node:assert/strict';
import { render, renderText, anchorPlugin, tocPlugin } from '../src/index.js';
import { run } from '../src/cli.js';
import { plainText } from '../src/parser/utils.js';
import { parseInline } from '../src/parser/inline.js';

test('plain text output keeps inline code, spaces inside the span included', () => {
  assert.equal(renderText('Run `npm test` now'), 'Run npm test now\n');
  assert.equal(renderText('a `x  y` b'), 'a x  y b\n');
  assert.equal(renderText('use `a   b`'), 'use a   b\n');
});

test('plain text keeps inline code nested in emphasis, links and list items', () => {
  assert.equal(renderText('*see `a  b`*'), 'see a  b\n');
  assert.equal(renderText('[`fs  x`](https://x.y)'), 'fs  x\n');
  assert.equal(renderText('- run `a  b`\n- b'), '* run a  b\n* b\n');
});

test('plain text of ordinary text is untouched', () => {
  assert.equal(renderText('one  two'), 'one  two\n');
  assert.equal(renderText('Some **bold** text'), 'Some bold text\n');
});

test('the cli --text flag shows inline code', () => {
  assert.equal(run(['--text', 'x.md'], () => 'call `go  now`'), 'call go  now\n');
});

test('toc entries keep inline code, spaces inside the span included', () => {
  const html = render('# The `init` command\n\n## Use `a  b` here\n', { plugins: [tocPlugin()] });
  assert.match(html, /<li><a href="#the-init-command">The init command<\/a><\/li>/);
  assert.match(html, /<li><a href="#use-a-b-here">Use a  b here<\/a><\/li>/);
});

test('toc entries keep inline code in nested emphasis', () => {
  const html = render('# Using *the `x`  flag*\n', { plugins: [tocPlugin()] });
  assert.match(html, /<a href="#using-the-x-flag">Using the x  flag<\/a>/);
});

test('heading ids and anchors keep inline code', () => {
  assert.match(render('## Using `fs` safely\n', { anchors: true }), /<h2 id="using-fs-safely">/);
  const html = render('# The `init` command\n', { plugins: [anchorPlugin] });
  assert.match(html, /<h1 id="the-init-command">/);
  assert.match(html, /href="#the-init-command"/);
});

test('toc with anchors links to the same ids as the headings', () => {
  const html = render('# A `b` c\n', { plugins: [anchorPlugin, tocPlugin()] });
  assert.match(html, /<a href="#a-b-c">A b c<\/a>/);
  assert.match(html, /<h1 id="a-b-c">/);
});

test('plainText of inline nodes includes code values', () => {
  assert.equal(plainText(parseInline('a `b  c` d')), 'a b  c d');
});
