// Deep audit 2026-10-13 A3-2: Stop / interrupt of a CLI turn that ignores SIGTERM. The Codex and OpenCode drivers
// escalated with `if (!child.killed) kill('SIGKILL')`, but Node sets `killed` once SIGTERM is DELIVERED, so the
// escalation never ran and the CLI kept going after Stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { terminateChild } from './engine-common';
import { CodexDriver } from './codex-driver';
import type { DriverDeps } from '../session-driver';

const posixOnly = { skip: process.platform === 'win32' ? "POSIX signals" : false };

const STUBBORN = 'process.on("SIGTERM", () => {}); process.stdout.write("up\\n"); setInterval(() => {}, 1000);';
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exited = (c: ReturnType<typeof spawn>) => new Promise<void>((r) => { if (c.exitCode != null || c.signalCode != null) r(); else c.once('exit', () => r()); });
const ready = (c: ReturnType<typeof spawn>) => new Promise<void>((r) => c.stdout!.once('data', () => r()));

test('terminateChild: a child that ignores SIGTERM is SIGKILLed after the grace', posixOnly, async () => {
  const c = spawn(process.execPath, ['-e', STUBBORN], { stdio: ['ignore', 'pipe', 'ignore'] });
  await ready(c);
  terminateChild(c, 150);
  assert.equal(c.killed, true, 'node marks it killed at once: the reason the old check never escalated');
  await exited(c);
  assert.equal(c.signalCode, 'SIGKILL');
  assert.equal(alive(c.pid!), false);
});

test('Codex: interrupting a turn whose CLI ignores SIGTERM still ends it', async () => {
  let child: ReturnType<typeof spawn> | null = null;
  const spawnFn: any = () => (child = spawn(process.execPath, ['-e', STUBBORN], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const deps = { graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined } as unknown as DriverDeps;
  const d = new CodexDriver(deps, spawnFn, async () => process.execPath);
  await d.startSession({ threadId: 'T', agent: 'codex', cwd: process.cwd(), account: null, runtimeMode: 'full-access' } as any);
  await d.sendTurn({ threadId: 'T', text: 'hi' } as any);
  for (let i = 0; i < 50 && !child; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(child, 'turn spawned');
  await ready(child!);
  await d.interruptTurn('T');
  await Promise.race([exited(child!), new Promise((_, rej) => setTimeout(() => rej(new Error('still running 4 s after Stop')), 4000))]);
  assert.equal(alive((child as any).pid), false);
});
