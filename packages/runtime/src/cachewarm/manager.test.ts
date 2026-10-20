import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CacheWarmManager } from './manager';
import { ownGatewayReason, settingsGatewayReason, warmProxyArgs, withWarmProxy } from './gateway';
import { makeDistLoader } from './dist-file';
import { DEFAULT_RETURN_DIST } from './policy';
import { cacheWarmMode } from '../util/savings-settings';
import { buildSessionOptions } from '../session/drivers/claude-driver';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kora-cw-'));

test('cacheWarmMode: default off (the relay carries login headers), settings file, env override', () => {
  // readSettings caches per home for 2 s, so each case gets its own home
  const withFile = (content?: unknown) => { const h = tmp(); if (content !== undefined) fs.writeFileSync(path.join(h, 'settings.json'), JSON.stringify(content)); return h; };
  assert.equal(cacheWarmMode(withFile(), {}), 'off');
  assert.equal(cacheWarmMode(withFile({ cacheWarm: 'on' }), {}), 'on', 'the user may turn it on');
  assert.equal(cacheWarmMode(withFile({ cacheWarm: 'shadow' }), {}), 'shadow');
  assert.equal(cacheWarmMode(withFile({ cacheWarm: 'shadow' }), { KORA_CACHE_WARM: 'on' }), 'on');
  assert.equal(cacheWarmMode(withFile({ cacheWarm: 'on' }), { KORA_CACHE_WARM: '0' }), 'off');
  assert.equal(cacheWarmMode(withFile({ cacheWarm: 'bogus' }), {}), 'off');
  assert.equal(cacheWarmMode(withFile({ cacheWarm: 'off' }), {}), 'off');
});

test('gateway: the user\'s own base URL, cloud provider or HTTP proxy keeps the session off our proxy', () => {
  assert.equal(ownGatewayReason({}), null);
  assert.equal(ownGatewayReason({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }), null, 'the official endpoint is the default, not a gateway');
  assert.equal(ownGatewayReason({ ANTHROPIC_BASE_URL: 'https://gw.example' }), 'ANTHROPIC_BASE_URL');
  assert.equal(ownGatewayReason({ CLAUDE_CODE_USE_BEDROCK: '1' }), 'CLAUDE_CODE_USE_BEDROCK');
  assert.equal(ownGatewayReason({ CLAUDE_CODE_USE_BEDROCK: '0' }), null);
  assert.equal(ownGatewayReason({ HTTPS_PROXY: 'http://corp:3128' }), 'HTTPS_PROXY');
  assert.equal(withWarmProxy({ A: '1' }, 'http://127.0.0.1:9/s/t').ANTHROPIC_BASE_URL, 'http://127.0.0.1:9/s/t');
  assert.equal(withWarmProxy({ ANTHROPIC_BASE_URL: 'https://gw' }, 'http://127.0.0.1:9/s/t').ANTHROPIC_BASE_URL, 'https://gw');
  assert.equal(withWarmProxy({ A: '1' }, null).ANTHROPIC_BASE_URL, undefined);
  // a custom base URL turns Claude Code's tool search off; routed through our proxy it must stay on
  assert.equal(withWarmProxy({ A: '1' }, 'http://127.0.0.1:9/s/t').ENABLE_TOOL_SEARCH, 'true');
  assert.equal(withWarmProxy({ ENABLE_TOOL_SEARCH: 'false' }, 'http://127.0.0.1:9/s/t').ENABLE_TOOL_SEARCH, 'false', "the user's own choice wins");
  assert.equal(withWarmProxy({ ANTHROPIC_BASE_URL: 'https://gw' }, 'http://127.0.0.1:9/s/t').ENABLE_TOOL_SEARCH, undefined, 'their gateway: untouched');
  assert.equal(withWarmProxy({ A: '1' }, null).ENABLE_TOOL_SEARCH, undefined);

  const cfg = tmp(); const cwd = tmp();
  assert.equal(settingsGatewayReason(cwd, cfg), null);
  fs.mkdirSync(path.join(cwd, '.claude'));
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gw' } }));
  assert.match(settingsGatewayReason(cwd, cfg)!, /ANTHROPIC_BASE_URL/);
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), '{ not json');
  assert.equal(settingsGatewayReason(cwd, cfg), null, 'unreadable settings are ignored, not fatal');
});

