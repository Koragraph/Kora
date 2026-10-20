import test from 'node:test';
import assert from 'node:assert/strict';

import { KORA_EDITION, isProEdition, proOnlyMessage, setEditionForTests } from './edition';
import { normalizeSwarmConfigForTests } from './config';

test('this build is the free edition', () => {
  assert.equal(KORA_EDITION, 'free');
  assert.equal(isProEdition(), false);
});

test('free edition: an old config asking for Koragent workers runs OpenCode', () => {
  setEditionForTests('free');
  assert.equal(normalizeSwarmConfigForTests({ workerBackend: 'koragent' }).workerBackend, 'opencode');
  setEditionForTests('pro');
  assert.equal(normalizeSwarmConfigForTests({ workerBackend: 'koragent' }).workerBackend, 'koragent');
  setEditionForTests('free');
});

test('the refusal names Kora Pro', () => {
  assert.match(proOnlyMessage('Koragent'), /Kora Pro/);
});
