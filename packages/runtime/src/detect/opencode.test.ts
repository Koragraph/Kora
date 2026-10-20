// OpenCode (swarm worker) detection + adapter. The screens are manifests/fixtures/opencode/*.txt — synthesized from
// the opencode v1.18.32 TUI source (each file's header names it); CP2 replaces them with live captures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { detect } from './index';
import { manifestsDir } from './manifest';
import { adapterFor, opencodeAdapter } from './agent-adapter';
import { KEY_ENTER } from '../server/autoanswer';

function fixture(name: string): string {
  const raw = fs.readFileSync(path.join(manifestsDir(), 'fixtures', 'opencode', name), 'utf8');
  const cut = raw.indexOf('---8<---\n');
  assert.ok(cut >= 0, `${name}: header separator`);
  assert.match(raw.slice(0, cut), /confirm live at CP2|captured live/, `${name}: provenance header`);
  return raw.slice(cut + '---8<---\n'.length);
}
const snap = (screen: string) => ({ screen, oscTitle: '', oscProgress: '' });
const ctx = (screen: string, allowEdits: boolean) => ({
  screen, cwd: '/tmp/wt', mainRoot: '/tmp/main', trustedRoots: [], allowEdits,
  policy: { trustFolder: true, mcpFound: true, readOutsideWorktree: true },
});

const EXPECT: Array<[string, string, string]> = [
  ['home-idle.txt', 'idle', 'idle_prompt'],
  ['session-idle.txt', 'idle', 'idle_prompt'],
  ['busy.txt', 'working', 'esc_interrupt'],
  ['retry.txt', 'working', 'retrying'],
  ['permission-edit.txt', 'blocked', 'permission_required'],
  ['permission-shell.txt', 'blocked', 'permission_required'],
  ['question.txt', 'blocked', 'question_dialog'],
];

for (const [file, state, rule] of EXPECT) {
  test(`opencode manifest: ${file} → ${state} (${rule})`, () => {
    const d = detect(snap(fixture(file)), 'opencode');
    assert.equal(d.state, state);
    assert.equal(d.ruleId, rule);
  });
}

test('opencode manifest: blocker text is the dialog, not the key hints', () => {
  const d = detect(snap(fixture('permission-shell.txt')), 'opencode');
  assert.ok(d.blocker && !/enter confirm/.test(d.blocker), String(d.blocker));
  const q = detect(snap(fixture('question.txt')), 'opencode');
  assert.match(String(q.blocker), /package manager/);
});

test('opencode manifest: a list the agent printed above an idle prompt is not a blocker; plain text matches nothing', () => {
  const d = detect(snap('1. do this\n2. do that\n(y/n)?\n'), 'opencode');
  assert.equal(d.matched, false, 'the generic numbered / y-n rules are gone');
});

test('opencode adapter: registered, flags — exactly one --auto, model via -m, effort dropped, no accept-edits argv', () => {
  assert.equal(adapterFor('opencode'), opencodeAdapter);
  assert.equal(opencodeAdapter.canCompact, false);
  assert.deepEqual(opencodeAdapter.skipPermissionArgs(), ['--auto']);
  assert.deepEqual(opencodeAdapter.acceptEditsArgs(), []);
  assert.deepEqual(opencodeAdapter.modelArgs('opencode/big-pickle', 'high'), ['-m', 'opencode/big-pickle']);
  assert.deepEqual(opencodeAdapter.modelArgs(), []);
  assert.deepEqual(opencodeAdapter.spawnEnv('p1', 'acct'), {});
  // The swarm launch line is modelArgs + (skipPermissionArgs when full access): --auto must appear once.
  const argv = [...opencodeAdapter.modelArgs('opencode/big-pickle'), ...opencodeAdapter.skipPermissionArgs()];
  assert.equal(argv.filter((a) => a === '--auto').length, 1);
  assert.ok(!opencodeAdapter.modelArgs('x', 'y').includes('--auto'));
});

test('opencode adapter: autoAnswer — Allow once (Enter) only for a non-shell dialog, only under allowEdits', () => {
  const edit = fixture('permission-edit.txt');
  const plan = opencodeAdapter.autoAnswer(ctx(edit, true));
  assert.ok(plan, 'an in-worktree edit is accepted under allowlist');
  assert.deepEqual(plan!.keys, [KEY_ENTER], '"Allow once" is the initially selected option');
  assert.match(plan!.detail, /Edit src\/config\/parse\.test\.ts/);
  assert.equal(opencodeAdapter.autoAnswer(ctx(edit, false)), null, 'never without allowEdits');
  assert.equal(opencodeAdapter.autoAnswer(ctx(fixture('permission-shell.txt'), true)), null, 'never a shell command');
  assert.equal(opencodeAdapter.autoAnswer(ctx(fixture('question.txt'), true)), null, 'never a question');
  assert.equal(opencodeAdapter.autoAnswer(ctx(fixture('busy.txt'), true)), null);
  const external = edit.replace('→ Edit src/config/parse.test.ts', '← Access external directory ~/secrets');
  assert.equal(opencodeAdapter.autoAnswer(ctx(external, true)), null, 'never an external directory');
  const fetch = edit.replace('→ Edit src/config/parse.test.ts', '% WebFetch https://example.com');
  assert.equal(opencodeAdapter.autoAnswer(ctx(fetch, true)), null, 'never a web fetch');
});
