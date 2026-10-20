// error-stall: detect a worker stopped on a transient API error (transcript first, screen fallback) and the retry cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transientErrorText, retryableErrorText, errorStallFromScreen, errorStallFromTranscript, detectErrorStall, nextErrorStall } from './error-stall';

test('transient vs permanent error lines', () => {
  assert.equal(transientErrorText('⎿ API Error: The response stopped arriving'), 'API Error: The response stopped arriving');
  assert.ok(transientErrorText('API Error: 529 Overloaded'));
  assert.ok(transientErrorText('API Error: Connection to the API was lost (ECONNRESET)'));
  assert.ok(transientErrorText("API Error: Can't reach the API server (ENOTFOUND)"));
  assert.equal(transientErrorText('API Error: 429 rate limit exceeded'), null);
  assert.equal(transientErrorText('API Error: Self-signed certificate'), null);
  assert.equal(transientErrorText('Claude usage limit reached'), null);
});

test('a 4xx counts only as a status code, not as any number in the text', () => {
  assert.ok(transientErrorText('API Error: 500 Internal server error (request took 450 ms)'));
  assert.equal(transientErrorText('API Error: 401 Internal server error'), null);
  assert.equal(transientErrorText('API Error: 503 service unavailable — please run /login'), null);
});

test('GUI workers also retry short rate limits, never plan limits or auth', () => {
  assert.deepEqual(retryableErrorText('API Error: 529 Overloaded'), { text: 'API Error: 529 Overloaded', kind: 'transient' });
  assert.equal(retryableErrorText('API Error: 429 rate limit exceeded')?.kind, 'rate-limit');
  assert.equal(retryableErrorText('Rate limit reached for requests per minute. Please try again in 20s.')?.kind, 'rate-limit');
  assert.equal(retryableErrorText('429 RESOURCE_EXHAUSTED: Quota exceeded for requests per minute')?.kind, 'rate-limit');
  assert.equal(retryableErrorText('Claude usage limit reached'), null);
  assert.equal(retryableErrorText("You've hit your limit · resets 3pm"), null);
  assert.equal(retryableErrorText("■ You've hit your usage limit. Upgrade to Plus."), null);
  assert.equal(retryableErrorText('429 rate limited: invalid api key'), null);
  assert.equal(retryableErrorText('API Error: 400 invalid_request'), null);
  // Hard quotas that wear a 429 (audit 2026-10-15 fleet #10): no short retries.
  assert.equal(retryableErrorText('Error code: 429 - {"error": {"message": "You exceeded your current quota, please check your plan", "type": "insufficient_quota"}}'), null);
  assert.equal(retryableErrorText('429 RESOURCE_EXHAUSTED: Quota exceeded for metric generate_content_requests, limit: GenerateRequestsPerDayPerProjectPerModel'), null);
  assert.equal(retryableErrorText('429 RESOURCE_EXHAUSTED: quota of 250 requests per day exceeded'), null);
  // …but "per day" only as words: an ordinary 429 that happens to contain "superday" / "upper days" is still retried.
  assert.ok(retryableErrorText('429 Too Many Requests (superday-proxy)'));
  assert.ok(retryableErrorText('429 rate limited by upper daylight gateway'));
});

const box = ['╭──────────────────────────╮', '│ >                        │', '╰──────────────────────────╯', '  ? for shortcuts'];

test('screen: only the last content lines above the input box count', () => {
  const stalled = ['⏺ Reading files…', '  ⎿  API Error: The response stopped arriving', '', ...box].join('\n');
  assert.equal(errorStallFromScreen(stalled), 'API Error: The response stopped arriving');
  const recovered = ['  ⎿  API Error: The response stopped arriving', '⏺ a', '⏺ b', '⏺ c', '⏺ Done — all tests pass.', ...box].join('\n');
  assert.equal(errorStallFromScreen(recovered), null);
});

function jsonl(recs: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estall-'));
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
}
const apiErr = (text: string, error = 'unknown') => ({ type: 'assistant', isApiErrorMessage: true, error, message: { content: [{ type: 'text', text }] } });

test('transcript: last main-chain record decides', () => {
  assert.deepEqual(errorStallFromTranscript(jsonl([{ type: 'user', message: { content: 'go' } }, apiErr('API Error: The response stopped arriving')])), { error: 'API Error: The response stopped arriving' });
  assert.deepEqual(errorStallFromTranscript(jsonl([apiErr('API Error: The response stopped arriving'), { type: 'user', message: { content: 'continue' } }])), { ok: true });
  assert.deepEqual(errorStallFromTranscript(jsonl([apiErr('API Error: 500 Internal server error', 'server_error'), { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'side' }] } }])), { error: 'API Error: 500 Internal server error' });
  assert.deepEqual(errorStallFromTranscript(jsonl([apiErr('API Error: Rate limited', 'rate_limit')])), { ok: true });
  assert.deepEqual(errorStallFromTranscript(jsonl([{ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }])), { ok: true });
  assert.equal(errorStallFromTranscript('/nonexistent/x.jsonl'), null);
});

test('detect: a clean transcript overrides an error still visible on screen', () => {
  const screen = ['  ⎿  API Error: The response stopped arriving', ...box].join('\n');
  assert.equal(detectErrorStall(screen, { ok: true }), null);
  assert.equal(detectErrorStall(screen, null), 'API Error: The response stopped arriving');
  assert.equal(detectErrorStall('', { error: 'x' }), 'x');
});

test('nextErrorStall: one retry per idle, capped per worker', () => {
  let s = nextErrorStall(null, 0, 'E', 100, 2);
  assert.deepEqual(s, { stall: { line: 'E', at: 100, retries: 1, retrying: true }, retry: true });
  s = nextErrorStall(s.stall, 1, 'E', 200, 2);
  assert.deepEqual(s, { stall: { line: 'E', at: 100, retries: 2, retrying: true }, retry: true });
  s = nextErrorStall(s.stall, 2, 'E', 300, 2);
  assert.deepEqual(s, { stall: { line: 'E', at: 100, retries: 2, retrying: false }, retry: false });
  assert.deepEqual(nextErrorStall(s.stall, 2, null, 400, 2), { stall: null, retry: false });
});

test('Antigravity, Codex and network-level failures are retried; auth and limits are not', () => {
  for (const m of [
    'Antigravity stopped: There was a network issue connecting to the server, please try again.',
    'Antigravity stopped: The stream was interrupted. Please continue the task you were working on.',
    'Antigravity stopped responding (nothing for 20 min), so Kora ended the turn.',
    'Get "https://x": net/http: TLS handshake timeout',
    'Post "https://x": unexpected EOF',
    'getaddrinfo EAI_AGAIN daily-cloudcode-pa.googleapis.com',
    'stream disconnected before completion: error sending request for url',
    'Antigravity exited (code 1) without an answer.',
  ]) assert.equal(retryableErrorText(m)?.kind, 'transient', m);
  for (const m of [
    'Antigravity is not signed in. Run `agy` in a terminal once and sign in',
    'Antigravity hit a usage limit: You have exhausted your capacity',
    'Antigravity does not offer the model "x" any more.',
  ]) assert.equal(retryableErrorText(m)?.kind === 'transient', false, m);
});
