import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ChildLedger, processStart, windowsStarts } from './children';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (fn: () => boolean, ms = 5000) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50)); return fn(); };

// POSIX process groups and /bin/sh fixtures; Windows reaps with taskkill /T (children.ts signalGroup).
const posixOnly = { skip: process.platform === 'win32' };
test('children: the next daemon reaps a recorded process group (leader + its child) and never a recycled pid', posixOnly, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-children-'));
  const file = path.join(dir, 'state.children.json');
  // A detached leader (its own group, like a pty session) that starts a grandchild ignoring SIGHUP/SIGTERM.
  const leader = spawn('/bin/sh', ['-c', 'trap "" HUP TERM; sleep 60 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const grandchild = Number(await new Promise<string>((r) => leader.stdout!.once('data', (d) => r(String(d).trim()))));
  const a = new ChildLedger(file);
  a.add(leader.pid, 'pane p1 (opencode)');
  assert.ok(await waitFor(() => a.list().length === 1));
  a.flush();
  // a stale row whose pid is ours but whose start time does not match: must not be touched
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')).children;
  rows.push({ pid: process.pid + 0, startedAt: 'Mon Jan  1 00:00:00 2001', what: 'recycled' });
  fs.writeFileSync(file, JSON.stringify({ children: rows }));

  const b = new ChildLedger(file); // the restarted daemon
  const reaped = await b.reapOrphans(300);
  assert.deepEqual(reaped.map((r) => r.pid), [leader.pid]);
  assert.ok(await waitFor(() => !alive(leader.pid!) || leader.exitCode !== null || leader.signalCode !== null), 'leader killed');
  assert.ok(await waitFor(() => !alive(grandchild)), 'its group (the grandchild) killed too');
  assert.ok(alive(process.pid));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).children, [], 'ledger reset');
  assert.equal(await processStart(grandchild), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('children: a chat-lane child (acp / agy / codex) is ledgered while it lives, so a crashed daemon\'s orphan is reaped at the next start', posixOnly, async () => {
  const { setSharedChildLedger, trackChild } = await import('./children');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-children-'));
  const file = path.join(dir, 'state.children.json');
  const ledger = new ChildLedger(file);
  setSharedChildLedger(ledger);
  try {
    const kid = trackChild(spawn('/bin/sh', ['-c', 'sleep 60'], { stdio: 'ignore' }), 'chat gemini (acp)');
    assert.ok(await waitFor(() => ledger.list().some((r) => r.pid === kid.pid)), 'recorded on spawn');
    ledger.flush();
    // the daemon dies here (SIGKILL: nothing removes the row); a new one reaps it
    const reaped = await new ChildLedger(file).reapOrphans(300);
    assert.deepEqual(reaped.map((r) => r.what), ['chat gemini (acp)']);
    assert.ok(await waitFor(() => kid.exitCode !== null || kid.signalCode !== null), 'orphan killed');
    // a child that exits normally leaves the ledger
    const quick = trackChild(spawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' }), 'chat agy');
    await new Promise((r) => quick.once('exit', r));
    assert.ok(await waitFor(() => !ledger.list().some((r) => r.pid === quick.pid)), 'dropped on exit');
  } finally { setSharedChildLedger(null); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('children: Windows start times come from ONE process query for all pids; gone pids are absent', async () => {
  const calls: number[][] = [];
  const list = async (pids?: readonly number[]) => { calls.push([...(pids ?? [])]); return [{ pid: 10, ppid: 1, startedAt: 't10', commandLine: '' }, { pid: 11, ppid: 1, startedAt: '', commandLine: '' }]; };
  const m = await windowsStarts([10, 11, 12], list);
  assert.deepEqual(calls, [[10, 11, 12]]);
  assert.deepEqual([...m], [[10, 't10']]);
  assert.equal((await windowsStarts([], list)).size, 0);
  assert.equal(calls.length, 1, 'no query for no pids');
  assert.equal((await windowsStarts([5], async () => null)).size, 0, 'a failed query reads as gone');
});
