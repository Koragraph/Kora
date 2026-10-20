import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetryBook, retryDelayMs } from './ingest-retry';

test('backoff doubles from 5 min to a 6 h cap', () => {
  assert.deepEqual([1, 2, 3, 4, 10].map((n) => retryDelayMs(n) / 60_000), [5, 10, 20, 40, 360]);
});

test('turns wait their turn, back off per failure, and are dropped after the attempt cap', () => {
  const b = new RetryBook<string>([], { maxAttempts: 3 });
  let t = 0;
  const e = b.add('turn-1', t);
  assert.deepEqual(b.due(t), [], 'not due yet');
  t += 5 * 60_000;
  assert.equal(b.due(t).length, 1);
  assert.equal(b.failed(e, t), 'retry');
  assert.equal(e.nextAt - t, 10 * 60_000);
  t += 10 * 60_000;
  assert.equal(b.failed(e, t), 'retry');
  t += 20 * 60_000;
  assert.equal(b.failed(e, t), 'dropped');
  assert.equal(b.size, 0);
});

test('bounded: the oldest entries go first; an extractor gate holds everything back; done removes', () => {
  const b = new RetryBook<number>([], { max: 3 });
  for (let i = 0; i < 6; i++) b.add(i, 0);
  assert.deepEqual(b.all().map((e) => e.item), [3, 4, 5]);
  const t = 6 * 60_000;
  assert.equal(b.due(t, 2).length, 2, 'limit');
  assert.deepEqual(b.due(t, 5, t + 1), [], 'the extractor said "not before t+1"');
  const first = b.due(t)[0]!;
  b.done(first);
  assert.equal(b.size, 2);
});
