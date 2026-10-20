// swarm-secrets: 0600 file in a 0700 dir, atomic writes, source precedence, masking. Runs under test-isolate's temp
// HOME/KORA_HOME (never the real ~/.kora). No real keys: every value here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import { clearSwarmKey, getSwarmKey, keyHint, setSwarmKey, swarmKeySource } from './swarm-secrets';

const FAKE = 'sk-or-v1-0000000000000000000000000000000000000000000000000000000000fake';
const file = () => path.join(koraHome(), 'secrets', 'swarm.json');

test.beforeEach(() => {
  fs.rmSync(path.join(koraHome(), 'secrets'), { recursive: true, force: true });
  delete process.env.OPENROUTER_API_KEY; delete process.env.CEREBRAS_API_KEY; delete process.env.OPENCODE_API_KEY;
  process.env.XDG_DATA_HOME = path.join(process.env.HOME!, 'xdg');
  fs.rmSync(process.env.XDG_DATA_HOME, { recursive: true, force: true });
});

test('setSwarmKey writes ~/.kora/secrets/swarm.json 0600 inside a 0700 dir, and leaves no temp files', () => {
  setSwarmKey('openrouter', `  ${FAKE}\n`);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.dirname(file())).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(file())), ['swarm.json']);
  assert.equal(getSwarmKey('openrouter'), FAKE); // trimmed
  assert.equal(swarmKeySource('openrouter'), 'kora');
  assert.equal(getSwarmKey('cerebras'), null);
  assert.equal(swarmKeySource('cerebras'), null);
});

test('a too-open existing dir / file is tightened', () => {
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o755 });
  fs.chmodSync(path.dirname(file()), 0o755);
  setSwarmKey('cerebras', 'csk-1111111111111111111111111111');
  fs.chmodSync(file(), 0o644);
  assert.equal(getSwarmKey('cerebras'), 'csk-1111111111111111111111111111');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.dirname(file())).mode & 0o777, 0o700);
  // …and a dir loosened AFTER the write is tightened again on the next read.
  fs.chmodSync(path.dirname(file()), 0o755);
  assert.equal(getSwarmKey('cerebras'), 'csk-1111111111111111111111111111');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.dirname(file())).mode & 0o777, 0o700);
});

test('rejects empty, whitespace-containing and unknown-provider keys', () => {
  assert.throws(() => setSwarmKey('openrouter', '   '), /empty/);
  assert.throws(() => setSwarmKey('openrouter', 'sk-or v1'), /whitespace/);
  assert.throws(() => setSwarmKey('nope' as any, FAKE), /unknown swarm provider/);
  assert.equal(fs.existsSync(file()), false);
});

test('precedence: kora file → env → opencode auth.json; clear only removes Kora\'s own key', () => {
  const authDir = path.join(process.env.XDG_DATA_HOME!, 'opencode');
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'auth.json'), JSON.stringify({ openrouter: { type: 'api', key: 'sk-or-from-auth-json-000000000' }, opencode: { type: 'api', key: 'zen-auth-key-0000000000' } }));
  assert.equal(swarmKeySource('openrouter'), 'opencode-auth');
  assert.equal(swarmKeySource('zen'), 'opencode-auth');
  process.env.OPENROUTER_API_KEY = 'sk-or-from-env-00000000000000';
  assert.equal(swarmKeySource('openrouter'), 'env');
  assert.equal(getSwarmKey('openrouter'), 'sk-or-from-env-00000000000000');
  setSwarmKey('openrouter', FAKE);
  assert.equal(swarmKeySource('openrouter'), 'kora');
  clearSwarmKey('openrouter');
  assert.equal(swarmKeySource('openrouter'), 'env');
  delete process.env.OPENROUTER_API_KEY;
  assert.equal(swarmKeySource('openrouter'), 'opencode-auth');
  clearSwarmKey('cerebras'); // no-op, no throw
});

test('keyHint masks: vendor prefix + last 4 at most, never the middle; short keys reveal nothing', () => {
  assert.equal(keyHint(FAKE), 'sk-or-…fake');
  assert.equal(keyHint('csk-abcdefghijklmnopqrstuvwxyz1234'), 'csk-…1234');
  assert.equal(keyHint('short'), '…');
  const h = keyHint(FAKE);
  assert.ok(!h.includes(FAKE.slice(8, 40)));
  assert.ok(h.length <= 12);
});
