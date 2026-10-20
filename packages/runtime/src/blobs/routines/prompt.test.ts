import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, tempHome } from './testkit';
tempHome('routines-prompt-');

import { RoutineService } from './service';
import { buildRunPrompt, clip, rememberBlock, stamp } from './prompt';

test('clip never exceeds the cap, marker included', () => {
  for (const n of [10, 50, 2000]) assert.ok(clip('z'.repeat(9000), n).length <= n);
  assert.equal(clip('short', 100), 'short');
});

test('remember block is capped at 2,000 characters of report; empty reports add nothing', () => {
  const b = rememberBlock('q'.repeat(10_000), Date.UTC(2026, 9, 5, 8));
  const inner = /---\n([\s\S]*)\n---/.exec(b)![1]!;
  assert.equal(inner.length, 2000);
  assert.equal(rememberBlock('  ', 1), '');
  assert.equal(rememberBlock(null, null), '');
});

test('a run prompt says it is automatic, carries the routine, and has no webhook block unless asked', () => {
  const p = buildRunPrompt({ routine: { title: 'Brief', prompt: 'Do X.', rememberLastRun: false }, now: 0, source: 'schedule' });
  assert.match(p, /\[Routine: Brief\].*automatic routine run/s);
  assert.match(p, /Do X\./);
  assert.doesNotMatch(p, /UNTRUSTED/);
});

test('stamp renders in the routine zone', () => {
  assert.equal(stamp(Date.UTC(2026, 9, 5, 12, 0), 'America/New_York'), 'Mon 05 Oct 08:00');
});

test('routines, run receipts and webhook hashes survive a restart', async () => {
  const h = harness(Date.UTC(2026, 9, 5, 0, 0));
  const r = h.svc.create({ blobId: h.popo.id, title: 'Persist', prompt: 'p', cadence: { kind: 'weekly', days: [1], time: '08:00', tz: 'UTC' } });
  assert.ok(r.ok);
  const t = h.svc.createTrigger(r.value.id, 'hook'); assert.ok(t.ok);
  h.clock.t = Date.UTC(2026, 9, 5, 8, 0); await h.svc.engine.tick();
  await h.bridge.finish('hid1', { finalText: 'kept' });
  const again = new RoutineService({ blobs: h.store as never, bridge: () => h.bridge.bridge, now: () => h.clock.t, webhookPort: 0 });
  const back = again.get(r.value.id)!;
  assert.equal(back.title, 'Persist');
  assert.equal(back.triggers[0]!.secretHash, h.svc.get(r.value.id)!.triggers[0]!.secretHash);
  const runs = again.store.runsForRoutine(r.value.id);
  assert.equal(runs[0]!.status, 'completed'); assert.equal(runs[0]!.report, 'kept');
  assert.equal(back.cursor, h.svc.get(r.value.id)!.cursor);
});
