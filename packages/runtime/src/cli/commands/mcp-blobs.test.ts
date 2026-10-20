// `kora mcp --blobs` against a fake daemon socket backed by the real BlobToolHub: chief vs member tool lists.
import { test } from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { ENGINE, fakeBridge, resetHome, tempHome } from '../../blobs/testkit-team';
tempHome('mcp-blobs-');

import { BlobStore } from '../../blobs/store';
import { CHIEF_SOUL } from '../../blobs/chief';
import { BlobToolHub, TeamService, allBlobToolSpecs } from '../../blobs/tools-team';
import { hireTemplate } from '../../blobs/templates';
import { blobBridgeOptions, createBlobsMcp, socketCaller } from './mcp-blobs';
import { ipcAddress } from '../../util/ipc-path';

const BRIEF = 'Goal: research neighbourhoods in Lisbon for a family of four. Inputs: mid budget, May. Done: a one-page brief in outputs/lisbon.md with sources.';

async function fixture() {
  resetHome();
  const store = new BlobStore();
  const kora = store.ensureKora(ENGINE, CHIEF_SOUL);
  const popo = (hireTemplate(store, 'popo', { defaultEngine: ENGINE }) as any).profile;
  const fb = fakeBridge();
  const svc = new TeamService({ store, memoryOnly: true });
  svc.attachEngine(fb.bridge);
  const hub = new BlobToolHub({
    getBlob: (id) => store.get(id),
    specsFor: (ctx) => allBlobToolSpecs([{ name: 'recall', description: 'search memory', params: { query: { type: 'string' } }, handler: async (a) => ({ text: `recalled ${String(a.query)}` }) }], svc, ctx),
  });
  const kTok = hub.issue({ blobId: kora.id, threadId: 'kt', agent: 'codex', cwd: '/x' });
  const pTok = hub.issue({ blobId: popo.id, threadId: 'pt', agent: 'codex', cwd: '/x' });
  // fake daemon: newline JSON-RPC over a unix socket, routing the two blobs.mcp.* methods to the hub
  const dir = fs.mkdtempSync(path.join((process.platform === 'win32' ? os.tmpdir() : '/tmp'), 'kb-')); const sockPath = path.join(dir, 's.sock');
  const server = net.createServer((c) => {
    c.setEncoding('utf8'); let buf = '';
    c.on('data', (d: string) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = JSON.parse(line);
        const reply = (result: unknown) => c.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
        if (m.method === 'blobs.mcp.hello') reply(hub.hello(m.params));
        else if (m.method === 'blobs.mcp.call') void hub.call(m.params).then(reply);
        else c.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } }) + '\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(ipcAddress(sockPath), r));
  return { store, kora, popo, fb, kTok, pTok, sockPath, close: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}

function client(f: Awaited<ReturnType<typeof fixture>>, blobId: string, token: string) {
  const input = new PassThrough(); const output = new PassThrough();
  const sock = socketCaller(f.sockPath);
  const server = createBlobsMcp({ call: sock.call, blobId, token, input, output });
  server.start();
  const lines: any[] = []; let buf = '';
  const waiters: Array<(m: any) => void> = [];
  output.setEncoding('utf8');
  output.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiters.shift(); if (w) w(m); else lines.push(m); } });
  let id = 0;
  const rpc = (method: string, params?: unknown) => new Promise<any>((resolve) => { waiters.push(resolve); input.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n'); });
  return { rpc, notify: (method: string) => input.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'), close: () => { sock.close(); input.end(); } };
}

test('argv identity wins over a scrubbed environment', () => {
  assert.deepEqual(blobBridgeOptions(['--blobs', '--blob', 'blob_kora', '--token', 't0k', '--socket', '/s.sock', '--thread', 'th1'], {}), { blobId: 'blob_kora', token: 't0k', socketPath: '/s.sock', threadId: 'th1' });
  assert.deepEqual(blobBridgeOptions(['--blobs'], { KORA_BLOB_ID: 'b', KORA_BLOB_TOKEN: 't' }), { blobId: 'b', token: 't' });
  assert.deepEqual(blobBridgeOptions(['--blobs', '--blob', '--token', 'x'], {}), { token: 'x' });
});

test('MCP: handshake, then the Chief lists self + team tools and a member lists only its own', async () => {
  const f = await fixture();
  try {
    const k = client(f, f.kora.id, f.kTok);
    const init = await k.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'codex' } });
    assert.equal(init.result.serverInfo.name, 'kora-blobs'); assert.equal(init.result.protocolVersion, '2025-03-26');
    k.notify('notifications/initialized');
    const kl = await k.rpc('tools/list');
    const names = kl.result.tools.map((t: any) => t.name);
    assert.deepEqual(names, ['recall', 'list_team', 'blob_status', 'plan_job', 'delegate_to', 'follow_up', 'accept_step', 'wait_for', 'cancel_job', 'propose_blob', 'edit_blob', 'retire_blob', 'list_templates', 'hire_template']);
    const plan = kl.result.tools.find((t: any) => t.name === 'plan_job');
    assert.equal(plan.inputSchema.type, 'object'); assert.deepEqual(plan.inputSchema.required.sort(), ['steps', 'title']); assert.equal(plan.inputSchema.properties.steps.type, 'array');
    k.close();

    const p = client(f, f.popo.id, f.pTok);
    const pl = await p.rpc('tools/list');
    assert.deepEqual(pl.result.tools.map((t: any) => t.name), ['recall']);
    const own = await p.rpc('tools/call', { name: 'recall', arguments: { query: 'Dallas' } });
    assert.deepEqual(own.result, { content: [{ type: 'text', text: 'recalled Dallas' }] });
    const denied = await p.rpc('tools/call', { name: 'delegate_to', arguments: { blob: 'Junip', task: 'x', brief: BRIEF } });
    assert.equal(denied.result.isError, true); assert.match(denied.result.content[0].text, /no tool "delegate_to"|team tools belong to Kora/i);
    assert.equal(f.fb.threads.length, 0);
    assert.equal((await p.rpc('ping')).result && true, true);
    assert.equal((await p.rpc('resources/list')).result.resources.length, 0);
    assert.equal((await p.rpc('nope/method')).error.code, -32601);
    p.close();
  } finally { f.close(); }
});

