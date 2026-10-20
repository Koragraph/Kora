// The PreToolUse wrapper and the PostToolUseFailure measurement of the Bash trim hooks (SAV-D).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBashTrimHooks } from './bash-trim';
import { flushCostLog, readCostLog } from '../util/cost-log';
import type { WrapSpec } from './trim-wrap';

const SPEC: WrapSpec = { node: '/n/node', kora: '/k/kora.js', home: '/h', thread: 'T1' };
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kora-btw-'));
const hooks = (o: Parameters<typeof createBashTrimHooks>[0]) => createBashTrimHooks(o) as Record<string, Array<{ matcher: string; hooks: Array<(i: any) => Promise<any>> }>>;
const pre = (h: ReturnType<typeof hooks>) => h.PreToolUse![0]!.hooks[0]!;
const failed = (h: ReturnType<typeof hooks>) => h.PostToolUseFailure![0]!.hooks[0]!;
const post = (h: ReturnType<typeof hooks>) => h.PostToolUse![0]!.hooks[0]!;

test('PreToolUse: "on" with a wrap spec rewrites a runner command and keeps the other input fields', async () => {
  const h = hooks({ threadId: 'T1', mode: () => 'on', home: home(), wrap: () => SPEC });
  const r = await pre(h)({ tool_name: 'Bash', tool_input: { command: 'cd pkg && pnpm test', description: 'run tests', timeout: 60000 } });
  const u = r.hookSpecificOutput;
  assert.equal(u.hookEventName, 'PreToolUse');
  assert.equal(u.permissionDecision, undefined, 'never decides permission: the user\'s mode still applies');
  assert.equal(u.updatedInput.description, 'run tests');
  assert.equal(u.updatedInput.timeout, 60000);
  assert.match(u.updatedInput.command, /^cd pkg && '\/n\/node' '\/k\/kora.js' trim-run --home '\/h' --thread 'T1' -- pnpm test$/);
});

test('PreToolUse: shadow / off, no spec, a background run, a non-runner or another tool all pass through', async () => {
  const base = { threadId: 'T1', home: home() };
  const input = { tool_name: 'Bash', tool_input: { command: 'pnpm test' } };
  assert.deepEqual(await pre(hooks({ ...base, mode: () => 'shadow', wrap: () => SPEC }))(input), {});
  assert.deepEqual(await pre(hooks({ ...base, mode: () => 'off', wrap: () => SPEC }))(input), {});
  assert.deepEqual(await pre(hooks({ ...base, mode: () => 'on', wrap: () => null }))(input), {});
  assert.deepEqual(await pre(hooks({ ...base, mode: () => 'on' }))(input), {});
  assert.deepEqual(await pre(hooks({ ...base, mode: () => 'on', wrap: () => SPEC }))({ tool_name: 'Bash', tool_input: { command: 'pnpm test', run_in_background: true } }), {});
  assert.deepEqual(await pre(hooks({ ...base, mode: () => 'on', wrap: () => SPEC }))({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }), {});
  assert.deepEqual(await pre(hooks({ ...base, mode: () => 'on', wrap: () => SPEC }))({ tool_name: 'Read', tool_input: { command: 'pnpm test' } }), {});
  assert.deepEqual(await pre(hooks({ ...base, mode: () => 'on', wrap: () => { throw new Error('boom'); } }))(input), {}, 'fail open');
});

test('PostToolUse leaves output the wrapper already trimmed alone', async () => {
  const h = home();
  const hk = hooks({ threadId: 'T1', mode: () => 'on', home: h });
  const body = Array.from({ length: 400 }, (_, i) => `ok ${i} - something verbose and wordy`).join('\n') + '\n[Kora compressed this output (test-node): dropped 5; ...]';
  assert.deepEqual(await post(hk)({ tool_name: 'Bash', tool_response: { stdout: body, stderr: '', interrupted: false, isImage: false } }), {});
});

test('PostToolUseFailure: measures what a trim of a failing command would save (shadow row), changes nothing', async () => {
  const h = home();
  const hk = hooks({ threadId: 'T1', mode: () => 'shadow', home: h });
  const lines = Array.from({ length: 900 }, (_, i) => `✔ passing test number ${i} (0.${i % 9}ms)`);
  lines.splice(400, 0, '✖ the lock holder is wrong (1ms)', '  AssertionError: expected 3 got 4');
  const error = `Exit code 1\n${lines.join('\n')}\nℹ fail 1`;
  assert.deepEqual(await failed(hk)({ tool_name: 'Bash', tool_input: { command: 'node --test dist/a.test.js' }, error }), {});
  await flushCostLog(h);
  const rows = readCostLog({ home: h });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.k, 'bash-trim-shadow');
  assert.match((rows[0] as any).c, /@fail$/);
  assert.ok((rows[0] as any).saved > 1000);
  // an already wrapped command, an interrupt, "off" and small output log nothing
  const h2 = home();
  const hk2 = hooks({ threadId: 'T1', mode: () => 'on', home: h2 });
  await failed(hk2)({ tool_name: 'Bash', tool_input: { command: "'/n/node' '/k/kora.js' trim-run --home '/h' --thread 'T' -- pnpm test" }, error });
  await failed(hk2)({ tool_name: 'Bash', tool_input: { command: 'pnpm test' }, error, is_interrupt: true });
  await failed(hk2)({ tool_name: 'Bash', tool_input: { command: 'pnpm test' }, error: 'Exit code 1\nboom' });
  await failed(hooks({ threadId: 'T1', mode: () => 'off', home: h2 }))({ tool_name: 'Bash', tool_input: { command: 'pnpm test' }, error });
  await flushCostLog(h2);
  assert.equal(readCostLog({ home: h2 }).length, 0);
});
