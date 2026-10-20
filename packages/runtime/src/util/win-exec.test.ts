// Windows command resolution (win-exec.ts) and socket → named pipe naming (ipc-path.ts). The pure parts run on every
// OS; the spawn checks run only on Windows (the Windows CI job).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cmdEscapeArg, exeCandidates, npmShimTarget, winCommand, shellCommand } from './win-exec';
import { ipcAddress } from './ipc-path';

const win = process.platform === 'win32';

test('ipcAddress: unchanged off Windows; a stable, per-path named pipe on Windows', () => {
  assert.equal(ipcAddress('/Users/a/.kora/kora.sock', 'darwin'), '/Users/a/.kora/kora.sock');
  const a = ipcAddress('C:\\Users\\a\\.kora\\kora.sock', 'win32');
  assert.match(a, /^\\\\\.\\pipe\\kora-kora\.sock-[0-9a-f]{24}$/);
  assert.equal(ipcAddress('c:\\users\\A\\.kora\\kora.sock', 'win32'), a, 'case-insensitive like NTFS');
  assert.notEqual(ipcAddress('C:\\Users\\a\\.kora-dev\\kora.sock', 'win32'), a, 'two homes never share a pipe');
  assert.equal(ipcAddress('\\\\.\\pipe\\custom', 'win32'), '\\\\.\\pipe\\custom');
});

test('exeCandidates: PATHEXT on Windows only', () => {
  assert.deepEqual(exeCandidates('/x/codex', {}, 'darwin'), ['/x/codex']);
  assert.deepEqual(exeCandidates('C:\\x\\codex', { PATHEXT: '.EXE;.CMD' }, 'win32'), ['C:\\x\\codex.exe', 'C:\\x\\codex.cmd', 'C:\\x\\codex']);
  assert.deepEqual(exeCandidates('C:\\x\\codex.cmd', { PATHEXT: '.EXE;.CMD' }, 'win32'), ['C:\\x\\codex.cmd']);
});

test('npmShimTarget: finds the script an npm .cmd shim runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-winexec-'));
  try {
    fs.mkdirSync(path.join(dir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '');
    const shim = path.join(dir, 'codex.cmd');
    fs.writeFileSync(shim, '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n'
      + 'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\n'
      + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    const t = npmShimTarget(shim);
    assert.ok(t && t.replace(/\\/g, '/').endsWith('node_modules/@openai/codex/bin/codex.js'), String(t));
    fs.writeFileSync(shim, '@echo hello\r\n');
    assert.equal(npmShimTarget(shim), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cmdEscapeArg: every cmd.exe metacharacter is caret-escaped inside MSVC quotes', () => {
  assert.equal(cmdEscapeArg('a b'), '^"a^ b^"');
  assert.equal(cmdEscapeArg('x&y|z'), '^"x^&y^|z^"');
  assert.equal(cmdEscapeArg('say "hi"'), '^"say^ \\^"hi\\^"^"');
  assert.equal(cmdEscapeArg('100%'), '^"100^%^"');
});

test('winCommand / shellCommand: identity off Windows', { skip: win }, () => {
  assert.deepEqual(winCommand('codex', ['exec', 'a b']), { command: 'codex', args: ['exec', 'a b'] });
  assert.deepEqual(shellCommand('echo hi'), { command: '/bin/sh', args: ['-c', 'echo hi'] });
});

test('winCommand: a batch file runs through cmd.exe with its arguments intact', { skip: !win }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-winexec-'));
  try {
    const bat = path.join(dir, 'echoargs.cmd');
    // %1 keeps the quotes winCommand put around each argument, so the batch file's own echo cannot split on `&`.
    fs.writeFileSync(bat, '@echo off\r\n:loop\r\nif [%1]==[] goto :eof\r\necho [%1]\r\nshift\r\ngoto loop\r\n');
    const w = winCommand(bat, ['plain', 'two words', 'a&b', '100%']);
    const r = spawnSync(w.command, w.args, { encoding: 'utf8', windowsVerbatimArguments: w.windowsVerbatimArguments });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split(/\r?\n/), ['["plain"]', '["two words"]', '["a&b"]', '["100%"]']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('winCommand: an npm shim runs its script under node, no cmd.exe', { skip: !win }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-winexec-'));
  try {
    fs.mkdirSync(path.join(dir, 'node_modules', 'tool'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'tool', 'cli.js'), 'console.log(JSON.stringify(process.argv.slice(2)))');
    fs.writeFileSync(path.join(dir, 'tool.cmd'), '@"%_prog%"  "%dp0%\\node_modules\\tool\\cli.js" %*\r\n');
    const w = winCommand(path.join(dir, 'tool'), ['a "q"', '100%']);
    assert.equal(w.command, process.execPath);
    const r = spawnSync(w.command, w.args, { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(r.stdout), ['a "q"', '100%']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('winCommand: a #! script runs under Git bash', { skip: !win }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-winexec-'));
  try {
    const sh = path.join(dir, 'hello.sh');
    fs.writeFileSync(sh, '#!/bin/sh\necho "hi $1"\n');
    const w = winCommand(sh, ['there']);
    const r = spawnSync(w.command, w.args, { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), 'hi there', r.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
