// The unix socket drives agents (full-access included): only the owning user may dial it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, privateDir } from './daemon';

const posixOnly = { skip: process.platform === 'win32' ? 'unix modes; Windows uses named pipes and profile ACLs' : false };

test('the daemon socket is 0600 and the kora home 0700, even when the home pre-existed world-readable', posixOnly, async () => {
  const home = fs.mkdtempSync(path.join(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir(), 'nh-perm-'));
  fs.chmodSync(home, 0o755);
  const sock = path.join(home, 's.sock');
  process.env.KORA_HOME = home;
  process.env.KORA_SOCKET_PATH = sock;
  process.env.KORA_AUTO_INGEST = '0';
  const handle = await createServer({ socketPath: sock, restore: false, sweep: false });
  try {
    assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  } finally {
    await handle.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); // the closing daemon may still flush a file
  }
});

test('privateDir creates 0700 but never chmods a shared parent it did not create', posixOnly, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-pd-'));
  try {
    const fresh = path.join(base, 'a', 'b');
    privateDir(fresh, false);
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);
    const shared = path.join(base, 'shared');
    fs.mkdirSync(shared, { mode: 0o755 }); fs.chmodSync(shared, 0o755);
    privateDir(shared, false);
    assert.equal(fs.statSync(shared).mode & 0o777, 0o755);
    privateDir(shared, true);
    assert.equal(fs.statSync(shared).mode & 0o777, 0o700);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