test('MCP: the Chief delegates through the socket; a wrong token gets no tools; a dead socket is a clear tool error', async () => {
  const f = await fixture();
  try {
    const k = client(f, f.kora.id, f.kTok);
    const r = await k.rpc('tools/call', { name: 'delegate_to', arguments: { blob: 'Popo', task: 'Lisbon neighbourhoods', brief: BRIEF, kind: 'travel' } });
    assert.notEqual(r.result.isError, true, r.result.content[0].text);
    assert.match(r.result.content[0].text, /Popo has it/);
    assert.equal(f.fb.threads.length, 1); assert.equal(f.fb.threads[0].origin.kind, 'kora');
    k.close();

    const bad = client(f, f.kora.id, 'wrong-token');
    assert.deepEqual((await bad.rpc('tools/list')).result.tools, []);
    const call = await bad.rpc('tools/call', { name: 'list_team', arguments: {} });
    assert.equal(call.result.isError, true); assert.match(call.result.content[0].text, /invalid or expired/);
    bad.close();

    const dead = createBlobsMcp({ call: socketCaller(path.join(path.dirname(f.sockPath), 'gone.sock')).call, blobId: f.kora.id, token: f.kTok, input: new PassThrough(), output: new PassThrough() });
    const out: any[] = []; const o = new PassThrough(); o.on('data', (d) => out.push(JSON.parse(String(d))));
    const dead2 = createBlobsMcp({ call: socketCaller(path.join(path.dirname(f.sockPath), 'gone.sock')).call, blobId: f.kora.id, token: f.kTok, input: new PassThrough(), output: o });
    await dead2.dispatch(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_team', arguments: {} } }));
    assert.equal(out[0].result.isError, true); assert.match(out[0].result.content[0].text, /daemon is not reachable/);
    assert.ok(dead);
  } finally { f.close(); }
});
