// A2: the shared daemon bootstrap helper. ensureAndConnect on a cold socket must autostart the
// daemon and hand back a connected client that can call server.status; a second call attaches to
// the now-running daemon without starting another.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureAndConnect, isSocketAlive } from './daemon';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-boot-'));
const sock = path.join(home, 's.sock');
process.env.KORA_HOME = home;
process.env.KORA_SOCKET_PATH = sock;
process.env.KORA_AUTO_INGEST = '0'; process.env.KORA_UI_PORT = '0'; // a test daemon must never take the chat UI port
process.env.KORA_WORKTREES_DEFAULT = '0';

test.after(async () => {
  // stop the detached daemon this test spawned, then wait for the socket to go away. server.shutdown needs the control
  // token, which a run inside an agent shell never sends: fall back to the exact pid server.ping reports, or the
  // daemon outlives the run (six were found alive hours later, 2026-10-14).
  let pid = 0;
  try {
    const { client } = await ensureAndConnect({ socketPath: sock });
    try { pid = Number((await client.call('server.ping', {}) as { pid?: number })?.pid) || 0; } catch { /* no pid */ }
    try { await client.call('server.shutdown', {}); } catch { /* refused without the token */ }
    client.close();
  } catch { /* already down */ }
  for (let i = 0; i < 40 && (await isSocketAlive(sock, 300)); i++) await new Promise((r) => setTimeout(r, 50));
  if (pid && pid !== process.pid && (await isSocketAlive(sock, 300))) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    for (let i = 0; i < 40 && (await isSocketAlive(sock, 300)); i++) await new Promise((r) => setTimeout(r, 50));
  }
});

test('ensureAndConnect cold-starts the daemon and returns a working client', async () => {
  assert.equal(await isSocketAlive(sock, 300), false, 'socket is cold before the test');

  const first = await ensureAndConnect({ socketPath: sock });
  assert.equal(first.started, true, 'cold call spawned the daemon');
  const status = await first.client.call('server.status', {});
  assert.ok(status && typeof status === 'object', 'server.status returns over the fresh connection');
  first.client.close();

  const second = await ensureAndConnect({ socketPath: sock });
  assert.equal(second.started, false, 'second call attaches to the running daemon');
  await second.client.call('server.ping', {});
  second.client.close();
});
