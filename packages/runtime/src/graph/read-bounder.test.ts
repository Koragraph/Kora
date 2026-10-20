// The chat lane's in-process bounded Read (graph/read-bounder.ts): it must never delay or break a tool call.
import { after, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReadBounder, BOUND_BUDGET_MS } from './read-bounder';

// The bounder's budget timer is unref'd (a hook process must be free to exit). In the daemon the loop is always alive;
// here a hung graph promise would leave nothing to wait on and the runner would cancel the test, so hold the loop open.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

function repo(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-rb-'));
  const file = path.join(dir, 'big.ts');
  fs.writeFileSync(file, Array.from({ length: 420 }, (_, i) => `export function f${i}() { return ${i}; }`).join('\n') + '\n');
  return { dir, file };
}
const pre = (b: ReturnType<typeof createReadBounder>, file: string, extra: Record<string, unknown> = {}) =>
  (b.hooks() as any).PreToolUse[0].hooks[0]({ tool_name: 'Read', tool_input: { file_path: file, ...extra } }, 'tu1') as Promise<any>;

test('on: an indexed repo gets a window and the outline; a second Read of the same file passes whole', async () => {
  const { dir, file } = repo();
  const b = createReadBounder({ cwd: dir, threadId: 'T', mode: () => 'on', graphStatus: async () => ({ indexed: true }), graphCall: async () => ({ text: 'f1:1\nf2:2' }) });
  const out = await pre(b, file);
  assert.equal(out.hookSpecificOutput?.updatedInput?.limit > 0, true, JSON.stringify(out));
  assert.ok(b.boundedFor('tu1'));
  assert.deepEqual(await pre(b, file), {}, 'the second read goes through whole');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shadow and off change nothing', async () => {
  const { dir, file } = repo();
  for (const m of ['shadow', 'off'] as const) {
    const b = createReadBounder({ cwd: dir, threadId: 'T', mode: () => m, graphStatus: async () => ({ indexed: true }), graphCall: async () => ({ text: 'x' }) });
    assert.deepEqual(await pre(b, file), {});
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fails open within the budget when the graph never answers, is unindexed, incomplete, or throws', async () => {
  const { dir, file } = repo();
  const never = new Promise<any>(() => {});
  const cases: Array<[string, Parameters<typeof createReadBounder>[0]]> = [
    ['status hangs', { cwd: dir, threadId: 'T', mode: () => 'on', graphStatus: () => never }],
    ['unindexed', { cwd: dir, threadId: 'T', mode: () => 'on', graphStatus: async () => ({ indexed: false }) }],
    ['incomplete', { cwd: dir, threadId: 'T', mode: () => 'on', graphStatus: async () => ({ indexed: true, incomplete: true }) }],
    ['status throws', { cwd: dir, threadId: 'T', mode: () => 'on', graphStatus: async () => { throw new Error('locked'); } }],
    ['sensitive', { cwd: dir, threadId: 'T', mode: () => 'on', graphStatus: async () => ({ indexed: true }), sensitive: () => true }],
  ];
  for (const [name, deps] of cases) {
    const t0 = Date.now();
    const out = await pre(createReadBounder(deps), file);
    assert.deepEqual(out, {}, name);
    assert.ok(Date.now() - t0 < BOUND_BUDGET_MS + 400, `${name} took ${Date.now() - t0} ms`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a hung outline lookup still yields a bounded window (the outline is optional) or a pass-through, within the budget', async () => {
  const { dir, file } = repo();
  const t0 = Date.now();
  const out = await pre(createReadBounder({ cwd: dir, threadId: 'T', mode: () => 'on', graphStatus: async () => ({ indexed: true }), graphCall: () => new Promise<any>(() => {}) }), file);
  assert.ok(Date.now() - t0 < BOUND_BUDGET_MS + 400);
  assert.ok(out && typeof out === 'object');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing file, a binary-sized file and other tools pass through untouched', async () => {
  const { dir } = repo();
  const b = createReadBounder({ cwd: dir, threadId: 'T', mode: () => 'on', graphStatus: async () => ({ indexed: true }) });
  assert.deepEqual(await pre(b, path.join(dir, 'missing.ts')), {});
  assert.deepEqual(await (b.hooks() as any).PreToolUse[0].hooks[0]({ tool_name: 'Bash', tool_input: { command: 'ls' } }), {});
  assert.deepEqual(await (b.hooks() as any).PostToolUse[0].hooks[0]({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} }), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

// Audit 2026-10-15 #4: a bound kept its full credit when the agent read the rest some other way (Bash cat / sed -n, a
// content Grep) or re-read it more than three turns later. Each of those is an expand now (the ledger voids the bound).
test('a bounded file read later by Bash, a content Grep, or a late Read counts as expanded', async () => {
  const { dir, file } = repo();
  const mk = () => createReadBounder({ cwd: dir, threadId: 'T', mode: () => 'on', graphStatus: async () => ({ indexed: true }), graphCall: async () => ({ text: 'f1:1' }) });
  const post = (b: ReturnType<typeof createReadBounder>, tool_name: string, tool_input: Record<string, unknown>) =>
    (b.hooks() as any).PostToolUse[0].hooks[0]({ tool_name, tool_input, cwd: dir }) as Promise<any>;

  const viaBash = mk(); await pre(viaBash, file);
  await post(viaBash, 'Bash', { command: 'echo hi' });
  assert.equal(viaBash.state.bounded[0]!.expanded, undefined, 'a command that does not read the file is not an expand');
  await post(viaBash, 'Bash', { command: "sed -n '250,420p' big.ts" });
  assert.equal(viaBash.state.bounded[0]!.expanded, true, 'sed -n of the bounded file');

  const viaGrep = mk(); await pre(viaGrep, file);
  await post(viaGrep, 'Grep', { pattern: 'f3', path: 'big.ts', output_mode: 'files_with_matches' });
  assert.equal(viaGrep.state.bounded[0]!.expanded, undefined, 'a file list is not the content');
  await post(viaGrep, 'Grep', { pattern: 'f3', path: 'big.ts', output_mode: 'content' });
  assert.equal(viaGrep.state.bounded[0]!.expanded, true);

  const late = mk(); late.beginTurn('look at the exported functions'); await pre(late, file);
  for (let i = 0; i < 6; i++) late.beginTurn(`turn ${i}`);
  await pre(late, file, { offset: 400, limit: 20 });
  assert.equal(late.state.bounded[0]!.expanded, true, 'a Read past the window six turns later');
  assert.equal(late.state.counts.expanded, 0, 'but the within-3-turns quality signal does not count it');
  fs.rmSync(dir, { recursive: true, force: true });
});
