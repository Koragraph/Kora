// redactSecrets: credential shapes, Bearer headers and secret-named assignments; ordinary text and token COUNTS stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from './redact';

test('known key shapes keep only a vendor prefix', () => {
  const cases: [string, string][] = [
    ['sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAfake', 'sk-ant-api03-[REDACTED]'],
    ['sk-or-v1-0000000000000000000000000000fake', 'sk-or-v1-[REDACTED]'],
    ['sk-proj-abcdefghijklmnopqrstuvwxyz0123', 'sk-proj-[REDACTED]'],
    ['csk-abcdefghijklmnopqrst', 'csk-[REDACTED]'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_[REDACTED]'],
    ['github_pat_11ABCDEFGHIJKLMNOPQRSTUV', 'github_pat_[REDACTED]'],
    ['AKIAABCDEFGHIJKLMNOP', 'AKIA[REDACTED]'],
    ['npm_abcdefghijklmnopqrstuvwxyz0123456789', 'npm_[REDACTED]'],
  ];
  for (const [raw, want] of cases) {
    assert.equal(redactSecrets(`x ${raw} y`), `x ${want} y`, raw);
  }
});

test('Bearer headers and secret-named assignments are masked', () => {
  assert.equal(redactSecrets('authorization: Bearer abc.def-ghi_jkl012'), 'authorization: Bearer [REDACTED]');
  assert.equal(redactSecrets('OPENROUTER_API_KEY=whatever-opaque-123'), 'OPENROUTER_API_KEY=[REDACTED]');
  assert.equal(redactSecrets('{"apiKey":"zzzzzzzzzzzz"}'), '{"apiKey":"[REDACTED]"}');
  assert.equal(redactSecrets('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'GITHUB_TOKEN=ghp_[REDACTED]');
});

test('ordinary log text is untouched', () => {
  for (const s of [
    'swarm: task s3 attempt 1 → p4 on opencode/big-pickle in /Users/u/.kora/worktrees/repo/kora-opencode-1',
    '{"outputTokens":123456789,"cacheReadTokens":337000}',
    'git worktree add -b kora/opencode-3 /tmp/x HEAD',
    'the task-sk-list is ready',
  ]) assert.equal(redactSecrets(s), s);
});
