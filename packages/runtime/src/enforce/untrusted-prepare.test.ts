// An untrusted folder's first chat send must not write CLAUDE.md or .claude/settings.local.json into the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createEnforcer } from './enforcer';
import { hookText } from './adapters/claude';

function repo() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-untrusted-')));
  execFileSync('git', ['init', '-q', d]);
  return d;
}
const input = (cwd: string, extra: object = {}) => ({ agent: 'claude' as const, cwd, paneId: 'chat:t1', socketPath: '/x.sock', binPath: '/k.js', command: 'claude', args: [], env: {}, ...extra });

test('noRepoWrites: no CLAUDE.md block, no hooks file; the rulebook still rides as the system prompt', async () => {
  const d = repo();
  const plan = await createEnforcer({ graph: { brief: async () => null } as any }).prepare(input(d, { noRepoWrites: true }));
  assert.equal(fs.existsSync(path.join(d, 'CLAUDE.md')), false);
  assert.equal(fs.existsSync(path.join(d, '.claude')), false);
  assert.ok(plan.args.includes('--append-system-prompt'), 'rulebook still delivered');
  assert.ok(plan.notes.some((n) => /untrusted folder/.test(n)));
});

test('a trusted folder (default) still gets the block and hooks', async () => {
  const d = repo();
  await createEnforcer({ graph: { brief: async () => null } as any }).prepare(input(d));
  assert.equal(fs.existsSync(path.join(d, 'CLAUDE.md')), true);
  assert.equal(fs.existsSync(path.join(d, '.claude', 'settings.local.json')), true);
});

test('a .gemini/settings.json Kora creates is git-excluded, so the repo does not read as dirty (pl5 S2-1)', async () => {
  const d = repo();
  await createEnforcer({ graph: { brief: async () => null } as any }).install({ agent: 'gemini', cwd: d });
  assert.equal(fs.existsSync(path.join(d, '.gemini', 'settings.json')), true);
  const st = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: d, encoding: 'utf8' });
  assert.doesNotMatch(st, /\.gemini/);
});

test('deep audit 2026-10-13 A1-4: a Claude pane with no Kora hooks in its folder still gets the credential guard', async () => {
  const guard = (args: string[]) => { const i = args.indexOf('--settings'); return i < 0 ? null : JSON.parse(args[i + 1]!); };
  const enf = createEnforcer({ graph: { brief: async () => null } as any });
  // Untrusted repo: nothing written, the guard rides as flag settings.
  const d = repo();
  const s = guard((await enf.prepare(input(d, { noRepoWrites: true }))).args);
  assert.match(hookText(s?.hooks?.PreToolUse?.[0]?.hooks?.[0]), /hook pre-tool$/);
  assert.equal(fs.existsSync(path.join(d, '.claude')), false);
  // Not a repo at all (no graph there): the same.
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-plain-')));
  assert.match(hookText(guard((await enf.prepare(input(plain))).args)?.hooks?.PreToolUse?.[0]?.hooks?.[0]), /hook pre-tool$/);
  // A trusted repo has its hooks file: no duplicate hooks. Its flag settings only turn Claude Code's prompt suggestions off
  // (SAV-E: the greyed suggestion after ❯ read as text a human typed).
  const t = repo();
  const ts = guard((await enf.prepare(input(t))).args);
  assert.equal(ts?.hooks, undefined);
  assert.equal(ts?.promptSuggestionEnabled, false);
  // The user's own --settings is left alone.
  const own = await enf.prepare(input(repo(), { noRepoWrites: true, args: ['--settings', '{}'] }));
  assert.deepEqual(own.args.filter((a) => a === '--settings'), ['--settings']);
  // A3-1: the pre-tool hook reports "working"; without a Stop hook to report "idle" the pane read busy 30 s past
  // every turn. Both ride together.
  assert.match(hookText(s?.hooks?.Stop?.[0]?.hooks?.[0]), /hook stop$/);
  assert.match(hookText(s?.hooks?.SessionEnd?.[0]?.hooks?.[0]), /hook session-end$/);
  // Another agent is untouched.
  assert.equal(guard((await enf.prepare(input(plain, { agent: 'codex' }))).args), null);
});
