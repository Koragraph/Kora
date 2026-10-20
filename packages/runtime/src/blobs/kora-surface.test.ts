// Kora is coming soon (edition.ts): with the Kora surface off the blob runtime starts no background work — no warm Haiku
// routing session, no memory maintenance (the mirror refresh that starts the memory worker, retries, summaries), no
// routine scheduler / webhook receiver and no job sweeper. With the developer override (on) all of it starts as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-surface-'));
process.env.KORA_BLOBS_ROOT = path.join(root, 'Blobs');
process.env.KORA_HOME = path.join(root, 'kora-home');

import { BlobStore } from './store';
import { BlobRuntimeImpl } from './runtime';
import type { MemoryHost } from './memory-host';
import { KORA_SURFACE, isKoraSurfaceOn, koraSurface, setKoraSurfaceForTests } from '../edition';

const ENGINE = { instanceId: 'claude', model: 'sonnet', effort: null };

/** A memory host that only records which methods were called (any call = the real worker would have started). */
function spyMemory(): { host: MemoryHost; calls: string[] } {
  const calls: string[] = [];
  const host = new Proxy({} as Record<string, unknown>, {
    get: (_t, key) => {
      if (key === 'then') return undefined;
      if (key === 'setExtractor' || key === 'cancelTidy') return () => {};
      return async () => { calls.push(String(key)); return null; };
    },
  }) as unknown as MemoryHost;
  return { host, calls };
}

/** Everything routineBridgeFrom wants, so an attached engine would start the scheduler. */
const bridge = {
  startHiddenThread: async () => ({ threadId: 't' }), createResultsThread: async () => ({ threadId: 'r' }),
  postRoutineReport: async () => {}, snapshot: () => null, onSettled: () => () => {},
};

function setup(surfaceOn: boolean) {
  fs.rmSync(path.join(process.env.KORA_HOME!, 'blobs'), { recursive: true, force: true });
  const store = new BlobStore();
  if (!store.list().length) store.create({ name: 'Popo', title: 'Researcher', soul: 'Curious.', engine: ENGINE });
  const { host, calls } = spyMemory();
  let prewarms = 0;
  const oneShot = Object.assign(async () => null, { prewarm: () => { prewarms++; } });
  const rt = new BlobRuntimeImpl({ store, memory: host, oneShot, koraCmd: 'kora', userSkillDirs: [], surfaceOn: () => surfaceOn });
  const started = { routines: 0, team: 0 };
  rt.routines.start = () => { started.routines++; };
  rt.team.attachEngine = () => { started.team++; };
  return { rt, memoryCalls: calls, prewarms: () => prewarms, started };
}

test('every build ships with the Kora surface coming soon; the override and the test setter turn it on', () => {
  assert.equal(KORA_SURFACE, 'coming-soon');
  const saved = process.env.KORA_SURFACE;
  try {
    delete process.env.KORA_SURFACE;
    setKoraSurfaceForTests(null);
    assert.equal(koraSurface(), 'coming-soon', 'no override = coming soon');
    process.env.KORA_SURFACE = 'on';
    assert.equal(isKoraSurfaceOn(), true, 'KORA_SURFACE=on turns Kora on');
    process.env.KORA_SURFACE = 'coming-soon';
    setKoraSurfaceForTests('on');
    assert.equal(isKoraSurfaceOn(), true, 'the test setter wins');
  } finally {
    setKoraSurfaceForTests(null);
    if (saved === undefined) delete process.env.KORA_SURFACE; else process.env.KORA_SURFACE = saved;
  }
});

test('the override file <KORA_HOME>/kora-surface turns Kora on', () => {
  const saved = { surface: process.env.KORA_SURFACE, home: process.env.KORA_HOME };
  try {
    delete process.env.KORA_SURFACE;
    setKoraSurfaceForTests(null);
    const home = fs.mkdtempSync(path.join(root, 'home-file-'));
    process.env.KORA_HOME = home;
    fs.writeFileSync(path.join(home, 'kora-surface'), 'on\n');
    assert.equal(isKoraSurfaceOn(), true);
    process.env.KORA_HOME = fs.mkdtempSync(path.join(root, 'home-none-'));
    assert.equal(isKoraSurfaceOn(), false, 'another home without the file is coming soon');
  } finally {
    process.env.KORA_HOME = saved.home;
    if (saved.surface === undefined) delete process.env.KORA_SURFACE; else process.env.KORA_SURFACE = saved.surface;
  }
});

test('coming soon: no warm Haiku, no memory worker, no routine scheduler, no job sweeper', async () => {
  const { rt, memoryCalls, prewarms, started } = setup(false);
  rt.prewarmRouting();
  assert.equal(prewarms(), 0, 'the routing model is never warmed');
  const stop = rt.startMaintenance();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(memoryCalls, [], 'the memory worker is never asked anything');
  rt.attachEngine(bridge);
  assert.equal(started.routines, 0, 'the routine scheduler + webhook receiver stay stopped');
  assert.equal(started.team, 0, 'the job sweeper stays stopped');
  stop();
  await rt.close();
});

test('coming soon: `kora mcp --team` refuses with a clear message', async () => {
  const { run } = await import('../cli/commands/mcp-team');
  const err: string[] = [];
  setKoraSurfaceForTests('coming-soon');
  try {
    const code = await run(['--token', 'kt_x'], { out: () => {}, err: (s) => err.push(s) });
    assert.equal(code, 2);
    assert.match(err.join(''), /Kora is coming soon/);
  } finally {
    setKoraSurfaceForTests(null);
  }
});

test('override on: the warm Haiku, the memory maintenance, the scheduler and the job sweeper all start', async () => {
  const { rt, memoryCalls, prewarms, started } = setup(true);
  rt.prewarmRouting();
  assert.equal(prewarms(), 1);
  const stop = rt.startMaintenance();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(memoryCalls.length > 0, 'the boot mirror refresh reads memory');
  rt.attachEngine(bridge);
  assert.equal(started.routines, 1);
  assert.equal(started.team, 1);
  stop();
  await rt.close();
});
