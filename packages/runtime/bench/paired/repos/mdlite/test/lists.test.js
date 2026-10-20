import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/index.js';

test('bullet list', () => {
  assert.equal(render('- a\n- b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n');
});

test('ordered list keeps its start number', () => {
  assert.equal(render('3. c\n4. d'), '<ol start="3">\n<li>c</li>\n<li>d</li>\n</ol>\n');
  assert.equal(render('1. a\n2. b'), '<ol>\n<li>a</li>\n<li>b</li>\n</ol>\n');
});

test('nested lists', () => {
  assert.equal(render('- a\n  - a1\n  - a2\n- b'), '<ul>\n<li>a\n<ul>\n<li>a1</li>\n<li>a2</li>\n</ul>\n</li>\n<li>b</li>\n</ul>\n');
});

test('items can hold inline markup', () => {
  assert.equal(render('* **x** and `y`'), '<ul>\n<li><strong>x</strong> and <code>y</code></li>\n</ul>\n');
});

test('a different marker type starts a new list', () => {
  assert.equal(render('- a\n1. b'), '<ul>\n<li>a</li>\n</ul>\n<ol>\n<li>b</li>\n</ol>\n');
});
