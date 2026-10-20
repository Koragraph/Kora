// Multiple Claude accounts: own CLAUDE_CONFIG_DIR each, never a copied login, never HOME, no rotation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAccounts, accountChipLabel, defaultConfigDir, shellQuote, signInCommand } from './claude-accounts';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acct-t-')));

test('add creates an EMPTY config dir under the Kora home, shows the sign-in command, and persists (0600)', () => {
  const home = tmp(); const a = new ClaudeAccounts({ home });
  const v = a.add({ name: 'Work', label: 'Work account' });
  assert.equal(v.name, 'work'); assert.equal(v.configDir, path.join(home, 'accounts', 'claude', 'work')); assert.equal(v.configDir, defaultConfigDir('work', home));
  assert.deepEqual(fs.readdirSync(v.configDir), [], 'nothing copied in: the user signs in themselves');
  assert.equal(v.signInCommand, signInCommand(v.configDir));
  if (process.platform !== 'win32') assert.equal(v.signInCommand, `CLAUDE_CONFIG_DIR='${v.configDir}' claude auth login`);
  if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(home, 'claude-accounts.json')).mode & 0o777), 0o600);
  assert.deepEqual(new ClaudeAccounts({ home }).list().map((x) => x.name), ['work']);
});

test('refuses the main login (~/.claude), duplicates, bad names and shared folders', () => {
  const home = tmp(); const a = new ClaudeAccounts({ home });
  assert.throws(() => a.add({ name: 'main', configDir: path.join(os.homedir(), '.claude') }), /main Claude login/);
  assert.throws(() => a.add({ name: 'Bad Name!' }), /lowercase letters/);
  a.add({ name: 'one' });
  assert.throws(() => a.add({ name: 'one' }), /already exists/);
  assert.throws(() => a.add({ name: 'two', configDir: defaultConfigDir('one', home) }), /already uses that folder/);
  const adopt = tmp(); fs.writeFileSync(path.join(adopt, 'keep.txt'), 'x');
  a.add({ name: 'adopted', configDir: adopt });
  assert.deepEqual(fs.readdirSync(adopt), ['keep.txt'], 'an adopted folder is left exactly as it was');
});

test('env: CLAUDE_CONFIG_DIR only - never HOME; unknown/null account = the default login ({})', () => {
  const home = tmp(); const a = new ClaudeAccounts({ home });
  const v = a.add({ name: 'work' });
  assert.deepEqual(a.env('work'), { CLAUDE_CONFIG_DIR: v.configDir });
  assert.deepEqual(a.env(null), {}); assert.deepEqual(a.env(''), {});
  assert.deepEqual(a.env('legacy'), { CLAUDE_CONFIG_DIR: path.join(home, 'accounts', 'claude', 'legacy') }, 'pre-Phase-7 threads keep resolving');
  assert.equal(Object.keys(a.env('work')).includes('HOME'), false);
  assert.deepEqual(a.env('../../etc'), {}, 'a path-like name is not an account');
});

test('status asks the CLI about that dir only and maps signed-in / signed-out; remove keeps the folder', async () => {
  const home = tmp(); const seen: string[] = [];
  const a = new ClaudeAccounts({ home, status: async (dir) => { seen.push(dir); return dir.endsWith('in') ? { code: 0, stdout: '{"loggedIn":true,"email":"me@x.com"}' } : { code: 1, stdout: '{"loggedIn":false}' }; } });
  const i = a.add({ name: 'in' }); a.add({ name: 'out' });
  assert.deepEqual(await a.status('in'), { signIn: 'signed-in', email: 'me@x.com' });
  assert.deepEqual(await a.status('out'), { signIn: 'signed-out' });
  assert.deepEqual(await a.status('ghost'), { signIn: 'unknown' });
  assert.equal((await a.view()).length, 2); assert.ok(seen.every((d) => d.startsWith(home)));
  fs.writeFileSync(path.join(i.configDir, '.claude.json'), '{}');
  assert.equal(a.remove('in'), true); assert.equal(a.remove('in'), false);
  assert.equal(fs.existsSync(i.configDir), false, 'a folder Kora made under its accounts dir is deleted with the account (pl9 S2-2)');
});

test('remove never deletes an adopted folder outside Kora\'s accounts dir', () => {
  const home = tmp(); const a = new ClaudeAccounts({ home });
  const adopt = tmp(); fs.writeFileSync(path.join(adopt, '.claude.json'), '{}');
  a.add({ name: 'adopted', configDir: adopt });
  assert.equal(a.remove('adopted'), true);
  assert.ok(fs.existsSync(path.join(adopt, '.claude.json')), 'left exactly as it was');
});

test('no auto-rotation: nothing in the module picks "the next account"; a rate-limited account stays selected', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/session/claude-accounts.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.equal(/rotate|nextAccount|failover/i.test(src), false);
  assert.equal(accountChipLabel([{ name: 'work', label: 'Work', configDir: '/x', createdAt: 0 }], 'work'), 'Work');
  assert.equal(accountChipLabel([], null), null); assert.equal(accountChipLabel([], 'old'), 'old');
});

test('shell quoting survives spaces and quotes in the folder name', () => {
  assert.equal(shellQuote("/a b/it's"), `'/a b/it'\\''s'`);
  assert.equal(signInCommand('/a b', 'darwin'), `CLAUDE_CONFIG_DIR='/a b' claude auth login`);
  assert.equal(signInCommand("C:\\Users\\O'Neil\\.kora\\accounts\\claude\\work", 'win32'), "$env:CLAUDE_CONFIG_DIR='C:\\Users\\O''Neil\\.kora\\accounts\\claude\\work'; claude auth login");
});