test('buildSessionOptions: the base URL lands in the session env only when one is given', () => {
  const input: any = { threadId: 't', cwd: '/x', model: { model: 'claude-haiku-4-5' } };
  const extra: any = { mcpServers: {}, canUseTool: () => {} };
  const withUrl = buildSessionOptions(input, null, undefined, {}, { ...extra, warmBaseUrl: 'http://127.0.0.1:1/s/t' }) as any;
  const without = buildSessionOptions(input, null, undefined, {}, extra) as any;
  assert.equal(withUrl.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1/s/t');
  assert.equal(without.env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_BASE_URL, 'untouched when no proxy URL is given');
  // behind a custom base URL Claude Code asks for full thinking text; the flag keeps it "omitted", as a direct session does
  if (!process.env.ANTHROPIC_BASE_URL) assert.deepEqual(withUrl.extraArgs, { 'thinking-display': 'omitted' });
  assert.equal(without.extraArgs, undefined);
});

test('warmProxyArgs: only for a session our proxy actually carries, and only on the bundled CLI', () => {
  const url = 'http://127.0.0.1:9/s/t';
  assert.deepEqual(warmProxyArgs(withWarmProxy({}, url), url, false), { 'thinking-display': 'omitted' });
  assert.deepEqual(warmProxyArgs(withWarmProxy({}, url), url, true), {}, 'a user-chosen claude binary may not know the flag');
  assert.deepEqual(warmProxyArgs(withWarmProxy({ ANTHROPIC_BASE_URL: 'https://gw' }, url), url, false), {}, 'their gateway: untouched');
  assert.deepEqual(warmProxyArgs(withWarmProxy({}, null), null, false), {});
});

test('dist loader: default when absent or damaged, file when valid, cached for a minute', () => {
  const dir = tmp(); const f = path.join(dir, 'cache-warm.json'); let now = 0;
  const load = makeDistLoader(f, () => now);
  assert.equal(load(), DEFAULT_RETURN_DIST);
  fs.writeFileSync(f, JSON.stringify({ bins: [{ fromMin: 0, toMin: 10, p: 0.5 }], horizonMin: 90 }));
  assert.equal(load(), DEFAULT_RETURN_DIST, 'cached');
  now = 61_000; assert.equal(load().horizonMin, 90);
  fs.writeFileSync(f, 'garbage'); now = 130_000; assert.equal(load(), DEFAULT_RETURN_DIST);
});

test('manager: off hands out no URL and starts no child', async () => {
  const m = new CacheWarmManager({ mode: () => 'off', env: {}, sink: () => {} });
  assert.equal(await m.baseUrl('t'), null); assert.equal(m.healthy(), false);
  await m.shutdown();
});

test('manager: skips a session whose environment has a proxy', async () => {
  const m = new CacheWarmManager({ mode: () => 'shadow', env: { HTTPS_PROXY: 'http://corp:3128' }, sink: () => {} });
  assert.equal(await m.baseUrl('t'), null); assert.equal(m.healthy(), false);
  await m.shutdown();
});

test('manager (real child): serves a stream through the loopback URL, logs rows, restarts on the same port after a kill, shuts down', async () => {
  const up = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":30000,"cache_creation_input_tokens":0,"output_tokens":1}}}\n\n'); }); });
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  const rows: any[] = [];
  const m = new CacheWarmManager({ home: tmp(), mode: () => 'shadow', env: {}, upstream: `http://127.0.0.1:${(up.address() as any).port}`, sink: (r) => rows.push(r) });
  try {
    const url = await m.baseUrl('thread-9');
    assert.match(url!, /^http:\/\/127\.0\.0\.1:\d+\/s\/thread-9$/);
    const hit = (u: string) => new Promise<number>((resolve, reject) => {
      const req = http.request(`${u}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      req.end(JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 100, stream: true, system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '1h' } }], tools: [{ name: 'Bash', input_schema: {} }], messages: [{ role: 'user', content: 'hi' }] }));
    });
    assert.equal(await hit(url!), 200);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(rows.some((r) => r.k === 'prefix' && r.thread === 'thread-9'), 'the prefix row reached cost.jsonl\'s sink');

    // kill the child: it comes back on the SAME port
    const port = Number(new URL(url!).port);
    (m as any).child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(await m.baseUrl('thread-9'), url);
    assert.equal(Number(new URL((await m.baseUrl('thread-9'))!).port), port);
    assert.equal(await hit(url!), 200);
  } finally {
    await m.shutdown();
    await new Promise((r) => up.close(r));
  }
  assert.equal(m.healthy(), false);
});
