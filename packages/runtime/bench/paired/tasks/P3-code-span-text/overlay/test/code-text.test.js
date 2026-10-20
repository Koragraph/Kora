import test from 'node:test';
import assert from 'node:assert/strict';
import { render, renderText, tocPlugin } from '../src/index.js';

test('plain text keeps inline code', () => {
  assert.equal(renderText('Run `npm test` now'), 'Run npm test now\n');
});

test('toc entries keep inline code in the heading text', () => {
  const html = render('# The `init` command\n', { plugins: [tocPlugin()] });
  assert.match(html, /<li><a href="#the-init-command">The init command<\/a><\/li>/);
});

test('heading ids keep inline code', () => {
  assert.match(render('## Using `fs` safely\n', { anchors: true }), /<h2 id="using-fs-safely">/);
});
