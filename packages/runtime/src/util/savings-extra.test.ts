import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bashTrimMode, quickAnswersOn, injectRecallOn, resetSavingsSettingsCache, swarmBoundedReadsMode, swarmTokenCeiling, SWARM_TOKEN_CEILING_DEFAULT } from './savings-settings';

const home = () => { resetSavingsSettingsCache(); return fs.mkdtempSync(path.join(os.tmpdir(), 'kora-sav-')); };

test('settings.json is the source; savings.json is only a fallback; env beats files; defaults otherwise', () => {
  const h = home();
  assert.equal(injectRecallOn(h, {} as any), true);
  assert.equal(swarmTokenCeiling(h, {} as any), SWARM_TOKEN_CEILING_DEFAULT);
  assert.equal(swarmBoundedReadsMode(h, {} as any), 'shadow');
  fs.writeFileSync(path.join(h, 'savings.json'), JSON.stringify({ injectRecall: false, swarmTokenCeiling: 123456 }));
  fs.writeFileSync(path.join(h, 'settings.json'), JSON.stringify({ boundedReads: 'on', injectRecall: true }));
  resetSavingsSettingsCache();
  assert.equal(injectRecallOn(h, {} as any), true, 'settings.json wins over the older savings.json');
  assert.equal(swarmTokenCeiling(h, {} as any), 123456, 'a key only savings.json has still applies');
  fs.writeFileSync(path.join(h, 'settings.json'), JSON.stringify({ boundedReads: 'on', injectRecall: false, swarmTokenCeiling: 0, quickAnswers: false, bashTrim: 'on' }));
  resetSavingsSettingsCache();
  assert.equal(injectRecallOn(h, {} as any), false);
  assert.equal(swarmTokenCeiling(h, {} as any), 0, '0 = no ceiling, set in Settings');
  assert.equal(quickAnswersOn(h, {} as any), false);
  assert.equal(bashTrimMode(h, {} as any), 'on');
  assert.equal(bashTrimMode(home(), {} as any), 'on', 'on by default');
  assert.equal(quickAnswersOn(home(), {} as any), true);
  assert.equal(swarmBoundedReadsMode(h, {} as any), 'on', 'the Settings > Bounded reads switch governs workers too');
  assert.equal(injectRecallOn(h, { KORA_INJECT_RECALL: '1' } as any), true, 'env beats files');
  assert.equal(swarmTokenCeiling(h, { KORA_SWARM_TOKEN_CEILING: '0' } as any), 0, '0 = no ceiling');
  assert.equal(swarmBoundedReadsMode(h, { KORA_SWARM_BOUND_READ: 'off' } as any), 'off');
  fs.writeFileSync(path.join(h, 'settings.json'), '{}');
  fs.writeFileSync(path.join(h, 'savings.json'), '{ not json');
  resetSavingsSettingsCache();
  assert.equal(injectRecallOn(h, {} as any), true, 'a damaged file is the defaults');
});
