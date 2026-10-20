// Koragent install (copy + sha256 pin + --version gate), the version gate's dev-build rule, the pin check, the
// readiness blockers (koragent-too-old, a changed binary), and the catalog parsers (`models --json` / `--verbose`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkKoragentPin, installKoragent, isDevKoragentVersion, koragentVersion, koragentVersionOk, KORAGENT_MIN_VERSION } from './koragent-install';
import { parseModelsJson, parseModelsVerbose, koragentFreeModels } from './koragent-catalog';
import { SwarmSetup } from './swarm-setup';
import { SwarmHealth } from './swarm-health';
import { saveConfig, invalidateConfig } from '../config';
import { setEditionForTests } from '../edition';

// Koragent (Kora Pro, Bun, a unix:<path> socket) is not ported to Windows yet (docs/windows/PORT.md).
const winSkip = { skip: process.platform === 'win32' };

// Koragent workers are Kora Pro: these tests exercise the Pro path.
setEditionForTests('pro');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kgi-'));
function fakeBin(dir: string, version: string, extra = ''): string {
  const f = path.join(dir, 'koragent-src');
  fs.writeFileSync(f, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\n${extra}\nexit 0\n`, { mode: 0o755 });
  return f;
}
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('version gate: min version, dev builds pass, no answer fails', winSkip, () => {
  assert.equal(koragentVersionOk(KORAGENT_MIN_VERSION), true);
  assert.equal(koragentVersionOk('1.19.0'), true);
  assert.equal(koragentVersionOk('1.18.31'), false);
  assert.equal(koragentVersionOk('0.9.0'), false);
  assert.equal(koragentVersionOk(null), false);
  assert.equal(isDevKoragentVersion('local'), true);
  assert.equal(koragentVersionOk('local'), true);
  assert.equal(koragentVersionOk('0.0.0-main-202609261030'), true);
});

test('koragentVersion reads semver and the source-run "local"', winSkip, async () => {
  const d = tmp();
  assert.equal(await koragentVersion(fakeBin(d, '1.18.32')), '1.18.32');
  assert.equal(await koragentVersion(fakeBin(d, 'local')), 'local');
  assert.equal(await koragentVersion(path.join(d, 'missing')), null);
});

test('installKoragent: copies into $KORAGENT_HOME/bin/koragent, pins its sha256, and the pin check catches a swap', winSkip, async () => {
  const d = tmp(); const home = path.join(d, 'kh');
  const src = fakeBin(d, '1.18.32');
  const r = await installKoragent({ from: src, env: { KORAGENT_HOME: home } });
  assert.equal(r.ok, true, r.message);
  const bin = path.join(home, 'bin', 'koragent');
  assert.equal(r.path, bin);
  assert.equal(r.sha256, sha(src));
  assert.equal(r.version, '1.18.32');
  assert.equal(fs.readFileSync(path.join(home, 'bin', 'koragent.sha256'), 'utf8').split(/\s/)[0], sha(src));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'bin', 'koragent.install.json'), 'utf8')).source, src);
  assert.deepEqual(await checkKoragentPin(bin), { pinned: sha(src), actual: sha(src), ok: true });
  fs.appendFileSync(bin, '# tampered\n');
  const later = new Date(Date.now() + 5000); fs.utimesSync(bin, later, later);
  assert.equal((await checkKoragentPin(bin))!.ok, false);
  assert.equal(fs.readdirSync(path.join(home, 'bin')).some((n) => n.startsWith('.partial-')), false, 'no leftovers');
});

test('installKoragent refuses: too old, wrong sha256, a URL without --sha256, no source; a directory finds bin/koragent', winSkip, async () => {
  const d = tmp(); const env = { KORAGENT_HOME: path.join(d, 'kh') };
  const old = await installKoragent({ from: fakeBin(d, '1.10.0'), env });
  assert.equal(old.ok, false); assert.match(old.message, /older than/);
  assert.equal(fs.existsSync(path.join(d, 'kh', 'bin', 'koragent')), false, 'nothing replaced');
  const bad = await installKoragent({ from: fakeBin(d, '1.18.32'), sha256: 'a'.repeat(64), env });
  assert.equal(bad.ok, false); assert.match(bad.message, /checksum mismatch/);
  const url = await installKoragent({ from: 'https://example.invalid/koragent', env });
  assert.equal(url.ok, false); assert.match(url.message, /needs the expected --sha256/);
  const none = await installKoragent({ env });
  assert.equal(none.ok, false); assert.match(none.message, /no source/);
  // A build output dir (dist/koragent-<platform>-<arch>/bin/koragent) and KORAGENT_BUILD_PATH.
  const build = path.join(d, 'build'); const bdir = path.join(build, 'dist', `koragent-${process.platform}-${process.arch}`, 'bin');
  fs.mkdirSync(bdir, { recursive: true }); fs.copyFileSync(fakeBin(d, '1.18.33'), path.join(bdir, 'koragent')); fs.chmodSync(path.join(bdir, 'koragent'), 0o755);
  const viaEnv = await installKoragent({ env: { ...env, KORAGENT_BUILD_PATH: build } });
  assert.equal(viaEnv.ok, true, viaEnv.message); assert.equal(viaEnv.version, '1.18.33');
  // --build runs the build first, then takes its output.
  let built = '';
  const viaBuild = await installKoragent({ build, env, deps: { runBuild: async (c) => { built = c; } } });
  assert.equal(viaBuild.ok, true, viaBuild.message); assert.equal(built, build);
  // A URL with the right sha256 downloads through the seam.
  const payload = fakeBin(d, '1.18.34');
  const viaUrl = await installKoragent({ from: 'https://example.invalid/koragent', sha256: sha(payload), env, deps: { download: async (_u, dest) => { fs.copyFileSync(payload, dest); } } });
  assert.equal(viaUrl.ok, true, viaUrl.message); assert.equal(viaUrl.version, '1.18.34');
});

test('readiness on the koragent backend: koragent-too-old from --version, a changed binary blocks, a good one is ready of koragent blockers', winSkip, async () => {
  saveConfig({ swarm: { workerBackend: 'koragent' } }); invalidateConfig();
  try {
    const health = new SwarmHealth(path.join(tmp(), 'h.json'));
    const mk = (version: string | null, pin: { pinned: string; actual: string; ok: boolean } | null = null) => new SwarmSetup({
      health, resolveOpencode: async () => ({ path: null, source: null }), resolveKoragent: () => ({ path: '/k/koragent', source: 'koragent-home' }),
      koragentVersion: async () => version, koragentPin: async () => pin, catalog: () => [],
    });
    const codes = async (s: SwarmSetup) => (await s.getStatus()).blockers.map((b) => b.code).filter((c) => c.startsWith('koragent') || c.startsWith('opencode'));
    const old = await mk('1.2.0').getStatus();
    assert.deepEqual(old.blockers.filter((b) => b.code.startsWith('koragent')).map((b) => b.code), ['koragent-too-old']);
    assert.match(old.blockers.find((b) => b.code === 'koragent-too-old')!.message, /1\.2\.0 is older than/);
    assert.equal(old.workerBackend?.version, '1.2.0'); assert.equal(old.workerBackend?.versionOk, false); assert.equal(old.workerBackend?.minVersion, KORAGENT_MIN_VERSION);
    assert.deepEqual(await codes(mk(null)), ['koragent-too-old']);
    assert.deepEqual(await codes(mk('local')), []);
    assert.deepEqual(await codes(mk('1.18.32', { pinned: 'a', actual: 'b', ok: false })), ['koragent-missing']);
    const good = await mk('1.18.32', { pinned: 'a', actual: 'a', ok: true }).getStatus();
    assert.equal(good.workerBackend?.pinOk, true);
    assert.deepEqual(good.blockers.filter((b) => b.code.startsWith('koragent') || b.code.startsWith('opencode')), []);
  } finally { saveConfig({ swarm: { workerBackend: 'opencode' } }); invalidateConfig(); }
});

test('catalog: `models --json` shapes and the `--verbose` fallback (free = cost 0)', winSkip, async () => {
  assert.deepEqual(parseModelsJson('["opencode/a","openrouter/q:free"]'), [{ id: 'opencode/a', free: false }, { id: 'openrouter/q:free', free: true }]);
  assert.deepEqual(parseModelsJson(JSON.stringify([{ id: 'big', providerID: 'opencode', cost: { input: 0, output: 0 } }, { id: 'opencode/paid', cost: { input: 1, output: 2 } }])),
    [{ id: 'opencode/big', free: true }, { id: 'opencode/paid', free: false }]);
  assert.deepEqual(parseModelsJson(JSON.stringify({ models: [{ model: 'ollama/qwen', free: true }] })), [{ id: 'ollama/qwen', free: true }]);
  assert.equal(parseModelsJson('koragent models [provider]\n\nlist all'), null);
  const verbose = 'opencode/big-pickle\n{\n  "id": "big-pickle",\n  "cost": {\n    "input": 0,\n    "output": 0,\n    "cache": { "read": 0 }\n  }\n}\nopencode/paid\n{\n  "cost": { "input": 3, "output": 15 }\n}\nopencode/bare\n';
  assert.deepEqual(parseModelsVerbose(verbose), [{ id: 'opencode/big-pickle', free: true }, { id: 'opencode/paid', free: false }, { id: 'opencode/bare', free: false }]);
  // Against a fake binary that has no --json (prints help, exits 1): the --verbose fallback.
  const d = tmp(); const f = path.join(d, 'k');
  fs.writeFileSync(f, `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--json" ] && { echo "usage"; exit 1; }; done\nprintf '%s' '${verbose.replace(/'/g, "")}'\n`, { mode: 0o755 });
  assert.deepEqual(await koragentFreeModels(f), ['opencode/big-pickle']);
  // …and one that has it.
  const g = path.join(d, 'g');
  fs.writeFileSync(g, `#!/bin/sh\necho '[{"id":"opencode/x","free":true},{"id":"opencode/y","free":false}]'\n`, { mode: 0o755 });
  assert.deepEqual(await koragentFreeModels(g), ['opencode/x', 'opencode/y'], '--free honoured: every row is free');
});
