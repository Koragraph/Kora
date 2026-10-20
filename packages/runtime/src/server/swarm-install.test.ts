// swarm-install: the resolve order with a fake filesystem, and installOpencode with a FAKE downloader (never the
// network, never the real ~/.kora): happy path, checksum mismatch, verify failure, cancel, unsupported platform,
// no pinned checksum. The fake release is a real zip (ditto) holding a shell script that prints a version.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { SwarmInstallState } from '../protocol/types';

const posixOnly = { skip: process.platform === 'win32' ? "fixtures are made with ditto / POSIX paths" : false };
import {
  OPENCODE_PINNED_VERSION, compareOpencodeVersions, installOpencode, opencodeVersion, refreshOpencodeBinary, resolveOpencodeBinary,
} from './swarm-install';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kora-oc-'));

/** A release zip whose `opencode` prints `out` (exit `code`, stderr `err`). */
function fakeRelease(out: string, code = 0, err = ''): { zip: string; sha: string } {
  const dir = tmp();
  const src = path.join(dir, 'src'); fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'opencode'), `#!/bin/sh\n${err ? `echo '${err}' >&2\n` : ''}${out ? `echo '${out}'\n` : ''}exit ${code}\n`, { mode: 0o755 });
  const zip = path.join(dir, 'rel.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', src, zip]);
  return { zip, sha: crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex') };
}
const copyDownloader = (zip: string) => async (_url: string, dest: string, o: { onBytes: (d: number, t: number | null) => void }) => {
  fs.copyFileSync(zip, dest); const n = fs.statSync(dest).size; o.onBytes(n, n);
};

// ---- resolve ----

test('resolveOpencodeBinary searches config → kora → PATH → ~/.opencode → brew → /usr/local → bun → ~/.local', posixOnly, () => {
  const home = '/h'; const kh = '/h/.kora';
  const order = [
    ['/custom/opencode', 'config'], [`${kh}/tools/opencode/current/opencode`, 'kora'], ['/p1/opencode', 'path'],
    ['/h/.opencode/bin/opencode', 'opencode-home'], ['/opt/homebrew/bin/opencode', 'homebrew'], ['/usr/local/bin/opencode', 'homebrew'],
    ['/h/.bun/bin/opencode', 'bun'], ['/h/.local/bin/opencode', 'local'],
  ] as const;
  // Remove candidates from the front one by one: each time the next one in order must win.
  for (let i = 0; i < order.length; i++) {
    const present = new Set<string>(order.slice(i).map(([p]) => p));
    const r = resolveOpencodeBinary({ opencodePath: '/custom/opencode', koraHome: kh, home, pathEnv: '/p1:relative/dir', isExecutable: (p) => present.has(p) });
    assert.deepEqual(r, { path: order[i][0], source: order[i][1] }, `step ${i}`);
  }
  assert.deepEqual(resolveOpencodeBinary({ opencodePath: null, koraHome: kh, home, pathEnv: '', isExecutable: () => false }), { path: null, source: null });
  // `~/` in the configured path expands to home
  assert.equal(resolveOpencodeBinary({ opencodePath: '~/bin/opencode', koraHome: kh, home, pathEnv: '', isExecutable: (p) => p === '/h/bin/opencode' }).path, '/h/bin/opencode');
});

test('refreshOpencodeBinary falls back to the async login-shell probe only when the fixed search misses', async () => {
  let asked = 0;
  const base = { opencodePath: null, koraHome: '/k', home: '/h', pathEnv: '' };
  const hit = await refreshOpencodeBinary({ ...base, isExecutable: (p) => p === '/Users/x/.nvm/bin/opencode', loginShell: async () => { asked++; return '/Users/x/.nvm/bin/opencode'; } });
  assert.deepEqual(hit, { path: '/Users/x/.nvm/bin/opencode', source: 'path' });
  assert.equal(asked, 1);
  const direct = await refreshOpencodeBinary({ ...base, isExecutable: (p) => p === '/opt/homebrew/bin/opencode', loginShell: async () => { asked++; return null; } });
  assert.equal(direct.source, 'homebrew'); assert.equal(asked, 1, 'no login shell when found');
  const miss = await refreshOpencodeBinary({ ...base, isExecutable: () => false, loginShell: async () => null });
  assert.deepEqual(miss, { path: null, source: null });
});

