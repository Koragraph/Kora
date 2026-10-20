import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TokenStore } from './tokens';
import { AuditLog } from './audit';
import { LIMITS, compactRows, decodeCursor, encodeCursor } from './tools';
import { fixture } from './testkit';
import type { OutsideRow } from './types';

const j = (r: { text: string }) => JSON.parse(r.text);
const PUBLIC = ['ask_kora', 'get_blob', 'interrupt', 'list_blobs', 'list_outputs', 'list_threads', 'read_thread', 'search', 'send_message', 'set_model', 'wait_for'];

test('tokens: plaintext once, only a hash on disk, revoke is immediate, names unique', () => {
  const f = fixture();
  try {
    const disk = fs.readFileSync(path.join(f.dir, 'tokens.json'), 'utf8');
    assert.ok(!disk.includes(f.token), 'plaintext token must not be stored');
    assert.match(disk, /"hash"/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.dir, 'tokens.json')).mode & 0o077, 0, 'file is 0600');
    assert.ok(!('hash' in f.tokens.list()[0]!));
    assert.equal(f.tokens.list()[0]!.suffix, f.token.slice(-4));
    assert.equal(f.tokens.create('claude desktop').ok, false);
    assert.equal(f.tokens.create('  ').ok, false);
    assert.equal(f.tokens.verify(f.token).ok, true);
    assert.equal(f.tokens.verify('kbo_nope').ok, false);
    // a second store instance (another process) sees a revoke at once
    const other = new TokenStore(f.dir);
    assert.equal(other.verify(f.token).ok, true);
    assert.equal(f.tokens.revoke(f.tokenId), true);
    const v = other.verify(f.token);
    assert.equal(v.ok, false); assert.equal((v as any).reason, 'revoked');
    assert.equal(f.tokens.revoke(f.tokenId), false);
  } finally { f.cleanup(); }
});

test('tool list is exactly the bounded set; groups tools appear only when groups exist', () => {
  const a = fixture();
  const b = fixture({ groups: true });
  try {
    const names = (a.svc.hello({ token: a.token }).tools ?? []).map((t) => t.name).sort();
    assert.deepEqual(names, PUBLIC);
    const withGroups = (b.svc.hello({ token: b.token }).tools ?? []).map((t) => t.name).sort();
    assert.deepEqual(withGroups, [...PUBLIC, 'list_groups', 'send_to_group'].sort());
    for (const bad of ['approve', 'answer_approval', 'delete_blob', 'delete_thread', 'set_setting', 'get_secret', 'edit_memory', 'forget', 'grant_app', 'start_browser', 'create_webhook', 'edit_soul']) assert.ok(!names.includes(bad), bad);
  } finally { a.cleanup(); b.cleanup(); }
});

test('forbidden / unknown tool names are refused and audited', async () => {
  const f = fixture();
  try {
    for (const t of ['answer_approval', 'delete_blob', 'get_secret']) {
      const r = await f.svc.call({ token: f.token, tool: t, args: {} });
      assert.equal(r.isError, true); assert.match(r.text, /No tool/);
    }
    const rows = f.audit.list().rows;
    assert.equal(rows.length, 3); assert.ok(rows.every((x) => !x.ok && x.note === 'unknown tool'));
  } finally { f.cleanup(); }
});

