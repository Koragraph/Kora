import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-howto-'));
process.env.KORA_HOME = HOME;
import { rulebook, rulebookShort, CONCISE_LINE, CONCISE_SCOPE_LINE } from './howto';
import { saveConfig, invalidateConfig } from '../config';

test('concise (default on): one terse-output line in both rulebooks; rulebookShort stays ≤ 260 tokens', () => {
  invalidateConfig();
  assert.ok(rulebookShort().includes(CONCISE_LINE));
  assert.ok(rulebook().includes('- ' + CONCISE_LINE));
  assert.ok(rulebookShort().length / 4 <= 260, `rulebookShort ≈${Math.ceil(rulebookShort().length / 4)} tokens`);
  assert.match(CONCISE_LINE, /no preamble.*no closing summary.*5x input/);
  // The scope clause rides the instruction file only — the per-turn brief is budgeted.
  assert.ok(rulebook().includes('- ' + CONCISE_SCOPE_LINE));
  assert.ok(!rulebookShort().includes(CONCISE_SCOPE_LINE));
});

test('concise: false drops the line from both', () => {
  saveConfig({ concise: false });
  assert.ok(!rulebookShort().includes(CONCISE_LINE));
  assert.ok(!rulebook().includes(CONCISE_LINE));
  saveConfig({ concise: true });
  assert.ok(rulebookShort().includes(CONCISE_LINE));
});

test.after(() => { fs.rmSync(HOME, { recursive: true, force: true }); });
