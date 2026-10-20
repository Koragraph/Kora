// killChild / killPid: macOS sends the signal it was given; Windows ends the exact pid's tree (docs/windows/AUDIT.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { killChild, killPid } from './kill-child';
import { portOwnerCommand } from '../server/health';

function fake(pid: number | undefined, exitCode: number | null = null) {
  const sent: (NodeJS.Signals | undefined)[] = [];
  return { sent, child: { pid, exitCode, signalCode: null, kill(sig?: NodeJS.Signals) { sent.push(sig); return true; } } };
}

test('killChild: POSIX sends exactly the signal given, never a tree kill', () => {
  const trees: number[] = [];
  const a = fake(42); killChild(a.child, undefined, 'darwin', (p) => trees.push(p));
  const b = fake(43); killChild(b.child, 'SIGKILL', 'linux', (p) => trees.push(p));
  assert.deepEqual(a.sent, ['SIGTERM']);
  assert.deepEqual(b.sent, ['SIGKILL']);
  assert.deepEqual(trees, []);
});

test('killChild: Windows ends the live pid tree and sends no signal', () => {
  const trees: number[] = [];
  const live = fake(42); killChild(live.child, 'SIGTERM', 'win32', (p) => trees.push(p));
  const exited = fake(43, 0); killChild(exited.child, 'SIGKILL', 'win32', (p) => trees.push(p));
  assert.deepEqual(trees, [42]);
  assert.deepEqual(live.sent, []);
  assert.deepEqual(exited.sent, []);
  const noPid = fake(undefined); killChild(noPid.child, 'SIGTERM', 'win32', (p) => trees.push(p));
  assert.deepEqual(noPid.sent, ['SIGTERM']);   // never started: nothing to look up, kill() reports it
});

test('killPid: Windows tree kill; POSIX process.kill', () => {
  const trees: number[] = [];
  killPid(7, 'SIGTERM', 'win32', (p) => trees.push(p));
  assert.deepEqual(trees, [7]);
  assert.throws(() => killPid(2 ** 22 + 12345, 'SIGTERM', 'darwin', (p) => trees.push(p)), /ESRCH/);
  assert.deepEqual(trees, [7]);
});

test('portOwnerCommand: lsof on macOS/Linux, netstat on Windows', () => {
  assert.equal(portOwnerCommand(8797, 'darwin'), 'lsof -i :8797');
  assert.equal(portOwnerCommand(8797, 'win32'), 'netstat -ano | findstr :8797');
});
