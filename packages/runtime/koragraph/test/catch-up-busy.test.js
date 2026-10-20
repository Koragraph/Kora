'use strict';

// Audit 2026-10-15 #5: the detached `koragraph catch-up` child ran with the pool's 2 s write timeout, so another repo's
// ingest holding the write lock longer failed it with "database is locked" (job FAILED). It must wait like `ingest`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-catchup-busy-'));
process.env.KORAGRAPH_HOME = path.join(TMP, 'home');
delete process.env.KORAGRAPH_DB;
delete process.env.KORAGRAPH_INGEST_BUSY_MS;
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

test('catch-up raises the store busy timeout to the ingest one before catching up, and reports a failure', async () => {
  const catchUp = require('../src/cli/catch-up');
  const lines = [];
  const code = await catchUp.run({ repo: path.join(TMP, 'not-a-repo'), changed: [], removed: [], signals: [], head: null }, { err: (s) => lines.push(s), out: () => {} });
  assert.equal(code, 0, 'no branch row is not a failure');
  assert.match(lines.join(''), /no branch row/);
  const pool = require('../src/db/pool');
  assert.equal(Number(pool.db.pragma('busy_timeout', { simple: true })), 120000);
  process.env.KORAGRAPH_INGEST_BUSY_MS = '4321';
  assert.equal(catchUp.ingestBusyMs(), 4321);
});