test('happy paths: every tool', async () => {
  const f = fixture();
  const call = async (tool: string, args: any = {}) => f.svc.call({ token: f.token, tool, args });
  try {
    const lb = j(await call('list_blobs'));
    assert.deepEqual(lb.blobs.map((b: any) => b.name), ['Kora', 'Popo']);
    assert.equal(lb.blobs[1].model, 'claude-haiku-5');
    const gb = j(await call('get_blob', { blob: 'popo' }));
    assert.equal(gb.id, 'blob_popo'); assert.equal(gb.card, 'blob_popo card'); assert.deepEqual(gb.skills, ['research', 'docx']);
    assert.equal((await call('get_blob', { blob: 'nobody' })).isError, true);

    const sm = j(await call('send_message', { blob: 'Popo', text: 'Find three Lisbon neighbourhoods' }));
    assert.equal(sm.started, true); assert.equal(sm.status, 'running');
    assert.deepEqual(f.h.sent[0]!.via, { client: 'Claude Desktop', tokenId: f.tokenId });
    const th = sm.thread;
    assert.equal(j(await call('list_threads', { blob: 'blob_popo' })).threads[0].id, th);
    const rt = j(await call('read_thread', { thread: th }));
    assert.equal(rt.messages[0].via, 'Claude Desktop'); assert.equal(rt.status, 'running');
    assert.equal(j(await call('search', { query: 'lisbon' })).hits[0].id, th);

    const cont = j(await call('send_message', { thread: th, text: 'and costs' }));
    assert.equal(cont.started, false); assert.equal(cont.thread, th);
    const ask = j(await call('ask_kora', { text: 'plan my week' }));
    assert.equal(f.h.sent.at(-1)!.blobId, 'blob_kora');
    assert.equal(j(await call('ask_kora', { text: 'more', thread: ask.thread })).thread, ask.thread);
    assert.equal((await call('ask_kora', { text: 'x', thread: th })).isError, true, 'th is Popo, not Kora');

    // wait_for: settles after the host flips it
    f.h.rows.get(th)!.push({ role: 'tool', text: '', at: 2, tool: { name: 'Read', summary: 'Read notes.md' } }, { role: 'assistant', text: 'Alfama, Estrela, Campo de Ourique.', at: 3, outputs: [{ path: 'outputs/lisbon.md', name: 'lisbon.md', bytes: 10, at: 3, threadId: th }] });
    f.clock.onSleep = () => { f.h.threads.get(th)!.status = 'settled'; };
    const w = j(await call('wait_for', { thread: th, timeout_s: 30 }));
    assert.equal(w.status, 'settled'); assert.equal(w.timedOut, false); assert.match(w.reply, /Alfama/); assert.equal(w.outputs[0].name, 'lisbon.md');

    assert.equal(j(await call('interrupt', { thread: th })).interrupted, false, 'settled thread: nothing to interrupt');
    f.h.threads.get(th)!.status = 'running';
    assert.equal(j(await call('interrupt', { thread: th })).interrupted, true);
    assert.deepEqual(f.h.interrupted, [th]);

    assert.equal(j(await call('list_outputs', { blob: 'Popo' })).outputs[0].name, 'lisbon.md');
    const sy = j(await call('set_model', { blob: 'Popo', model: 'Sonnet 5.5' }));
    assert.equal(sy.model, 'claude-sonnet-5-5'); assert.equal(f.h.blobs[1]!.engine.model, 'claude-sonnet-5-5');
    const bad = await call('set_model', { blob: 'Popo', model: 'gpt-9-ultra' });
    assert.equal(bad.isError, true); assert.match(bad.text, /Allowed: claude-haiku-5/);
  } finally { f.cleanup(); }
});

test('groups tools work when present', async () => {
  const f = fixture({ groups: true });
  try {
    assert.equal(j(await f.svc.call({ token: f.token, tool: 'list_groups' })).groups[0].name, 'Launch');
    assert.equal(j(await f.svc.call({ token: f.token, tool: 'send_to_group', args: { group: 'launch', text: 'hi team' } })).sent, true);
    assert.deepEqual(f.h.groupSent, ['hi team']);
    assert.equal((await f.svc.call({ token: f.token, tool: 'send_to_group', args: { group: 'nope', text: 'x' } })).isError, true);
  } finally { f.cleanup(); }
});

test('send validation and refusals', async () => {
  const f = fixture();
  const call = (args: any) => f.svc.call({ token: f.token, tool: 'send_message', args });
  try {
    assert.match((await call({ text: 'x' })).text, /exactly one/);
    assert.match((await call({ blob: 'Popo', thread: 'th1', text: 'x' })).text, /exactly one/);
    assert.match((await call({ blob: 'Popo' })).text, /text is required/);
    assert.match((await call({ blob: 'Popo', text: 'a'.repeat(LIMITS.textMax + 5) })).text, /too long/);
    f.h.refuseNext('busy');
    assert.match((await call({ blob: 'Popo', text: 'hi' })).text, /maximum number of threads/);
    assert.equal(f.h.sent.length, 0);
  } finally { f.cleanup(); }
});

test('needs-you is reported, never answered', async () => {
  const f = fixture();
  try {
    f.h.addThread('t9', 'blob_popo', 'needs-you', [{ role: 'user', text: 'send the email', at: 1 }, { role: 'assistant', text: 'Ready to send.', at: 2, needsYou: 'Send email to Ana?' }]);
    const r = j(await f.svc.call({ token: f.token, tool: 'wait_for', args: { thread: 't9', timeout_s: 5 } }));
    assert.equal(r.status, 'needs-you'); assert.match(r.attention, /Needs you in Kora: Send email to Ana\?/);
    assert.equal(j(await f.svc.call({ token: f.token, tool: 'read_thread', args: { thread: 't9' } })).attention.startsWith('Needs you in Kora'), true);
    f.h.addThread('t8', 'blob_popo', 'error', [{ role: 'user', text: 'x', at: 1 }]);
    assert.equal(j(await f.svc.call({ token: f.token, tool: 'wait_for', args: { thread: 't8' } })).status, 'error');
  } finally { f.cleanup(); }
});

