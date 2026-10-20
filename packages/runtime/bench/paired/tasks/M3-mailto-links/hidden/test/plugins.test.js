import test from 'node:test';
import assert from 'node:assert/strict';
import { render, renderText, anchorPlugin, tocPlugin } from '../src/index.js';

const doc = '# Intro\n\ntext\n\n## Setup\n\n## Setup\n';

test('anchor plugin links headings and de-duplicates slugs', () => {
  const html = render(doc, { plugins: [anchorPlugin] });
  assert.match(html, /<h2 id="setup">Setup <a class="anchor" href="#setup"/);
});

test('toc plugin lists the headings', () => {
  const html = render(doc, { plugins: [tocPlugin()] });
  assert.match(html, /^<nav class="toc">/);
  assert.match(html, /<li><a href="#intro">Intro<\/a><\/li>/);
});

test('plain text renderer', () => {
  assert.equal(renderText('# Title\n\nSome **bold** text\n\n- a\n- b'), 'Title\n=====\n\nSome bold text\n\n* a\n* b\n');
});
