import { test } from 'node:test';
import assert from 'node:assert';
import { RunawayGuard } from './runaway';

test('the third Read of the same file window is flagged once; other ranges are ordinary reading', () => {
  const g = new RunawayGuard();
  assert.equal(g.onToolUse('a', 'Read', { file_path: '/r/x.ts' }), null);
  assert.equal(g.onToolUse('b', 'Read', { file_path: '/r/x.ts', offset: 10, limit: 50 }), null);
  assert.equal(g.onToolUse('c', 'Read', { file_path: '/r/x.ts', offset: 60, limit: 50 }), null);
  assert.equal(g.onToolUse('d', 'Read', { file_path: '/r/x.ts' }), null);
  const v = g.onToolUse('e', 'Read', { file_path: '/r/x.ts' });
  assert.equal(v?.kind, 'reread');
  assert.match(v!.message, /read \/r\/x\.ts 3 times/);
  assert.equal(g.onToolUse('f', 'Read', { file_path: '/r/x.ts' }), null, 'told once');
});

test('the same failing command three times is flagged; successes and different commands are not', () => {
  const g = new RunawayGuard();
  for (const [id, cmd, err] of [['1', 'npm test', true], ['2', 'npm  test ', true], ['3', 'npm run lint', true], ['4', 'npm test', false]] as const) {
    g.onToolUse(id, 'Bash', { command: cmd });
    assert.equal(g.onToolResult(id, err), null, id);
  }
  g.onToolUse('5', 'Bash', { command: 'npm test' });
  const v = g.onToolResult('5', true);
  assert.equal(v?.kind, 'refail');
  assert.match(v!.message, /`npm test` has failed 3 times/);
});

test('a new turn starts the counts over', () => {
  const g = new RunawayGuard();
  g.onToolUse('a', 'Read', { file_path: '/r/y.ts' }); g.onToolUse('b', 'Read', { file_path: '/r/y.ts' });
  g.beginTurn();
  assert.equal(g.onToolUse('c', 'Read', { file_path: '/r/y.ts' }), null);
});

test('unknown ids, other tools and odd input never throw', () => {
  const g = new RunawayGuard();
  assert.equal(g.onToolResult('nope', true), null);
  assert.equal(g.onToolUse('', 'Read', {}), null);
  assert.equal(g.onToolUse('x', 'Read', null), null);
  assert.equal(g.onToolUse('y', 'TodoWrite', { todos: [] }), null);
});

test('repeated failing Edits of one file and repeated failing MCP calls are flagged too', () => {
  const g = new RunawayGuard(2);
  g.onToolUse('1', 'Edit', { file_path: '/r/z.ts', old_string: 'a' }); assert.equal(g.onToolResult('1', true), null);
  g.onToolUse('2', 'Edit', { file_path: '/r/z.ts', old_string: 'b' });
  assert.match(g.onToolResult('2', true)!.message, /Edit on \/r\/z\.ts has failed 2 times/);
});

test('the same tool_use id seen twice (the SDK repeats messages) counts once', () => {
  const g = new RunawayGuard();
  for (let i = 0; i < 5; i++) assert.equal(g.onToolUse('same', 'Read', { file_path: '/r/q.ts' }), null);
});

test('a long read path is shown by its END (the file), not the checkout prefix', () => {
  const g = new RunawayGuard();
  const p = `/private/tmp/claude-501/${'x'.repeat(120)}/scratch-repo/report.js`;
  g.onToolUse('1', 'Read', { file_path: p }); g.onToolUse('2', 'Read', { file_path: p });
  const v = g.onToolUse('3', 'Read', { file_path: p })!;
  assert.match(v.message, /read \.\.\..*\/scratch-repo\/report\.js 3 times/);
  assert.ok(v.message.length < 140);
});

test('read, edit, read again to check is not a loop: an edit of the file resets its read count', () => {
  const g = new RunawayGuard();
  assert.equal(g.onToolUse('a', 'Read', { file_path: '/r/a.ts' }), null);
  assert.equal(g.onToolUse('b', 'Read', { file_path: '/r/a.ts' }), null);
  assert.equal(g.onToolUse('e', 'Edit', { file_path: '/r/a.ts' }), null);
  assert.equal(g.onToolUse('c', 'Read', { file_path: '/r/a.ts' }), null, 'would have been the third read');
  assert.equal(g.onToolUse('d', 'Read', { file_path: '/r/a.ts' }), null);
  assert.ok(g.onToolUse('f', 'Read', { file_path: '/r/a.ts' }), 'three reads with no edit between still trips it');
});
