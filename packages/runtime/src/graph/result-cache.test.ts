import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-rcache-'));
process.env.KORA_HOME = HOME;
import { normalizeArgs, cacheKey, lookup, remember, pointerText, cachePath, currentSession, CACHE_TTL_MS } from './result-cache';

test('normalizeArgs: key order, whitespace and null/undefined do not change the key', () => {
  assert.equal(normalizeArgs({ query: '  repo  Identity ', project_id: undefined, x: null }), normalizeArgs({ x: null, query: 'repo Identity' }));
  assert.notEqual(cacheKey('explore', { query: 'a' }, '/r', 's'), cacheKey('search_code', { query: 'a' }, '/r', 's'));
  assert.notEqual(cacheKey('explore', { query: 'a' }, '/r', 's1'), cacheKey('explore', { query: 'a' }, '/r', 's2'), 'per session');
  assert.notEqual(cacheKey('explore', { query: 'a' }, '/r1', 's'), cacheKey('explore', { query: 'a' }, '/r2', 's'), 'per repo');
});

test('lookup/remember: hit within the same generation, miss after a re-index, expiry on write, head3 pointer', () => {
  const q = { repoRoot: '/repo/x', generation: 'g1', tool: 'explore', args: { query: 'foo' }, session: 'sess' };
  assert.equal(lookup(q), null);
  const text = 'line one\n\nline two\nline three\nline four';
  const e = remember({ ...q, text, turn: 4 });
  assert.deepEqual(e.head3, ['line one', 'line two', 'line three']);
  assert.ok(fs.existsSync(cachePath('/repo/x')));
  const hit = lookup({ ...q, args: { query: ' foo ' } })!;
  assert.ok(hit, 'normalised args hit');
  assert.equal(hit.calls, 2);
  assert.equal(pointerText(hit), '(same as an earlier call this session — result unchanged; see turn 4)\nline one\nline two\nline three');
  assert.equal(lookup({ ...q, generation: 'g2' }), null, 'a re-index is a new generation');
  assert.equal(lookup({ ...q, session: 'other' }), null, 'another session has not seen the result');
  assert.equal(lookup({ ...q, now: Date.now() + CACHE_TTL_MS + 1 }), null, 'expired');
  // A write in the new generation drops the old entries.
  remember({ ...q, generation: 'g2', text: 'fresh' });
  const file = JSON.parse(fs.readFileSync(cachePath('/repo/x'), 'utf8'));
  assert.equal(file.entries.length, 1); assert.equal(file.entries[0].generation, 'g2');
  assert.match(pointerText({ ...e, turn: null }), /see the earlier result above/);
});

test('currentSession: KORA_SESSION_ID, else KORA_PANE_ID, else null (cache bypassed outside a session)', () => {
  assert.equal(currentSession({}), null);
  assert.equal(currentSession({ KORA_PANE_ID: 'p1' }), 'p1');
  assert.equal(currentSession({ KORA_PANE_ID: 'p1', KORA_SESSION_ID: 's1' }), 's1');
});

test.after(() => { fs.rmSync(HOME, { recursive: true, force: true }); });
