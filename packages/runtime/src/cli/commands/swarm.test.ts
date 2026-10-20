// `kora swarm` CLI: status --json has the SwarmStatus fixture's shape (no daemon → computed in-process), keys are
// refused on argv, key clear / usage errors. Temp HOME/KORA_HOME/socket from test-isolate; no network is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { IO } from '../main';
import { run as main, setAgentGateForTests } from '../main';

// These test the commands themselves, as the person at a terminal, even when the run starts inside a Kora agent pane.
setAgentGateForTests(true);
import { setSwarmKey, swarmKeySource } from '../../server/swarm-secrets';

// dist/cli/commands/ → packages/contracts/src/fixtures
const FIXTURE = path.resolve(__dirname, '..', '..', '..', '..', 'contracts', 'src', 'fixtures', 'swarm-status.sample.json');

function capture(): IO & { stdout: () => string; stderr: () => string } {
  let o = ''; let e = '';
  return { out: (s) => { o += s; }, err: (s) => { e += s; }, stdout: () => o, stderr: () => e };
}
function deepKeys(v: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) { for (const el of v) deepKeys(el, `${prefix}[]`, out); return out; }
  if (v && typeof v === 'object') for (const [k, c] of Object.entries(v)) { const p = prefix ? `${prefix}.${k}` : k; out.add(p); deepKeys(c, p, out); }
  return out;
}

test('kora swarm status --json prints a SwarmStatus whose keys stay inside the fixture\'s', async () => {
  const io = capture();
  assert.equal(await main(['swarm', 'status', '--json'], io), 0, io.stderr());
  const status = JSON.parse(io.stdout());
  const want = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(Object.keys(status).sort(), Object.keys(want).sort());
  const allowed = deepKeys(want);
  for (const k of deepKeys(status)) assert.ok(allowed.has(k), `unexpected key ${k}`);
  assert.equal(status.keyStorage, 'file');
  assert.equal(typeof status.checkedAt, 'number');
  assert.deepEqual(status.providers.map((p: any) => p.provider), ['zen', 'openrouter', 'cerebras']);
  assert.equal(status.providers[2].enabled, false, 'Cerebras disabled by default');
  assert.ok(status.blockers.some((b: any) => b.code === 'consent-missing'));
  assert.ok(!io.stdout().includes('undefined'));
});

test('kora swarm status (human) names the blockers and the key storage honestly', async () => {
  const io = capture();
  assert.equal(await main(['swarm', 'status'], io), 0);
  assert.match(io.stdout(), /Swarm: not ready/);
  assert.match(io.stdout(), /Privacy notice: not accepted/);
  assert.match(io.stdout(), /private file in ~\/\.kora/);
  assert.doesNotMatch(io.stdout(), /Keychain/i);
});

test('kora swarm key refuses a key on argv and never echoes it', async () => {
  const io = capture();
  const secret = 'sk-or-v1-00000000000000000000000000argv';
  assert.equal(await main(['swarm', 'key', 'set', 'openrouter', secret], io), 2);
  assert.match(io.stderr(), /never pass a key as an argument/);
  assert.ok(!io.stdout().includes(secret) && !io.stderr().includes(secret));
  assert.equal(swarmKeySource('openrouter'), null);
});

test('kora swarm key clear removes Kora\'s key; bad provider / subcommand → usage (exit 2)', async () => {
  setSwarmKey('openrouter', 'sk-or-v1-000000000000000000000000clear');
  const io = capture();
  assert.equal(await main(['swarm', 'key', 'clear', 'openrouter'], io), 0, io.stderr());
  assert.match(io.stdout(), /cleared Kora's OpenRouter key/);
  assert.equal(swarmKeySource('openrouter'), null);
  assert.equal(await main(['swarm', 'key', 'set', 'bogus'], capture()), 2);
  assert.equal(await main(['swarm', 'nope'], capture()), 2);
  assert.equal(await main(['swarm', 'test', 'bogus'], capture()), 2);
});

test('kora swarm install without --yes and without a terminal refuses (never downloads in a script by accident)', async () => {
  const io = capture();
  const code = await main(['swarm', 'install'], io);
  if (process.stdin.isTTY) return; // an interactive runner would get the prompt instead
  assert.equal(code, 2);
  assert.match(io.stderr(), /--yes/);
});

test('kora --help lists swarm', async () => {
  const io = capture();
  await main(['--help'], io);
  assert.match(io.stdout(), /swarm\s+Swarm mode/);
});
