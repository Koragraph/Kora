// The daemon's swarm socket surface: `swarm.getStatus` (fixture shape), `swarm.status` notifications on a setup
// change, `swarm.reportEvent` validation, `chat.thread.setAgentMode` param validation. A real createServer on the
// test-isolate socket; restore/sweep off.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer, type ServerHandle } from './daemon';
import { KoraClient } from '../protocol/client';
import { koraHome, type SwarmStatus } from '../protocol/types';
import { readControlToken } from './control-auth';

const FIXTURE = path.resolve(__dirname, '..', '..', '..', 'contracts', 'src', 'fixtures', 'swarm-status.sample.json');
function deepKeys(v: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) { for (const el of v) deepKeys(el, `${prefix}[]`, out); return out; }
  if (v && typeof v === 'object') for (const [k, c] of Object.entries(v)) { const p = prefix ? `${prefix}.${k}` : k; out.add(p); deepKeys(c, p, out); }
  return out;
}

let handle: ServerHandle; let client: KoraClient;
test.before(async () => {
  handle = await createServer({ socketPath: process.env.KORA_SOCKET_PATH!, restore: false, sweep: false });
  client = new KoraClient(process.env.KORA_SOCKET_PATH!); client.control = readControlToken(koraHome()) ?? undefined; await client.connect();
});
test.after(async () => { client?.close(); await handle?.close().catch(() => {}); });

test('socket swarm.getStatus returns a SwarmStatus inside the fixture key set', async () => {
  const s = await client.call('swarm.getStatus', {});
  const want = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(Object.keys(s).sort(), Object.keys(want).sort());
  const allowed = deepKeys(want);
  for (const k of deepKeys(s)) assert.ok(allowed.has(k), `unexpected key ${k}`);
  assert.equal(s.ready, false);
  assert.ok(s.blockers.some((b) => b.code === 'consent-missing'));
});

test('a setup change is pushed to subscribers as the `swarm.status` notification', async () => {
  await client.call('events.subscribe', {});
  const got = new Promise<SwarmStatus>((resolve) => client.on('swarm.status', (s) => resolve(s)));
  await handle.runtime.swarmSetup.setConsent({ noticeVersion: 1, accepted: true });
  const s = await Promise.race([got, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no swarm.status within 5 s')), 5000))]);
  assert.equal(s.consent.acceptedVersion, 1);
  assert.ok(!s.blockers.some((b) => b.code === 'consent-missing'));
});

test('swarm.reportEvent rejects an unknown event type; chat.thread.setAgentMode rejects an unknown mode', async () => {
  await assert.rejects(client.call('swarm.reportEvent', { paneId: 'p1', type: 'bogus' as any }), /unknown swarm event type/);
  await assert.rejects(client.call('chat.thread.setAgentMode', { threadId: 't1', agentMode: 'hive' as any }), /agentMode must be/);
});
