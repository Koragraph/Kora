import test from 'node:test';
import assert from 'node:assert/strict';
import { markUnsentInput } from './screen-input';

test('greyed suggestion text after the live ❯ prompt is marked, not reported as typed', () => {
  const screen = ['● Done: 3 files changed.', '', '╭──────────────────────╮', '│ ❯ run the tests again │', '╰──────────────────────╯', '  ? for shortcuts'].join('\n');
  const out = markUnsentInput(screen);
  assert.match(out, /❯ ⟨unsent input-box text, not a user message/);
  assert.match(out, /run the tests again/, 'the text is kept, labelled');
  assert.equal(out.split('\n').length, 6);
});

test('an empty prompt and older ❯ rows (submitted prompts in the scrollback) are untouched', () => {
  const empty = ['● ok', '❯', '  ? for shortcuts'].join('\n');
  assert.equal(markUnsentInput(empty), empty);
  const old = ['❯ fix the bug', '● fixed', '', 'a', 'b', 'c', 'd', 'e', 'f', '❯'].join('\n');
  assert.equal(markUnsentInput(old), old, 'a submitted prompt far above the box is not an input box');
});

test('only the last ❯ row is marked', () => {
  const s = ['❯ first', '● x', '❯ suggestion', '  hint'].join('\n');
  const out = markUnsentInput(s).split('\n');
  assert.equal(out[0], '❯ first');
  assert.match(out[2]!, /unsent input-box text/);
});
