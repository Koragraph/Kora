import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanHeadroom, tightReason } from './plan-headroom';
import { claudeRateLimitEventReport } from './usage';

const weekly = (usedPercent: number, resetsAt: number) => ({ id: 'seven_day', kind: 'weekly' as const, label: 'Weekly · all models', windowMinutes: 10080, usedPercent, resetsAt });

test('plan headroom: tight at 85%+, the tightest current window wins, reset or stale windows drop out, a limit counts', () => {
  const now = 1_800_000_000_000;
  const h = new PlanHeadroom();
  assert.equal(h.tight(now), null);
  h.observe({ provider: 'claude', windows: [weekly(74, now + 86_400_000)] }, now);
  assert.equal(h.tight(now), null, '74% is not tight');
  h.observe({ provider: 'claude', windows: [weekly(90, now + 86_400_000)] }, now);
  assert.equal(h.tight(now)!.window.usedPercent, 90);
  assert.equal(tightReason(h.tight(now)!), 'your Claude Weekly · all models limit is at 90%');
  h.observe({ provider: 'codex', windows: [{ id: 'primary', kind: 'session', label: '5-hour window', usedPercent: 99 }] }, now);
  assert.equal(h.tight(now)!.window.id, 'seven_day', 'another provider is ignored');
  assert.equal(h.tight(now + 86_400_001), null, 'after the reset the window has room again');
  const s = new PlanHeadroom();
  s.observe({ provider: 'claude', windows: [{ id: 'five_hour', kind: 'session', label: '5-hour session', windowMinutes: 300, usedPercent: 95 }] }, now);
  assert.ok(s.tight(now));
  assert.equal(s.tight(now + 301 * 60_000), null, 'an observation older than its own window is stale');
  const l = new PlanHeadroom();
  l.observe({ provider: 'claude', windows: [], limited: true, resetsAt: now + 60_000 }, now);
  assert.equal(tightReason(l.tight(now)!), 'your Claude plan hit a limit');
  assert.equal(l.tight(now + 61_000), null);
});

test('plan headroom: a tight or rejected weekly Sonnet window, or extra usage, never moves new work onto Sonnet', () => {
  const now = 1_800_000_000_000;
  const sonnet = (usedPercent: number) => ({ id: 'seven_day_sonnet', kind: 'weekly' as const, label: 'Weekly · Sonnet', windowMinutes: 10080, usedPercent, resetsAt: now + 86_400_000 });
  const h = new PlanHeadroom();
  h.observe({ provider: 'claude', windows: [sonnet(92)] }, now);
  h.observe({ provider: 'claude', windows: [sonnet(100)], limited: true, resetsAt: now + 86_400_000 }, now);
  h.observe({ provider: 'claude', windows: [{ id: 'overage', kind: 'other', label: 'Extra usage', usedPercent: 99 }], limited: true }, now);
  assert.equal(h.tight(now), null);
  h.observe({ provider: 'claude', windows: [{ id: 'seven_day_opus', kind: 'weekly', label: 'Weekly · Opus', windowMinutes: 10080, usedPercent: 92, resetsAt: now + 86_400_000 }] }, now);
  assert.equal(h.tight(now)!.window.id, 'seven_day_opus', 'the Default family\'s own window counts');
});

test('plan headroom: what it saw survives a restart (persistTo), and stays stale-checked', () => {
  const now = 1_800_000_000_000;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-headroom-')), '.plan-headroom.json');
  const a = new PlanHeadroom(); a.persistTo(file);
  a.observe({ provider: 'claude', windows: [weekly(91, now + 86_400_000)] }, now);
  const b = new PlanHeadroom(); b.persistTo(file);
  assert.equal(b.tight(now + 1000)!.window.usedPercent, 91);
  assert.equal(b.tight(now + 86_400_001), null, 'a reset window still drops out');
  const c = new PlanHeadroom(); c.persistTo(path.join(path.dirname(file), 'missing', 'x.json'));
  assert.equal(c.tight(now), null);
});

test('plan headroom: a Sonnet rejection without a utilization and an overage-included window do not count', () => {
  const now = 1_800_000_000_000;
  const h = new PlanHeadroom();
  h.observe(claudeRateLimitEventReport({ rateLimitType: 'seven_day_sonnet', status: 'rejected', resetsAt: Math.floor(now / 1000) + 86_400 }), now);
  h.observe({ provider: 'claude', windows: [{ id: 'seven_day_overage_included', kind: 'other', label: 'x', usedPercent: 99 }] }, now);
  assert.equal(h.tight(now), null);
  h.observe(claudeRateLimitEventReport({ rateLimitType: 'seven_day', status: 'rejected', resetsAt: Math.floor(now / 1000) + 86_400 }), now);
  assert.ok(h.tight(now)?.limited, 'an all-model rejection still counts');
});