test('opencodeVersion parses `--version`; null on failure; compareOpencodeVersions orders x.y.z', posixOnly, async () => {
  const { zip } = fakeRelease('opencode 1.18.32');
  const out = tmp(); execFileSync('/usr/bin/ditto', ['-x', '-k', zip, out]);
  assert.equal(await opencodeVersion(path.join(out, 'opencode')), '1.18.32');
  assert.equal(await opencodeVersion('/nonexistent/opencode'), null);
  assert.equal(compareOpencodeVersions('1.18.0', '1.18.0'), 0);
  assert.equal(compareOpencodeVersions('1.17.20', '1.18.0'), -1);
  assert.equal(compareOpencodeVersions('1.18.10', '1.18.9'), 1);
  assert.equal(compareOpencodeVersions('1.18.0-beta.1', '1.18.0'), -1);
});

// ---- install ----

test('install happy path: download → sha256 → ditto → --version → atomic current symlink; phases in order', { ...posixOnly, timeout: 90_000 }, async () => {
  const { zip, sha } = fakeRelease(OPENCODE_PINNED_VERSION);
  const root = tmp(); const seen: SwarmInstallState[] = [];
  const urls: string[] = [];
  const final = await installOpencode({
    onProgress: (s) => seen.push(s),
    deps: {
      root, platform: 'darwin', arch: 'arm64', operationId: 'op1',
      checksums: { [OPENCODE_PINNED_VERSION]: { arm64: sha } },
      download: async (url, dest, o) => { urls.push(url); await copyDownloader(zip)(url, dest, o); },
    },
  });
  assert.equal(final.phase, 'succeeded', final.message ?? '');
  assert.equal(final.installedVersion, OPENCODE_PINNED_VERSION);
  assert.equal(final.operationId, 'op1');
  assert.deepEqual(urls, [`https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_PINNED_VERSION}/opencode-darwin-arm64.zip`]);
  const phases = seen.map((s) => s.phase).filter((p, i, a) => p !== a[i - 1]);
  assert.deepEqual(phases, ['downloading', 'verifying', 'extracting', 'verifying', 'succeeded']);
  assert.ok(seen.some((s) => s.downloadedBytes > 0 && s.totalBytes === s.downloadedBytes));
  assert.equal(fs.readlinkSync(path.join(root, 'current')), OPENCODE_PINNED_VERSION);
  const bin = path.join(root, 'current', 'opencode');
  assert.equal(await opencodeVersion(bin), OPENCODE_PINNED_VERSION);
  assert.deepEqual(fs.readdirSync(root).sort(), [OPENCODE_PINNED_VERSION, 'current'].sort(), 'no partial/tmp leftovers');
  // Re-install over an existing version: still one dir, symlink intact.
  const again = await installOpencode({ deps: { root, platform: 'darwin', arch: 'arm64', checksums: { [OPENCODE_PINNED_VERSION]: { arm64: sha } }, download: copyDownloader(zip) } });
  assert.equal(again.phase, 'succeeded');
  assert.deepEqual(fs.readdirSync(root).sort(), [OPENCODE_PINNED_VERSION, 'current'].sort());
});

