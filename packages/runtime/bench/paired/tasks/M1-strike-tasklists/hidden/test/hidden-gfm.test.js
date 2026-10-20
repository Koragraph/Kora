import test from 'node:test';
import assert from 'node:assert/strict';
import { render, renderText } from '../src/index.js';

test('strikethrough', () => {
  assert.equal(render('~~gone~~'), '<p><del>gone</del></p>\n');
  assert.equal(render('a ~~b~~ c'), '<p>a <del>b</del> c</p>\n');
});

test('strikethrough nests with other inline markup', () => {
  assert.equal(render('~~a *b* **c**~~'), '<p><del>a <em>b</em> <strong>c</strong></del></p>\n');
  assert.equal(render('*x ~~y~~ z*'), '<p><em>x <del>y</del> z</em></p>\n');
  assert.equal(render('[~~old~~](/p)'), '<p><a href="/p"><del>old</del></a></p>\n');
});

test('strikethrough needs the delimiters to hug the text and a closing pair', () => {
  assert.equal(render('~~ spaced ~~'), '<p>~~ spaced ~~</p>\n');
  assert.equal(render('~~open'), '<p>~~open</p>\n');
  assert.equal(render('~single~'), '<p>~single~</p>\n');
});

test('an escaped tilde is literal and code spans keep tildes', () => {
  assert.equal(render('\\~~not~~'), '<p>~~not~~</p>\n');
  assert.equal(render('`~~x~~`'), '<p><code>~~x~~</code></p>\n');
});

test('tilde code fences still work', () => {
  assert.equal(render('~~~\n~~x~~\n~~~'), '<pre><code>~~x~~</code></pre>\n');
});

test('task list items', () => {
  assert.equal(
    render('- [ ] todo\n- [x] done\n- [X] also done\n- plain'),
    '<ul>\n<li><input type="checkbox" disabled> todo</li>\n<li><input type="checkbox" checked disabled> done</li>\n<li><input type="checkbox" checked disabled> also done</li>\n<li>plain</li>\n</ul>\n',
  );
});

test('task items keep inline markup, nesting and ordered lists', () => {
  assert.equal(
    render('1. [x] **ship** it\n   - [ ] nested ~~one~~'),
    '<ol>\n<li><input type="checkbox" checked disabled> <strong>ship</strong> it\n<ul>\n<li><input type="checkbox" disabled> nested <del>one</del></li>\n</ul>\n</li>\n</ol>\n',
  );
});

test('only a bracket pair followed by a space is a task marker', () => {
  assert.equal(render('- [x]no space\n- [] empty\n- [ab] other'), '<ul>\n<li>[x]no space</li>\n<li>[] empty</li>\n<li>[ab] other</li>\n</ul>\n');
});

test('the plain-text renderer drops the markup', () => {
  assert.equal(renderText('~~gone~~ stays'), 'gone stays\n');
});
