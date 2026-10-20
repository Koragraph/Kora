// Confirmed swarm-worker state (swarm-state.ts), on screens captured live from OpenCode v1.18.32.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { manifestsDir } from '../detect/manifest';
import { swarmIdleConfirmed, swarmWorkingConfirmed } from './swarm-state';

const fixture = (name: string) => fs.readFileSync(path.join(manifestsDir(), 'fixtures', 'opencode', name), 'utf8').split('---8<---\n')[1];
const pane = (screen: string, hinted: 'working' | 'idle' | null = null) => ({ hinted, detectionSnapshot: () => ({ screen, oscTitle: '', oscProgress: '' }) });

test('the start-up blank is neither a confirmed idle nor a confirmed working (the live false-idle)', () => {
  assert.equal(swarmIdleConfirmed(pane('')), false);
  assert.equal(swarmWorkingConfirmed(pane('')), false);
});

test('esc-interrupt footer confirms working; the idle footer (wrapped live) confirms idle', () => {
  assert.equal(swarmWorkingConfirmed(pane(fixture('live-working-esc_interrupt.txt'))), true);
  assert.equal(swarmIdleConfirmed(pane(fixture('live-working-esc_interrupt.txt'))), false);
  assert.equal(swarmIdleConfirmed(pane(fixture('live-idle-miss.txt'))), true);
});

test('the plugin hint confirms either way; a pane that cannot be read (test fake) is trusted', () => {
  assert.equal(swarmIdleConfirmed(pane('', 'idle')), true);
  assert.equal(swarmWorkingConfirmed(pane('', 'working')), true);
  assert.equal(swarmIdleConfirmed({}), true);
});