test('wait_for timeout: returns running + timedOut after the deadline, never hangs, clamps timeout_s', async () => {
  const f = fixture();
  try {
    f.h.addThread('slow', 'blob_popo', 'running', [{ role: 'user', text: 'long job', at: 1 }]);
    const t0 = f.clock.now();
    const r = j(await f.svc.call({ token: f.token, tool: 'wait_for', args: { thread: 'slow', timeout_s: 20 } }));
    assert.equal(r.status, 'running'); assert.equal(r.timedOut, true);
    assert.ok(f.clock.now() - t0 >= 20_000 && f.clock.now() - t0 < 21_000);
    const t1 = f.clock.now();
    await f.svc.call({ token: f.token, tool: 'wait_for', args: { thread: 'slow', timeout_s: 99999 } });
    assert.ok(f.clock.now() - t1 <= (LIMITS.waitMax + 1) * 1000, 'timeout clamped to the max');
    const t2 = f.clock.now();
    await f.svc.call({ token: f.token, tool: 'wait_for', args: { thread: 'slow' } });
    assert.ok(f.clock.now() - t2 >= LIMITS.waitDefault * 1000 && f.clock.now() - t2 < (LIMITS.waitDefault + 1) * 1000, 'default timeout');
  } finally { f.cleanup(); }
});

test('pagination: list_threads caps the page, cursors cover everything exactly once, bad cursor is an error', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 55; i++) f.h.addThread(`t${i}`, 'blob_popo', 'settled', [{ role: 'user', text: 'x', at: 1 }], i);
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r = j(await f.svc.call({ token: f.token, tool: 'list_threads', args: { blob: 'Popo', limit: 1000, ...(cursor ? { cursor } : {}) } }));
      assert.ok(r.threads.length <= LIMITS.threadsMax);
      seen.push(...r.threads.map((t: any) => t.id)); cursor = r.nextCursor ?? undefined; pages++;
    } while (cursor);
    assert.equal(pages, 2); assert.equal(new Set(seen).size, 55); assert.equal(seen[0], 't54');
    assert.equal(j(await f.svc.call({ token: f.token, tool: 'list_threads', args: { blob: 'Popo', limit: 5 } })).threads.length, 5);
    const bad = await f.svc.call({ token: f.token, tool: 'list_threads', args: { blob: 'Popo', cursor: 'garbage' } });
    assert.equal(bad.isError, true);
    assert.equal(decodeCursor(encodeCursor(7)), 7);
  } finally { f.cleanup(); }
});

test('read_thread pages by max_chars, truncates long rows, summarises tools, always makes progress', async () => {
  const f = fixture();
  try {
    const rows: OutsideRow[] = [];
    for (let i = 0; i < 40; i++) rows.push(i % 3 === 2 ? { role: 'tool', text: 'RAW OUTPUT '.repeat(500), at: i, tool: { name: 'Bash', summary: `ran step ${i}` } } : { role: i % 2 ? 'assistant' : 'user', text: `message ${i} ${'y'.repeat(200)}`, at: i });
    rows.push({ role: 'assistant', text: 'z'.repeat(50_000), at: 99 });
    f.h.addThread('big', 'blob_popo', 'settled', rows);
    const seen: number[] = []; let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const r = j(await f.svc.call({ token: f.token, tool: 'read_thread', args: { thread: 'big', max_chars: 500, ...(cursor ? { cursor } : {}) } }));
      assert.ok(r.messages.length >= 1);
      for (const m of r.messages) { seen.push(m.i); assert.ok(m.text.length <= LIMITS.rowCap + 40); if (m.role === 'tool') assert.ok(!m.text.includes('RAW OUTPUT')); }
      cursor = r.nextCursor ?? undefined;
      if (!cursor) break;
    }
    assert.deepEqual(seen, rows.map((_, i) => i));
    assert.ok(compactRows(rows, 0, 1).messages.length === 1, 'a tiny budget still returns one row');
    const wide = j(await f.svc.call({ token: f.token, tool: 'read_thread', args: { thread: 'big', max_chars: 10 ** 9 } }));
    assert.ok(JSON.stringify(wide.messages).length < LIMITS.readMax + LIMITS.rowCap + 1000, 'max_chars is clamped');
  } finally { f.cleanup(); }
});

