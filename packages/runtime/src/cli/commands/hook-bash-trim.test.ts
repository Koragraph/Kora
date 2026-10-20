// Pane lane bash trim: `kora hook post-tool` prints the same PostToolUse answer the chat lane's in-process hook returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { paneBashTrim } from './hook';

const bigTestRun = (): string => {
  const lines: string[] = [];
  for (let i = 0; i < 600; i++) lines.push(`ok ${i} - suite case ${i} passes with a fairly long description line`);
  lines.push('not ok 601 - totals add up', '  AssertionError: expected 3 to equal 4', '# fail 1');
  return lines.join('\n');
};
const input = (over: Record<string, unknown> = {}) => ({
  hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 's-trim', cwd: process.cwd(),
  tool_input: { command: 'npm test' }, tool_response: { stdout: bigTestRun(), stderr: '', interrupted: false, isImage: false }, ...over,
});
const capture = () => { const out: string[] = []; return { io: { out: (s: string) => out.push(s), err: () => {} } as any, out }; };

test('pane: a big Bash result comes back trimmed through updatedToolOutput, error lines kept', async () => {
  const { io, out } = capture();
  await paneBashTrim(input(), io);
  assert.equal(out.length, 1, 'one JSON answer');
  const j = JSON.parse(out[0]);
  assert.equal(j.hookSpecificOutput.hookEventName, 'PostToolUse');
  const stdout = j.hookSpecificOutput.updatedToolOutput.stdout as string;
  assert.ok(stdout.length < bigTestRun().length / 2, `trimmed (${stdout.length} chars)`);
  assert.match(stdout, /expected 3 to equal 4/);
});

test('pane: the chat lane (KORA_INJECT_OWNER=driver), small output, other tools and failures are left alone', async () => {
  const prev = process.env.KORA_INJECT_OWNER;
  process.env.KORA_INJECT_OWNER = 'driver';
  try { const { io, out } = capture(); await paneBashTrim(input(), io); assert.deepEqual(out, []); }
  finally { if (prev === undefined) delete process.env.KORA_INJECT_OWNER; else process.env.KORA_INJECT_OWNER = prev; }
  for (const over of [{ tool_response: { stdout: 'ok', stderr: '' } }, { tool_name: 'Read' }, { hook_event_name: 'PostToolUseFailure' }]) {
    const { io, out } = capture(); await paneBashTrim(input(over), io); assert.deepEqual(out, [], JSON.stringify(over).slice(0, 60));
  }
});
