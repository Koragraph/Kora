// The routines webhook receiver (127.0.0.1:8793) must not listen while the Kora surface is "coming soon" (aud2 S3-3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startWebhookReceiver } from './daemon';

test('the webhook receiver starts only when Kora is on', async () => {
  let started = 0;
  const routines = { startReceiver: async () => { started++; return { port: 1 }; } };
  assert.equal(startWebhookReceiver(routines, () => false), false);
  assert.equal(started, 0, 'coming soon: nothing listens');
  assert.equal(startWebhookReceiver(routines, () => true), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(started, 1);
});
