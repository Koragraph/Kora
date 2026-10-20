// Multi-frontend pane-size ownership (desktop Step 0 / hazard H1).
// Two connections share one pane: pane.focus claims size ownership (last-focus-wins),
// and pane.resize from any non-owning connection is ignored so the TUI and GUI don't
// fight over one PTY's cols×rows. Disconnecting the owner releases the claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './daemon';
import { KoraClient } from '../protocol/client';
import { readControlToken } from './control-auth';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-size-'));
const sock = path.join(home, 's.sock');
process.env.KORA_HOME = home;
process.env.KORA_SOCKET_PATH = sock;
process.env.KORA_AUTO_INGEST = '0';
process.env.KORA_WORKTREES_DEFAULT = '0';

let handle: Awaited<ReturnType<typeof createServer>>;
// The test owns this daemon: its client holds the throwaway home's control token, as a person's terminal would, also
// when the run starts inside a Kora agent pane (the agent marker withholds the env-derived token).
async function client(): Promise<KoraClient> { const c = new KoraClient(sock); c.control = readControlToken(path.dirname(sock)) ?? readControlToken(home) ?? undefined; await c.connect(3000); return c; }

test.before(async () => { handle = await createServer({ socketPath: sock, restore: false }); });
test.after(async () => { try { await handle.close(); } catch { /* ok */ } });

test('pane.focus claims size ownership; non-owner resize is ignored; owner resize applies', async () => {
  const c1 = await client();
  const c2 = await client();
  const p = await c1.call('pane.spawn', { command: 'sh', args: ['-c', 'sleep 30'], cwd: home, name: 'sz', enforce: false, cols: 80, rows: 24 });

  // unclaimed → any connection may resize
  await c1.call('pane.resize', { paneId: p.id, cols: 100, rows: 30 });
  assert.equal((await c1.call('pane.get', { paneId: p.id })).cols, 100, 'unclaimed resize applies');

  // c2 focuses → c2 owns the geometry
  await c2.call('pane.focus', { paneId: p.id });
  assert.equal((await c1.call('pane.get', { paneId: p.id })).sizeOwnerConnId != null, true, 'focus set an owner');

  // c1 (non-owner) resize is a no-op
  await c1.call('pane.resize', { paneId: p.id, cols: 120, rows: 40 });
  assert.equal((await c1.call('pane.get', { paneId: p.id })).cols, 100, 'non-owner resize ignored');

  // c2 (owner) resize applies
  await c2.call('pane.resize', { paneId: p.id, cols: 200, rows: 50 });
  const owned = await c1.call('pane.get', { paneId: p.id });
  assert.equal(owned.cols, 200, 'owner resize applies');
  assert.equal(owned.rows, 50);

  // owner disconnects → claim released → c1 may resize again
  c2.close();
  for (let i = 0; i < 40; i++) {
    if ((await c1.call('pane.get', { paneId: p.id })).sizeOwnerConnId == null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal((await c1.call('pane.get', { paneId: p.id })).sizeOwnerConnId, null, 'disconnect releases ownership');
  await c1.call('pane.resize', { paneId: p.id, cols: 90, rows: 20 });
  assert.equal((await c1.call('pane.get', { paneId: p.id })).cols, 90, 'resize works after release');

  await c1.call('pane.kill', { paneId: p.id });
  c1.close();
});
