// `kora hook opencode-event` (called by the OpenCode kora-state plugin) → pane.reportState + swarm.reportEvent, against
// a fake daemon on a throwaway unix socket.
import test from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { run } from './hook';
import { ipcAddress } from '../../util/ipc-path';

function io() { let out = ''; return { out: (s: string) => { out += s; }, err: (_s: string) => {}, get stdout() { return out; } }; }

async function fakeDaemon(): Promise<{ sock: string; calls: Array<{ method: string; params: any }>; close: () => Promise<void> }> {
  const base = process.env.KORA_TEST_BASE || fs.mkdtempSync(path.join((process.platform === 'win32' ? os.tmpdir() : '/tmp'), 'kh-'));
  const sock = path.join(base, `oc-${process.pid}.sock`);
  try { fs.unlinkSync(sock); } catch { /* none */ }
  const calls: Array<{ method: string; params: any }> = [];
  const server = net.createServer((c) => {
    let buf = '';
    c.setEncoding('utf8');
    c.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        calls.push({ method: msg.method, params: msg.params });
        c.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\n');
      }
    });
    c.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(ipcAddress(sock), r));
  return { sock, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function withPane<T>(sock: string, fn: () => Promise<T>): Promise<T> {
  const saved = { KORA_SOCKET_PATH: process.env.KORA_SOCKET_PATH, KORA_PANE_ID: process.env.KORA_PANE_ID };
  process.env.KORA_SOCKET_PATH = sock; process.env.KORA_PANE_ID = 'p7';
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const hook = (payload: unknown) => { const o = io(); return run(['opencode-event', '--stdin-json', JSON.stringify(payload)], o).then((code) => ({ code, out: o.stdout })); };

test('hook opencode-event: busy → reportState working + reportEvent; nothing on stdout; exit 0', async () => {
  const d = await fakeDaemon();
  try {
    const r = await withPane(d.sock, () => hook({ type: 'session.status', status: 'busy' }));
    assert.equal(r.code, 0); assert.equal(r.out, '');
    assert.deepEqual(d.calls.map((c) => c.method), ['pane.reportState', 'swarm.reportEvent']);
    assert.deepEqual(d.calls[0].params, { paneId: 'p7', state: 'working', source: 'opencode' });
    assert.deepEqual(d.calls[1].params, { paneId: 'p7', type: 'session.status', status: 'busy' });
  } finally { await d.close(); }
});

test('hook opencode-event: retry carries attempt/message/next and reads as working; idle → idle; error → event only', async () => {
  const d = await fakeDaemon();
  try {
    await withPane(d.sock, async () => {
      await hook({ type: 'session.status', status: 'retry', attempt: 2, message: 'Rate limit exceeded', next: 1790000000000 });
      await hook({ type: 'session.idle' });
      await hook({ type: 'session.error', message: 'Model not found: opencode/gone' });
    });
    assert.deepEqual(d.calls.map((c) => c.method), ['pane.reportState', 'swarm.reportEvent', 'pane.reportState', 'swarm.reportEvent', 'swarm.reportEvent']);
    assert.equal(d.calls[0].params.state, 'working');
    assert.deepEqual(d.calls[1].params, { paneId: 'p7', type: 'session.status', status: 'retry', attempt: 2, message: 'Rate limit exceeded', next: 1790000000000 });
    assert.equal(d.calls[2].params.state, 'idle');
    assert.deepEqual(d.calls[3].params, { paneId: 'p7', type: 'session.idle' });
    assert.deepEqual(d.calls[4].params, { paneId: 'p7', type: 'session.error', message: 'Model not found: opencode/gone' });
    for (const c of d.calls) assert.ok(!Object.values(c.params).includes(undefined), 'no undefined on the wire');
  } finally { await d.close(); }
});

test('hook opencode-event: outside a pane, an unknown type, or no daemon → silent exit 0', async () => {
  const d = await fakeDaemon();
  const savedSock = process.env.KORA_SOCKET_PATH;
  try {
    const saved = process.env.KORA_PANE_ID; delete process.env.KORA_PANE_ID;
    process.env.KORA_SOCKET_PATH = d.sock;
    assert.equal((await hook({ type: 'session.status', status: 'busy' })).code, 0);
    if (saved !== undefined) process.env.KORA_PANE_ID = saved;
    await withPane(d.sock, () => hook({ type: 'message.updated' }));
    assert.equal(d.calls.length, 0);
  } finally { await d.close(); if (savedSock === undefined) delete process.env.KORA_SOCKET_PATH; else process.env.KORA_SOCKET_PATH = savedSock; }
  const r = await withPane('/tmp/definitely-no-kora.sock', () => hook({ type: 'session.idle' }));
  assert.equal(r.code, 0);
});
