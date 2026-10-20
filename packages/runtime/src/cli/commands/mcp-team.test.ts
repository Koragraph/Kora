// `kora mcp --team` end to end over stdio against a fake daemon socket backed by the real OutsideService + a fake host:
// once with the official MCP TypeScript SDK client (found in the pnpm store - it is not a runtime dependency, so that
// test skips if absent) and once with a minimal JSON-RPC client that always runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fixture } from '../../blobs/outside/testkit';
import { createTeamMcp, teamBridgeOptions } from './mcp-team';
import { socketCaller } from './mcp-blobs';
import { ipcAddress } from '../../util/ipc-path';

type Fx = ReturnType<typeof fixture>;

async function daemon(f: Fx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-s-')); const sockPath = path.join(dir, 's.sock');
  const server = net.createServer((c) => {
    c.setEncoding('utf8'); let buf = '';
    c.on('data', (d: string) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        const reply = (result: unknown) => c.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
        if (m.method === 'blobs.outside.hello') reply(f.svc.hello(m.params));
        else if (m.method === 'blobs.outside.call') void f.svc.call(m.params).then(reply);
        else c.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } }) + '\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(ipcAddress(sockPath), r));
  return { sockPath, close: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}

function bridge(sockPath: string, token: string | undefined) {
  const input = new PassThrough(); const output = new PassThrough();
  const sock = socketCaller(sockPath);
  const server = createTeamMcp({ call: sock.call, ...(token ? { token } : {}), input, output });
  server.start();
  return { input, output, close: () => { sock.close(); input.end(); } };
}

/** Minimal JSON-RPC client over the bridge's streams. */
function rpc(b: ReturnType<typeof bridge>) {
  let id = 0; const waiting = new Map<number, (m: any) => void>(); let buf = '';
  b.output.setEncoding('utf8');
  b.output.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const request = (method: string, params?: unknown) => new Promise<any>((res) => { const n = ++id; waiting.set(n, res); b.input.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  return {
    request,
    init: () => request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-client', version: '0' } }),
    call: async (name: string, args: any = {}) => { const r = await request('tools/call', { name, arguments: args }); return { isError: r.result?.isError === true, text: r.result?.content?.[0]?.text as string, raw: r }; },
  };
}

test('options: argv beats env, env is the fallback', () => {
  assert.deepEqual(teamBridgeOptions(['--team', '--token', 'kbo_a', '--socket', '/x.sock'], { KORA_TEAM_TOKEN: 'kbo_b' }), { token: 'kbo_a', socketPath: '/x.sock' });
  assert.deepEqual(teamBridgeOptions(['--team'], { KORA_TEAM_TOKEN: 'kbo_b', KORA_SOCKET_PATH: '/y' }), { token: 'kbo_b', socketPath: '/y' });
  assert.deepEqual(teamBridgeOptions(['--team', '--token'], {}), {});
});

test('minimal client: initialize, tools list, calls, forbidden, revoke, no token', async () => {
  const f = fixture(); const d = await daemon(f); const b = bridge(d.sockPath, f.token); const c = rpc(b);
  try {
    const init = await c.init();
    assert.equal(init.result.serverInfo.name, 'kora-team');
    const list = await c.request('tools/list');
    const names = list.result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(names, ['ask_kora', 'get_blob', 'interrupt', 'list_blobs', 'list_outputs', 'list_threads', 'read_thread', 'search', 'send_message', 'set_model', 'wait_for']);
    const sm = list.result.tools.find((t: any) => t.name === 'send_message');
    assert.equal(sm.inputSchema.type, 'object'); assert.deepEqual(sm.inputSchema.required, ['text']);

    assert.equal(JSON.parse((await c.call('list_blobs')).text).blobs.length, 2);
    const sent = await c.call('send_message', { blob: 'Popo', text: 'hello' });
    const th = JSON.parse(sent.text).thread;
    f.h.threads.get(th)!.status = 'settled'; f.h.rows.get(th)!.push({ role: 'assistant', text: 'done', at: 5 });
    assert.equal(JSON.parse((await c.call('wait_for', { thread: th })).text).reply, 'done');
    const forbidden = await c.call('answer_approval', { id: 'x', allow: true });
    assert.equal(forbidden.isError, true);
    assert.equal((await c.call('delete_blob', { blob: 'Popo' })).isError, true);

    // revoke: the very next call fails, tools/list is an RPC error
    f.tokens.revoke(f.tokenId);
    const after = await c.call('list_blobs');
    assert.equal(after.isError, true); assert.match(after.text, /revoked/);
    const tl = await c.request('tools/list');
    assert.ok(tl.error); assert.match(tl.error.message, /revoked/);
    assert.ok(f.audit.list().rows.some((r) => r.note === 'revoked token'));
    assert.equal((await c.request('nope/nothing')).error.code, -32601);
  } finally { b.close(); d.close(); f.cleanup(); }
});

test('no token: every call explains how to get one; old daemon without outside access says so', async () => {
  const f = fixture(); const d = await daemon(f); const b = bridge(d.sockPath, undefined); const c = rpc(b);
  try {
    await c.init();
    assert.match((await c.request('tools/list')).error.message, /No token/);
    assert.match((await c.call('list_blobs')).text, /No token/);
  } finally { b.close(); d.close(); f.cleanup(); }
  // a daemon that does not know the method
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-o-')); const sp = path.join(dir, 's.sock');
  const old = net.createServer((cn) => { cn.setEncoding('utf8'); cn.on('data', (x: string) => { const m = JSON.parse(x.split('\n')[0]!); cn.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown method' } }) + '\n'); }); });
  await new Promise<void>((r) => old.listen(ipcAddress(sp), r));
  const b2 = bridge(sp, 'kbo_x'); const c2 = rpc(b2);
  try { await c2.init(); assert.match((await c2.call('list_blobs')).text, /does not have outside access/); } finally { b2.close(); old.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('daemon down: a clear tool error, not a crash', async () => {
  const b = bridge('/nonexistent/kora.sock', 'kbo_x'); const c = rpc(b);
  try { await c.init(); const r = await c.call('list_blobs'); assert.equal(r.isError, true); assert.match(r.text, /not reachable|did not answer/); } finally { b.close(); }
});

// ---- the official SDK client ----
function findSdk(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const pnpm = path.join(dir, 'node_modules', '.pnpm');
    if (fs.existsSync(pnpm)) {
      const e = fs.readdirSync(pnpm).find((n) => n.startsWith('@modelcontextprotocol+sdk@'));
      if (e) return path.join(pnpm, e, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs');
    }
    dir = path.dirname(dir);
  }
  return null;
}

test('official MCP SDK client: list, call every tool, forbidden, revoke, rate limit, wait_for timeout', { skip: findSdk() ? false : 'MCP SDK not in the pnpm store' }, async () => {
  const sdk = findSdk()!;
  const { Client } = require(path.join(sdk, 'client', 'index.js'));
  const f = fixture({ limits: { calls: 40, sends: 3, windowMs: 60_000 } }); const d = await daemon(f); const b = bridge(d.sockPath, f.token);
  b.output.setEncoding('utf8');
  const transport: any = {
    async start() { let buf = ''; b.output.on('data', (x: string) => { buf += x; let i; while ((i = buf.indexOf('\n')) !== -1) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); transport.onmessage?.(m); } }); },
    async send(m: unknown) { b.input.write(JSON.stringify(m) + '\n'); },
    async close() { transport.onclose?.(); },
  };
  const client = new Client({ name: 'sdk-conformance', version: '1.0.0' });
  const text = (r: any) => r.content[0].text as string;
  const j = (r: any) => JSON.parse(text(r));
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'kora-team');
    assert.match(client.getInstructions(), /needs you in Kora/);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 11);
    for (const t of tools) { assert.equal(t.inputSchema.type, 'object'); assert.ok(t.description.length > 10); }
    assert.ok(!tools.some((t: any) => /approv|delete|secret|setting|memory|grant|browser|webhook/i.test(t.name)));

    assert.equal(j(await client.callTool({ name: 'list_blobs', arguments: {} })).blobs[0].name, 'Kora');
    assert.equal(j(await client.callTool({ name: 'get_blob', arguments: { blob: 'blob_popo' } })).title, 'Researcher');
    const sent = j(await client.callTool({ name: 'send_message', arguments: { blob: 'Popo', text: 'research Lisbon' } }));
    f.h.rows.get(sent.thread)!.push({ role: 'assistant', text: 'Alfama.', at: 9 });
    f.clock.onSleep = () => { f.h.threads.get(sent.thread)!.status = 'settled'; };
    const waited = j(await client.callTool({ name: 'wait_for', arguments: { thread: sent.thread, timeout_s: 30 } }));
    assert.equal(waited.status, 'settled'); assert.equal(waited.reply, 'Alfama.');
    assert.equal(j(await client.callTool({ name: 'read_thread', arguments: { thread: sent.thread } })).messages[0].via, 'Claude Desktop');
    assert.equal(j(await client.callTool({ name: 'list_threads', arguments: { blob: 'Popo' } })).total, 1);
    assert.equal(j(await client.callTool({ name: 'search', arguments: { query: 'research' } })).hits.length, 1);
    assert.equal(j(await client.callTool({ name: 'list_outputs', arguments: { blob: 'Popo' } })).outputs.length, 1);
    assert.equal(j(await client.callTool({ name: 'set_model', arguments: { blob: 'Popo', model: 'claude-haiku-5' } })).model, 'claude-haiku-5');
    assert.equal((await client.callTool({ name: 'set_model', arguments: { blob: 'Popo', model: 'bogus' } })).isError, true);
    assert.equal(j(await client.callTool({ name: 'ask_kora', arguments: { text: 'status?' } })).blob, 'blob_kora');
    f.h.threads.get(sent.thread)!.status = 'running';
    assert.equal(j(await client.callTool({ name: 'interrupt', arguments: { thread: sent.thread } })).interrupted, true);

    // forbidden operation: not in the registry
    const bad = await client.callTool({ name: 'answer_approval', arguments: { allow: true } });
    assert.equal(bad.isError, true);

    // wait_for timeout: a running thread comes back timedOut
    f.h.addThread('stuck', 'blob_popo', 'running', [{ role: 'user', text: 'x', at: 1 }]);
    const to = j(await client.callTool({ name: 'wait_for', arguments: { thread: 'stuck', timeout_s: 5 } }));
    assert.equal(to.timedOut, true); assert.equal(to.status, 'running');

    // rate limit: the 4th send inside the window is refused (2 sends above + 1 more allowed)
    assert.equal((await client.callTool({ name: 'send_message', arguments: { blob: 'Popo', text: 'again' } })).isError, undefined);
    const limited = await client.callTool({ name: 'send_message', arguments: { blob: 'Popo', text: 'too many' } });
    assert.equal(limited.isError, true); assert.match(text(limited), /Rate limit/);

    // audit saw the SDK client's own name
    assert.ok(f.audit.list({ limit: 200 }).rows.some((r) => r.note === 'via sdk-conformance'));

    // revoke -> immediate
    f.tokens.revoke(f.tokenId);
    const dead = await client.callTool({ name: 'list_blobs', arguments: {} });
    assert.equal(dead.isError, true); assert.match(text(dead), /revoked/);
    await assert.rejects(client.listTools(), /revoked/);
  } finally { await client.close().catch(() => {}); b.close(); d.close(); f.cleanup(); }
});
