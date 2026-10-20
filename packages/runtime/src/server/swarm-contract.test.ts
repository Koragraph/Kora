// Drift guard between the two type systems (ref-reconciled §0: the runtime does not import @kora/contracts, so every
// swarm shape exists twice — TS interfaces in protocol/types.ts and Effect schemas in packages/contracts).
//
// Both sides are pinned to the SAME JSON files, packages/contracts/src/fixtures/*.json:
//   • contracts/src/swarm.test.ts decodes them strictly (no unknown keys) and round-trips them;
//   • this file asserts the deep key set of a fully-populated, TYPED runtime literal equals the fixture's.
// Adding a field to a runtime interface makes the typed literal below fail to compile until it is filled in; the
// key-set check then fails until the fixture has it; the contracts test then fails until the schema has it.
//
// How S2 / S4 keep this green:
//   • S4 (SwarmSetup.getStatus real): the "real status" test starts running (it skips while the stub throws
//     `not implemented`). A real status may have empty arrays / nulls, so it must be a SUBSET of the fixture's key
//     set with the same top-level keys. Never add a key to SwarmStatus without a CCR updating the fixture + schema.
//   • S2 (SwarmWorkerMeta on Pane, toFleetSwarmWorker in ui-server): keep SwarmWorkerMeta key-for-key equal to
//     FleetSwarmWorker + `reportPath`; toFleetSwarmWorker drops exactly `reportPath` (asserted in ui-server by S2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SwarmStatus, SwarmWorkerMeta } from '../protocol/types';
import { DEFAULTS } from '../config';
import { SwarmNotReadyError } from './swarm-errors';
import { SwarmSetup } from './swarm-setup';
import { SwarmHealth } from './swarm-health';

// dist/server/ → packages/contracts/src/fixtures
const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'contracts', 'src', 'fixtures');
const fixture = (name: string): any => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

/** Every key path in a JSON value; array elements contribute the union of their keys under `[]`. */
function deepKeys(v: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) { for (const el of v) deepKeys(el, `${prefix}[]`, out); return out; }
  if (v && typeof v === 'object') {
    for (const [k, child] of Object.entries(v)) { const p = prefix ? `${prefix}.${k}` : k; out.add(p); deepKeys(child, p, out); }
  }
  return out;
}
const sorted = (s: Set<string>) => [...s].sort();

// Fully populated (every nullable branch non-null somewhere) so the key set is complete.
const STATUS_MIRROR: SwarmStatus = {
  ready: false,
  blockers: [{ code: 'consent-missing', message: 'm' }],
  opencode: { installed: true, path: '/x', source: 'kora', version: '1.18.32', minVersion: '1.18.0', versionOk: true, onDaemonPath: false },
  install: { operationId: 'op', phase: 'idle', downloadedBytes: 0, totalBytes: 1, version: 'v', installedVersion: 'v', message: 'm' },
  consent: { requiredVersion: 1, acceptedVersion: 1, acceptedAt: 1 },
  providers: [{
    provider: 'openrouter', enabled: true, keyRequired: true, hasKey: true, keySource: 'kora', keyHint: 'h',
    lastTest: {
      ok: true, outcome: 'ok', message: 'm', freeModels: ['m'], latencyMs: 1, testedAt: 1,
      limits: { requestsPerMinute: 1, requestsPerDay: 1, remainingToday: 1, resetsAt: 1, isFreeTier: true },
    },
    limits: { requestsPerMinute: 1, requestsPerDay: 1, remainingToday: 1, resetsAt: 1, isFreeTier: true },
  }],
  models: {
    available: [{ id: 'opencode/big-pickle', provider: 'zen', label: 'big-pickle', rank: 0, maxConcurrent: 1 }],
    cooling: [{ model: 'm', provider: 'openrouter', until: 1, reason: 'r' }],
  },
  preferences: { providerOrder: ['zen'], defaultModel: 'm', maxWorkers: 4 },
  keyStorage: 'file',
  checkedAt: 1,
  supplyState: {
    supply: 'free-first',
    paid: { enabled: false, maxTaskUsd: 0.05, models: ['m'] },
    local: { ollama: { enabled: false, baseUrl: 'u', models: ['m'] }, lmstudio: { enabled: false, baseUrl: 'u', models: ['m'] } },
  },
};

