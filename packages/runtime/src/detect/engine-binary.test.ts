// The engine CLI resolver: the daemon's bare PATH must not make `codex` unfindable (found live: `spawn codex ENOENT`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { engineSearchDirs, engineSpawnEnv, engineSpawnProblem, resolveEngineBinary, resolveEngineBinaryAsync } from './engine-binary';

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-home-'));
  const put = (rel: string) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 }); return f; };
  return { home, put };
}
const BARE = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
// macOS/Linux install layouts (extensionless binaries, mode bits, Homebrew); Windows has its own test below.
const posixOnly = { skip: process.platform === 'win32' };

test('a bare daemon PATH still finds codex in ~/.local/bin, Homebrew-style and nvm global bins', posixOnly, () => {
  const { home, put } = fakeHome();
  assert.equal(resolveEngineBinary('codex', { env: BARE, home }), null, 'nothing installed yet');
  const local = put('.local/bin/codex');
  assert.equal(resolveEngineBinary('codex', { env: BARE, home }), local);
  const { home: h2, put: p2 } = fakeHome();
  const nvm = p2('.nvm/versions/node/v22.1.0/bin/codex');
  p2('.nvm/versions/node/v20.0.0/bin/codex');
  assert.equal(resolveEngineBinary('codex', { env: BARE, home: h2 }), nvm, 'newest node version first');
  const { home: h3, put: p3 } = fakeHome();
  assert.equal(resolveEngineBinary('claude', { env: BARE, home: h3 }), null);
  const bun = p3('.bun/bin/claude');
  assert.equal(resolveEngineBinary('claude', { env: BARE, home: h3 }), bun);
});

test('the daemon PATH wins; a non-executable file is not a hit', posixOnly, () => {
  const { home, put } = fakeHome();
  const onPath = put('bin/codex'); put('.local/bin/codex');
  assert.equal(resolveEngineBinary('codex', { env: { PATH: path.join(home, 'bin') }, home }), onPath);
  const { home: h2 } = fakeHome();
  fs.mkdirSync(path.join(h2, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(h2, '.local', 'bin', 'codex'), 'x', { mode: 0o644 });
  assert.equal(resolveEngineBinary('codex', { env: BARE, home: h2 }), null);
});

test('login-shell fallback finds what only .zshrc knows; a miss stays a miss', async () => {
  const { home, put } = fakeHome();
  const odd = put('weird/place/codex');
  assert.equal(await resolveEngineBinaryAsync('codex', { env: BARE, home, loginShell: async () => odd, isExecutable: (p) => p === odd }), odd);
  assert.equal(await resolveEngineBinaryAsync('codex', { env: BARE, home, loginShell: async () => null }), null);
});

test('spawn env gets the widened PATH and the binary dir first', posixOnly, () => {
  const { home } = fakeHome();
  const env = engineSpawnEnv({ ...BARE, HOME: home }, '/opt/x/bin/codex');
  const dirs = String(env.PATH).split(path.delimiter);
  assert.equal(dirs[0], '/opt/x/bin');
  assert.ok(dirs.includes('/usr/bin') && dirs.includes('/opt/homebrew/bin'));
  assert.ok(engineSearchDirs({ PATH: '/a' }, home).includes(path.join(home, '.local', 'bin')));
});

test('Windows: npm / pnpm global shims are found by PATHEXT; a file without a PATHEXT extension is not a hit', { skip: process.platform !== 'win32' }, () => {
  const { home } = fakeHome();
  const env = { PATH: 'C:\\nowhere', PATHEXT: '.COM;.EXE;.BAT;.CMD', APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
  assert.equal(resolveEngineBinary('codex', { env, home }), null, 'nothing installed yet');
  const npmDir = path.join(env.APPDATA, 'npm'); fs.mkdirSync(npmDir, { recursive: true });
  fs.writeFileSync(path.join(npmDir, 'codex'), '#!/bin/sh\n'); // npm writes this sh shim beside the .cmd: not runnable here
  assert.equal(resolveEngineBinary('codex', { env, home }), null);
  fs.writeFileSync(path.join(npmDir, 'codex.cmd'), '@echo off\r\n');
  assert.equal(resolveEngineBinary('codex', { env, home }), path.join(npmDir, 'codex.cmd'));
  assert.equal(String(engineSpawnEnv(env, path.join(npmDir, 'codex.cmd')).PATH).split(path.delimiter)[0], npmDir);
});

test('ENOENT / EACCES read as a sentence that names the engine and Settings › Engines, never the raw error', () => {
  const m = engineSpawnProblem('codex', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }))!;
  assert.match(m, /Codex isn't installed or Kora can't find it/);
  assert.match(m, /Settings › Engines/);
  assert.doesNotMatch(m, /ENOENT|spawn/);
  assert.match(engineSpawnProblem('opencode', new Error('spawn /x/opencode ENOENT'))!, /OpenCode/);
  assert.match(engineSpawnProblem('claude', { code: 'EACCES' })!, /isn't allowed to run/);
  assert.equal(engineSpawnProblem('codex', new Error('boom')), null);
});
