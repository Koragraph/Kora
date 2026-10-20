import test from 'node:test';
import assert from 'node:assert/strict';
import { capSize } from './bounded';

test('capSize: past max, the oldest entries go down to 3/4 of max; under max nothing moves', () => {
  const m = new Map<number, number>();
  for (let i = 0; i < 100; i++) { capSize(m, 100); m.set(i, i); }
  assert.equal(m.size, 100);
  capSize(m, 100); assert.equal(m.size, 100);
  m.set(100, 100); capSize(m, 100);
  assert.equal(m.size, 75); assert.equal([...m.keys()][0], 26); assert.ok(m.has(100));
  const s = new Set<string>(); for (let i = 0; i < 10_000; i++) { capSize(s, 50); s.add(String(i)); }
  assert.ok(s.size <= 51 && s.has('9999'));
});
