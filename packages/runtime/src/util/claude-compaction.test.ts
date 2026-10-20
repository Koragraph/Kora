import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCompactAt, claudeCompactEnv, claudeCompactWindow } from './claude-compaction';
import { sessionBaseEnv } from '../session/drivers/claude-driver';

function homeWith(settings?: unknown): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-compact-'));
  if (settings !== undefined) fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
  return home;
}

test('compaction size: 200k by default, 400k and full on request, junk falls back to 200k', () => {
  assert.equal(claudeCompactAt(homeWith()), '200k');
  assert.equal(claudeCompactAt(homeWith({})), '200k');
  assert.equal(claudeCompactAt(homeWith({ claudeCompactAt: 'nonsense' })), '200k');
  assert.equal(claudeCompactAt(homeWith({ claudeCompactAt: '400k' })), '400k');
  assert.equal(claudeCompactAt(homeWith({ claudeCompactAt: 'full' })), 'full');
});

test('compaction env: the window variable for 200k/400k, nothing for full, never for an explicit [1m] pick', () => {
  assert.deepEqual(claudeCompactEnv('sonnet', homeWith()), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' });
  assert.deepEqual(claudeCompactEnv(undefined, homeWith({ claudeCompactAt: '400k' })), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' });
  assert.deepEqual(claudeCompactEnv('opus', homeWith({ claudeCompactAt: 'full' })), {});
  assert.deepEqual(claudeCompactEnv('opus[1m]', homeWith()), {});
  assert.equal(claudeCompactWindow('sonnet', homeWith()), 200_000);
  assert.equal(claudeCompactWindow('sonnet', homeWith({ claudeCompactAt: 'full' })), null);
  // the session env strips inherited CLAUDE_CODE_* markers, so it is added AFTER sessionBaseEnv (driver does)
  assert.equal(sessionBaseEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1', A: 'b' }).CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
});

test('compaction: Haiku 5.5 compacts at 100k by default (its 5x tier starts there); 400k / full keep the user pick', () => {
  assert.deepEqual(claudeCompactEnv('claude-haiku-5-5', homeWith()), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '133000' });
  assert.equal(claudeCompactWindow('claude-haiku-5-5', homeWith({ claudeCompactAt: '400k' })), 400_000);
  assert.equal(claudeCompactWindow('claude-haiku-5-5', homeWith({ claudeCompactAt: 'full' })), null);
  assert.equal(claudeCompactWindow('claude-haiku-4-5-20251001', homeWith()), 200_000, 'Haiku 4.5 has no long tier');
});
