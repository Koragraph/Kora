// The redacted diagnostics bundle: redaction rules, log tails, the export folder guard, no-overwrite writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactText, scrubObject, tailFile, buildDiagnosticsBundle, writeDiagnosticsBundle, resolveExportDir } from './diagnostics-bundle';
import type { HealthReport } from './health';

const report = (o: Partial<HealthReport> = {}): HealthReport => ({ koraVersion: '0.1.8', platform: 'darwin', node: 'v24', cwd: null, generatedAt: 0, checks: [], ...o });

test('redactText scrubs keys, tokens, emails, key-file paths and the home directory', () => {
  const home = '/Users/alice';
  const input = [
    'openrouter key sk-or-v1-0123456789abcdef0123456789abcdef in use',
    'anthropic sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv',
    'gh ghp_0123456789abcdefghijABCDEFGHIJ',
    'Authorization: Bearer abc.def.ghi-123456',
    '{"apiKey": "hunter2hunter2", "token":"t0k3n-value"}',
    'OPENROUTER_API_KEY=abcd1234',
    'wrote /Users/alice/.kora/secrets/swarm.json',
    'read ~/.local/share/opencode/auth.json',
    'cert /Users/alice/certs/server.pem ok',
    'mail alice@example.com',
    'https://user:pa55@host.example/x?token=zzz&x=1',
    'blob aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6',
    'sha 0123456789abcdef0123456789abcdef01234567 thread 3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b',
    'cwd /Users/alice/code/app/src/keyboard.key.ts',
    'project dir -Users-alice-Projects-app',
  ].join('\n');
  const out = redactText(input, home);
  for (const secret of ['sk-or-v1-0123', 'sk-ant-api03', 'ghp_0123', 'abc.def.ghi', 'hunter2', 't0k3n', 'abcd1234', 'swarm.json', 'auth.json', 'server.pem', 'alice@example.com', 'pa55', 'zzz', 'aB3dE6gH9', '/Users/alice', 'alice']) {
    assert.ok(!out.includes(secret), `leaked ${secret}:\n${out}`);
  }
  assert.ok(out.includes('0123456789abcdef0123456789abcdef01234567'), 'a git sha survives');
  assert.ok(out.includes('3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b'), 'a uuid survives');
  assert.ok(out.includes('~/code/app/src/keyboard.key.ts'), 'an ordinary source path survives, home shortened');
});

test('scrubObject blanks secret-named scalar values, keeps booleans and shape', () => {
  assert.deepEqual(scrubObject({ uiPort: 8797, swarm: { apiKey: 'x', keyStorage: 'file', autoAnswer: true, consent: { acceptedAt: 1 } } }),
    { uiPort: 8797, swarm: { apiKey: '<redacted>', keyStorage: '<redacted>', autoAnswer: true, consent: { acceptedAt: 1 } } });
});

test('tailFile keeps the last lines and reads a big log from its end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-tail-'));
  try {
    const f = path.join(dir, 'server.log');
    fs.writeFileSync(f, Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n'));
    const t = (await tailFile(f, 3))!;
    assert.equal(t, 'line 19997\nline 19998\nline 19999');
    assert.equal(await tailFile(path.join(dir, 'missing.log')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the bundle carries the report, a scrubbed config and redacted log tails', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-home-'));
  try {
    const kh = path.join(home, '.kora');
    fs.mkdirSync(kh);
    fs.writeFileSync(path.join(kh, 'server.log'), `boot\nkey set for openrouter sk-or-v1-${'9'.repeat(40)}\nat ${home}/code\n`);
    const text = await buildDiagnosticsBundle({ report: report({ cwd: `${home}/code` }), config: { uiPort: 1, secretThing: 'abc' }, home, koraHome: kh });
    const j = JSON.parse(text);
    assert.equal(j.kind, 'kora-diagnostics');
    assert.equal(j.health.cwd, '~/code');
    assert.equal(j.config.secretThing, '<redacted>');
    assert.match(j.logs['server.log'], /boot/);
    assert.ok(!text.includes('sk-or-v1-9999'));
    assert.ok(!text.includes(home));
    assert.equal(j.logs['ingest.log'], null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('export: ~/Downloads by default, 0600, never overwrites; folders outside home or in Kora data are refused', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-exp-')));
  const prev = process.env.KORA_HOME;
  process.env.KORA_HOME = path.join(home, '.kora');
  try {
    fs.mkdirSync(path.join(home, 'Downloads'));
    fs.mkdirSync(path.join(home, '.kora', 'secrets'), { recursive: true });
    const a = await writeDiagnosticsBundle({ report: report(), home, koraHome: path.join(home, '.kora'), now: 0 });
    const b = await writeDiagnosticsBundle({ report: report(), home, koraHome: path.join(home, '.kora'), now: 0 });
    assert.equal(path.dirname(a.path), path.join(home, 'Downloads'));
    assert.notEqual(a.path, b.path);
    if (process.platform !== 'win32') assert.equal(fs.statSync(a.path).mode & 0o777, 0o600);
    assert.throws(() => resolveExportDir(process.platform === 'win32' ? (process.env.SystemRoot || 'C:\\Windows') : '/etc', home), /inside your home/);
    assert.throws(() => resolveExportDir(path.join(home, '.kora', 'secrets'), home), /outside Kora/);
    assert.throws(() => resolveExportDir(path.join(home, 'nope'), home), /does not exist/);
    assert.equal(resolveExportDir('~', home), home);
  } finally {
    if (prev === undefined) delete process.env.KORA_HOME; else process.env.KORA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('scrubObject keeps numeric settings whose name merely contains "token" (counts are not secrets)', () => {
  assert.deepEqual(scrubObject({ contextTokens: 200000, compactWarnTokens: 150000, apiToken: 'abc123secret' }), {
    contextTokens: 200000,
    compactWarnTokens: 150000,
    apiToken: '<redacted>',
  });
});