test('audit: client, tool, target for allowed and refused calls; no message text; revoked token logged', async () => {
  const f = fixture();
  try {
    await f.svc.call({ token: f.token, tool: 'send_message', args: { blob: 'Popo', text: 'SECRET PLAN do not log' }, clientInfo: { name: 'claude-ai', version: '1' } });
    await f.svc.call({ token: f.token, tool: 'read_thread', args: { thread: 'th-missing' } });
    f.tokens.revoke(f.tokenId);
    const r = await f.svc.call({ token: f.token, tool: 'list_blobs' });
    assert.equal(r.isError, true); assert.match(r.text, /revoked/);
    const rows = f.audit.list().rows; // newest first
    assert.deepEqual(rows.map((x) => [x.client, x.tool, x.ok]), [['Claude Desktop', 'list_blobs', false], ['Claude Desktop', 'read_thread', false], ['Claude Desktop', 'send_message', true]]);
    assert.equal(rows[2]!.target, 'Popo'); assert.equal(rows[2]!.note, 'via claude-ai');
    assert.equal(rows[0]!.note, 'revoked token');
    assert.ok(!fs.readFileSync(path.join(f.dir, 'audit.jsonl'), 'utf8').includes('SECRET PLAN'));
    assert.equal(f.audit.list({ tokenId: 'other' }).rows.length, 0);
    assert.equal(f.audit.list({ limit: 1 }).next, rows[0]!.at);
    const unknown = await f.svc.call({ token: 'kbo_forged', tool: 'list_blobs' });
    assert.match(unknown.text, /not valid/);
    assert.equal(f.audit.list().rows[0]!.client, '(unknown token)');
  } finally { f.cleanup(); }
});

test('audit log trims itself', () => {
  const f = fixture();
  try {
    const a = new AuditLog(f.dir);
    for (let i = 0; i < 2600; i++) a.append({ tokenId: 't', client: 'c', tool: 'x', ok: true });
    const lines = fs.readFileSync(path.join(f.dir, 'audit.jsonl'), 'utf8').trim().split('\n').length;
    assert.ok(lines <= 2500 && lines >= 100, `lines=${lines}`);
  } finally { f.cleanup(); }
});

test('rate limit: per token, tighter for sends, recovers after the window', async () => {
  const f = fixture({ limits: { calls: 5, sends: 2, windowMs: 60_000 } });
  const other = f.tokens.create('Cursor'); assert.ok(other.ok);
  try {
    for (let i = 0; i < 2; i++) assert.equal((await f.svc.call({ token: f.token, tool: 'send_message', args: { blob: 'Popo', text: `m${i}` } })).isError, undefined);
    const third = await f.svc.call({ token: f.token, tool: 'send_message', args: { blob: 'Popo', text: 'm3' } });
    assert.equal(third.isError, true); assert.match(third.text, /Rate limit.*\d+s/);
    assert.equal(f.h.sent.length, 2, 'a limited send never reaches the host');
    for (let i = 0; i < 3; i++) assert.equal((await f.svc.call({ token: f.token, tool: 'list_blobs' })).isError, undefined);
    assert.match((await f.svc.call({ token: f.token, tool: 'list_blobs' })).text, /Rate limit/);
    assert.equal((await f.svc.call({ token: (other as any).token, tool: 'list_blobs' })).isError, undefined, 'another token is unaffected');
    f.clock.advance(61_000);
    assert.equal((await f.svc.call({ token: f.token, tool: 'list_blobs' })).isError, undefined);
    assert.ok(f.audit.list().rows.some((r) => r.note === 'rate limited'));
  } finally { f.cleanup(); }
});

test('argument validation', async () => {
  const f = fixture();
  try {
    assert.match((await f.svc.call({ token: f.token, tool: 'read_thread', args: {} })).text, /thread is required/);
    assert.match((await f.svc.call({ token: f.token, tool: 'list_threads', args: { blob: 'Popo', limit: 'ten' } })).text, /limit must be a number/);
    assert.match((await f.svc.call({ token: f.token, tool: 'search', args: { query: 'a' } })).text, /at least 2/);
    assert.equal((await f.svc.call({ token: f.token, tool: 'list_blobs', args: 'junk' as any })).isError, undefined);
  } finally { f.cleanup(); }
});
