import test from 'node:test';
import assert from 'node:assert/strict';
import { advisorUsageOf } from './cost-log';

test('advisorUsageOf: sums the advisor_message iterations (not in the top-level usage); null when no consult ran', () => {
  // The shape of a real Sonnet 5.5 call with an Opus 5.5 advisor (2026-10-16, Claude Code 2.1.301).
  const u = {
    input_tokens: 4, cache_creation_input_tokens: 12092, cache_read_input_tokens: 34006, output_tokens: 148,
    iterations: [
      { type: 'message', input_tokens: 2, output_tokens: 26, cache_read_input_tokens: 11092, cache_creation_input_tokens: 11822 },
      { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 24494, output_tokens: 430, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: 'message', input_tokens: 2, output_tokens: 122, cache_read_input_tokens: 22914, cache_creation_input_tokens: 270 },
    ],
  };
  assert.deepEqual(advisorUsageOf(u), { model: 'claude-opus-5-5', in: 24494, cr: 0, cc: 0, out: 430 });
  assert.equal(advisorUsageOf({ input_tokens: 1, iterations: [{ type: 'message', input_tokens: 1 }] }), null);
  assert.equal(advisorUsageOf({ input_tokens: 1 }), null);
  assert.equal(advisorUsageOf(undefined), null);
});
