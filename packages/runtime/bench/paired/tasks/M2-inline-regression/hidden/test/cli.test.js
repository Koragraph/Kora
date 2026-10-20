import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/cli.js';

const read = () => '# Hi\n\ntext *x*';

test('cli renders html by default', () => {
  assert.equal(run(['doc.md'], read), '<h1>Hi</h1>\n<p>text <em>x</em></p>\n');
});

test('cli --text renders plain text', () => {
  assert.match(run(['--text', 'doc.md'], read), /^Hi\n==/);
});

test('cli --toc adds a table of contents', () => {
  assert.match(run(['--toc', 'doc.md'], read), /^<nav class="toc">/);
});

test('cli needs exactly one file', () => {
  assert.throws(() => run([], read), /usage/);
});
