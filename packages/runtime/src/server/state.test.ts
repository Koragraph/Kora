import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreCommand, PersistedPane } from './state';

const base: PersistedPane = { id: 'p1', name: 'x', command: 'claude', args: [], cwd: '/tmp', agent: 'claude', agentSessionId: null, cols: 80, rows: 24 };

test('restoreCommand resumes claude/codex sessions and leaves the rest alone', () => {
  assert.deepEqual(restoreCommand(base), { command: 'claude', args: [] });
  assert.deepEqual(restoreCommand({ ...base, agentSessionId: 'abc' }), { command: 'claude', args: ['--resume', 'abc'] });
  assert.deepEqual(restoreCommand({ ...base, agentSessionId: 'abc', args: ['--resume', 'old', '--model', 'opus'] }), { command: 'claude', args: ['--resume', 'abc', '--model', 'opus'] });
  assert.deepEqual(restoreCommand({ ...base, command: 'codex', agent: 'codex', agentSessionId: 's1', args: ['--full-auto'] }), { command: 'codex', args: ['resume', 's1', '--full-auto'] });
  assert.deepEqual(restoreCommand({ ...base, command: '/bin/zsh', agent: 'shell', agentSessionId: 'ignored', args: ['-l'] }), { command: '/bin/zsh', args: ['-l'] });
});

test('stateFileFor: the default socket keeps state.json; any other runtime gets its own file', () => {
  const { stateFileFor, statePath } = require('./state');
  const { defaultSocketPath } = require('../protocol/types');
  assert.equal(stateFileFor(defaultSocketPath()), statePath());
  const a = stateFileFor('/tmp/x/chat-fleet.sock'); const b = stateFileFor('/tmp/y/other.sock');
  assert.notEqual(a, statePath()); assert.notEqual(a, b);
  assert.ok(/state-[0-9a-f]{10}\.json$/.test(a));
  assert.equal(stateFileFor('/tmp/x/chat-fleet.sock'), a);
});