const WORKER_MIRROR: SwarmWorkerMeta = {
  taskId: 's3', provider: 'zen', model: 'opencode/big-pickle', modelLabel: 'big-pickle', phase: 'done', attempt: 2,
  attempts: [{ paneId: 'p5', provider: 'openrouter', model: 'm', outcome: 'rate-limited', at: 1 }],
  reportPath: '/w/.kora/swarm/s3.md',
  report: { bytes: 1, updatedAt: 1, preview: 'p' },
  supersededBy: 'p9', previousPaneIds: ['p5'],
  verify: { state: 'passed', bounces: 1, summary: 's' },
};

test('SwarmStatus (runtime TS) has exactly the key set of contracts/src/fixtures/swarm-status.sample.json', () => {
  assert.deepEqual(sorted(deepKeys(STATUS_MIRROR)), sorted(deepKeys(fixture('swarm-status.sample.json'))));
});

test('SwarmWorkerMeta minus reportPath has exactly the key set of FleetWorker.swarm in fleet-worker-swarm.sample.json', () => {
  const { reportPath: _drop, ...wire } = WORKER_MIRROR;
  assert.deepEqual(sorted(deepKeys(wire)), sorted(deepKeys(fixture('fleet-worker-swarm.sample.json').swarm)));
});

test('real SwarmSetup.getStatus() stays inside the fixture key set', async () => {
  const setup = new SwarmSetup({ health: new SwarmHealth() });
  const status: SwarmStatus = await setup.getStatus();
  const want = fixture('swarm-status.sample.json');
  assert.deepEqual(Object.keys(status).sort(), Object.keys(want).sort());
  const allowed = deepKeys(want);
  for (const k of deepKeys(status)) assert.ok(allowed.has(k), `unexpected key ${k} — contract drift (CCR the fixture + schema)`);
});

test('config DEFAULTS.swarm: Cerebras off, verify-and-bounce on with 2 bounces, consent unset', () => {
  assert.deepEqual(DEFAULTS.swarm.providers, { zen: true, openrouter: true, cerebras: false });
  assert.equal(DEFAULTS.swarm.autoVerify, true);
  assert.equal(DEFAULTS.swarm.maxBounces, 2);
  assert.equal(DEFAULTS.swarm.consent, null);
  assert.deepEqual(DEFAULTS.swarm.providerOrder, ['zen', 'openrouter', 'cerebras']);
});

test('SwarmNotReadyError names the blockers and the fix', () => {
  const e = new SwarmNotReadyError([{ code: 'opencode-missing', message: 'OpenCode is not installed' }]);
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'SwarmNotReadyError');
  assert.match(e.message, /^swarm unavailable: OpenCode is not installed\. /);
  assert.match(e.message, /Settings → Swarm or with `kora swarm setup`/);
  const cooling = new SwarmNotReadyError([{ code: 'all-models-cooling', message: 'every model is cooling' }], { nextFreeAt: Date.now() + 60_000 });
  assert.match(cooling.message, /Next model frees up at /);
});

test('every frozen swarm module export exists (W0 names are real import paths)', () => {
  const want: Record<string, string[]> = {
    './swarm': ['SwarmService'],
    './swarm-setup': ['SwarmSetup'],
    './swarm-health': ['SwarmHealth'],
    './swarm-errors': ['SwarmNotReadyError'],
    './swarm-context': ['buildSwarmContextPacket', 'checkSwarmOverlap'],
    './swarm-catalog': ['SWARM_MODEL_SEED', 'refreshSwarmCatalog'],
    './swarm-install': ['resolveOpencodeBinary', 'opencodeVersion', 'installOpencode', 'OPENCODE_MIN_VERSION', 'OPENCODE_PINNED_VERSION'],
    './swarm-secrets': ['getSwarmKey', 'setSwarmKey', 'clearSwarmKey', 'swarmKeySource', 'keyHint'],
    './swarm-probe': ['probeZen', 'probeOpenRouter', 'probeCerebras'],
    './swarm-skill': ['swarmPlaybook', 'swarmPlaybookPath', 'claudeSwarmSkillDoc', 'installSwarmSkill', 'swarmModeNotice', 'swarmWorkerPreamble', 'chatSwarmPrompt'],
    './swarm-opencode': ['swarmPaneEnv', 'swarmPermissionEnv', 'writeOpencodePlugin'],
  };
  for (const [mod, names] of Object.entries(want)) {
    const m = require(mod);
    for (const n of names) assert.ok(m[n] !== undefined, `${mod} exports ${n}`);
  }
});