test('checksum mismatch: fails before extracting, installs nothing', posixOnly, async () => {
  const { zip } = fakeRelease(OPENCODE_PINNED_VERSION);
  const root = tmp(); let extracted = false;
  const final = await installOpencode({
    deps: {
      root, platform: 'darwin', arch: 'x64', checksums: { [OPENCODE_PINNED_VERSION]: { x64: '0'.repeat(64) } },
      download: copyDownloader(zip), extract: async () => { extracted = true; },
    },
  });
  assert.equal(final.phase, 'failed');
  assert.match(final.message!, /^checksum mismatch: /);
  assert.equal(extracted, false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('verify failure: a binary whose --version fails is not installed; the stderr is in the message', { ...posixOnly, timeout: 90_000 }, async () => {
  const { zip, sha } = fakeRelease('', 3, 'dyld: boom');
  const root = tmp();
  const final = await installOpencode({ deps: { root, platform: 'darwin', arch: 'arm64', checksums: { [OPENCODE_PINNED_VERSION]: { arm64: sha } }, download: copyDownloader(zip) } });
  assert.equal(final.phase, 'failed');
  assert.match(final.message!, /^verify failed: .*dyld: boom/);
  assert.equal(fs.existsSync(path.join(root, 'current')), false);
  // wrong version reported → also verify-failed
  const other = fakeRelease('1.17.0');
  const f2 = await installOpencode({ deps: { root, platform: 'darwin', arch: 'arm64', checksums: { [OPENCODE_PINNED_VERSION]: { arm64: other.sha } }, download: copyDownloader(other.zip) } });
  assert.match(f2.message!, /^verify failed: expected v1\.18\.32, the binary reports 1\.17\.0/);
});

test('cancel mid-download → cancelled, nothing left behind', async () => {
  const root = tmp(); const ac = new AbortController();
  const run = installOpencode({
    signal: ac.signal,
    deps: {
      root, platform: 'darwin', arch: 'arm64', checksums: { [OPENCODE_PINNED_VERSION]: { arm64: 'x' } },
      download: (_u, _d, o) => new Promise((_res, rej) => { o.onBytes(10, 100); o.signal.addEventListener('abort', () => rej(new Error('aborted'))); }),
    },
  });
  setTimeout(() => ac.abort(), 20);
  const final = await run;
  assert.equal(final.phase, 'cancelled');
  assert.deepEqual(fs.readdirSync(root), []);
});

test('network failure, unsupported platform, and a version without a pinned checksum fail closed', async () => {
  const root = tmp();
  const net = await installOpencode({ deps: { root, platform: 'darwin', arch: 'arm64', checksums: { [OPENCODE_PINNED_VERSION]: { arm64: 'x' } }, download: async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); } } });
  assert.equal(net.phase, 'failed'); assert.match(net.message!, /ENOTFOUND/);
  const linux = await installOpencode({ deps: { root, platform: 'linux', arch: 'x64', download: async () => assert.fail('no download') } });
  assert.equal(linux.phase, 'failed'); assert.match(linux.message!, /^unsupported platform: /);
  const unpinned = await installOpencode({ version: '1.18.31', deps: { root, platform: 'darwin', arch: 'arm64', download: async () => assert.fail('no download') } });
  assert.equal(unpinned.phase, 'failed'); assert.match(unpinned.message!, /^checksum unavailable: .*v1\.18\.31/);
});

test('the shipped pin has a 64-hex sha256 for both mac architectures', posixOnly, async () => {
  // Drive the real table: a wrong download for the pinned version must report the pinned digest in the mismatch.
  for (const arch of ['arm64', 'x64']) {
    const { zip } = fakeRelease('x');
    const r = await installOpencode({ deps: { root: tmp(), platform: 'darwin', arch, download: copyDownloader(zip) } });
    assert.match(r.message!, /the pinned value is [0-9a-f]{64}\./, arch);
  }
});

test('swarm install: Windows unzips with System32 tar.exe, never a tar found on PATH (GNU tar cannot read zip)', async () => {
  const { windowsTar } = await import('./swarm-install');
  assert.equal(windowsTar({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\tar.exe');
  assert.equal(windowsTar({}), 'C:\\Windows\\System32\\tar.exe');
});
