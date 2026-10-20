import test from 'node:test';
import assert from 'node:assert/strict';
import { LineBuffer, parseMessage, resultResponse, errorResponse, encode, notification, ERR_PARSE, ERR_INVALID_REQUEST } from './rpc';

test('LineBuffer splits across chunks and skips blank lines', () => {
  const lb = new LineBuffer();
  assert.deepEqual(lb.push('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(lb.push(':2}\n\n\n'), ['{"b":2}']);
  assert.deepEqual(lb.push(Buffer.from('{"c":3}\n')), ['{"c":3}']);
  assert.deepEqual(lb.push(''), []);
});

test('parseMessage classifies requests, notifications and errors', () => {
  const r = parseMessage('{"jsonrpc":"2.0","id":7,"method":"server.ping","params":{}}');
  assert.equal(r.kind, 'request'); if (r.kind === 'request') { assert.equal(r.req.id, 7); assert.equal(r.req.method, 'server.ping'); }
  const n = parseMessage('{"jsonrpc":"2.0","method":"x"}');
  assert.equal(n.kind, 'notification');
  const e = parseMessage('not json');
  assert.equal(e.kind, 'error'); if (e.kind === 'error') assert.equal(e.resp.error!.code, ERR_PARSE);
  const bad = parseMessage('{"id":1}');
  assert.equal(bad.kind, 'error'); if (bad.kind === 'error') { assert.equal(bad.resp.error!.code, ERR_INVALID_REQUEST); assert.equal(bad.resp.id, 1); }
});

test('encode produces newline-terminated JSON-RPC 2.0 frames', () => {
  assert.equal(encode(resultResponse(1, { ok: true })), '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
  const err = JSON.parse(encode(errorResponse(2, -32601, 'nope')));
  assert.deepEqual(err, { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'nope' } });
  const note = JSON.parse(notification('pane.output', { paneId: 'p1', base64: 'aGk=' }));
  assert.equal(note.id, undefined); assert.equal(note.method, 'pane.output');
});

test('2026-10-15 #7: a line over the cap is refused, scanning stays linear, and the next line still parses', () => {
  const lb = new LineBuffer(1000);
  assert.throws(() => lb.push('x'.repeat(1001)), (e: any) => e.code === ERR_INVALID_REQUEST);
  assert.deepEqual(lb.push('{"ok":1}\n'), ['{"ok":1}'], 'the buffer was dropped with the long line');
  assert.throws(() => { lb.push('y'.repeat(600)); lb.push('y'.repeat(600) + '\n'); }, (e: any) => e.code === ERR_INVALID_REQUEST, 'a long line across chunks');
  // 1 MB in 1-byte chunks: the old splitter re-scanned the whole buffer per chunk (quadratic); this one is linear.
  const big = new LineBuffer(); const t0 = Date.now();
  for (let i = 0; i < 200_000; i++) big.push('a');
  assert.deepEqual(big.push('\n'), ['a'.repeat(200_000)]);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test('2026-10-15 #2: the envelope keeps a well-formed callerKey next to caller', () => {
  const r = parseMessage('{"jsonrpc":"2.0","id":1,"method":"pane.list","caller":"p1","callerKey":"abc"}');
  assert.ok(r.kind === 'request' && r.req.caller === 'p1' && r.req.callerKey === 'abc');
  const long = parseMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'pane.list', caller: 'p1', callerKey: 'k'.repeat(200) }));
  assert.ok(long.kind === 'request' && long.req.callerKey === undefined);
});
