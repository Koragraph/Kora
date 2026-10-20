// ghost-text: Claude Code's grey suggested prompt on an empty input line is not text anyone typed.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Cell } from '../protocol/types';
import { promptLineWithoutGhost, isGreyFg } from './ghost-text';

const DIM = 16, INV = 8;
const cells = (s: string, style: (i: number) => Partial<Cell> = () => ({})): Cell[] => Array.from(s).map((ch, i) => ({ ch, fg: -1, bg: -1, attrs: 0, ...style(i) }));

test('dim / grey suggestion after the prompt marker is blanked; the cursor cell on it goes too', () => {
  const s = '│ > Save this as a research file │';
  const start = s.indexOf('Save'), end = s.indexOf(' │', start);
  const row = cells(s, (i) => (i === start ? { attrs: INV } : i > start && i < end ? { attrs: DIM } : {}));
  assert.equal(promptLineWithoutGhost(row)!.replace(/\s+/g, ' '), '│ > │');
  const grey = cells('> run the tests', (i) => (i >= 2 ? { fg: 0x1000000 | (0x80 << 16) | (0x80 << 8) | 0x80 } : {}));
  assert.equal(promptLineWithoutGhost(grey), '>');
});

test('typed (default-colour) input and non-prompt lines are left alone', () => {
  assert.equal(promptLineWithoutGhost(cells('> fix the build')), null);
  assert.equal(promptLineWithoutGhost(cells('⏺ grey reply text', () => ({ attrs: DIM }))), null);
});

test('grey detection', () => {
  assert.ok(isGreyFg(8));
  assert.ok(isGreyFg(244));
  assert.ok(!isGreyFg(-1));
  assert.ok(!isGreyFg(2));
  assert.ok(!isGreyFg(0x1000000 | 0xf2f2f4)); // near-white text is typed, not ghost
});
