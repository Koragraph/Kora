import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextRun } from '../src/cron.js';

const at = (...parts) => Date.UTC(...parts);

test('parseCron expands steps, ranges and lists', () => {
  const [minutes, hours] = parseCron('*/20 9-11 * * *');
  assert.deepEqual([...minutes], [0, 20, 40]);
  assert.deepEqual([...hours], [9, 10, 11]);
  assert.deepEqual([...parseCron('0 0 1,15 * *')[2]], [1, 15]);
});

test('parseCron rejects bad input', () => {
  assert.throws(() => parseCron('* * * *'), /5 fields/);
  assert.throws(() => parseCron('61 * * * *'), /bad cron field/);
});

test('nextRun finds the next matching minute', () => {
  assert.equal(nextRun('30 * * * *', at(2025, 0, 1, 10, 31)), at(2025, 0, 1, 11, 30));
  assert.equal(nextRun('0 0 * * *', at(2025, 0, 1, 0, 0)), at(2025, 0, 2, 0, 0));
});

test('nextRun honours the weekday', () => {
  // 2025-01-01 is a Wednesday; next Monday is the 6th
  assert.equal(nextRun('0 9 * * 1', at(2025, 0, 1, 12, 0)), at(2025, 0, 6, 9, 0));
});
