// API-endpoint engine against a local fake OpenAI/Anthropic server: model list + Test call, streaming, the tool loop,
// posture/confinement of the built-in tools, error mapping (401/402/429/5xx/network), resume, interrupt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ApiDriver, builtinToolDefs, pathsInCommand, privateHost, repairHistory } from './api-driver';
import { ApiError, classifyHttp, listApiModels, normalizeEndpoint, parseRetryAfter, presetEndpoint, secretNameFor, testApiEndpoint, endpointKeys, type ApiEndpoint } from './api-providers';
import { toAnthropicMessages, toOpenAiMessages, trimHistory, type ChatMsg } from './api-agent-loop';
import { MemorySecretStore } from '../../blobs/apps/secrets';
import type { ChatEvent, RuntimeMode } from '../events';
import type { DriverDeps, SessionStartInput } from '../session-driver';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-t-')));
const waitFor = async (f: () => boolean, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout: ' + f.toString()); await new Promise((r) => setTimeout(r, 10)); } };
const GOOD = 'sk-good-key-12345';
async function closedPort(): Promise<number> { const srv = http.createServer(); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const port = (srv.address() as AddressInfo).port; await new Promise<void>((r) => srv.close(() => r())); return port; }

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: any }
async function fakeServer() {
  const seen: Seen[] = [];
  let hang = false;
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const anth = req.url!.startsWith('/anth');
      const authed = anth ? req.headers['x-api-key'] === GOOD : req.headers.authorization === `Bearer ${GOOD}`;
      const sse = (events: any[], named = false) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const e of events) res.write(named ? `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n` : `data: ${JSON.stringify(e)}\n\n`); if (!named) res.write('data: [DONE]\n\n'); res.end(); };
      if (req.url!.endsWith('/models') || req.url!.includes('/models?')) {
        if (req.url!.startsWith('/nomodels')) { res.writeHead(404); return res.end('not found'); }
        if (!authed) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"bad key"}}'); }
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'm-a' }, { id: 'm-b', display_name: 'Model B' }] }));
      }
      if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><script>x()</script><body><h1>Title</h1><p>Body &amp; text</p></body></html>'); }
      if (!authed) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"invalid x-api-key"}}'); }
      const msgs: any[] = body?.messages ?? [];
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user' && (typeof m.content === 'string'));
      const scenario = String(lastUser?.content ?? '').split('\n')[0]!;
      const last = msgs[msgs.length - 1];
      const afterTool = anth ? Array.isArray(last?.content) && last.content[0]?.type === 'tool_result' : last?.role === 'tool';
      const toolText = anth ? last?.content?.[0]?.content : last?.content;
      if (scenario === '429') { res.writeHead(429, { 'retry-after': '7', 'content-type': 'application/json' }); return res.end('{"error":{"message":"slow down"}}'); }
      if (scenario === '402') { res.writeHead(402); return res.end('{"error":{"message":"no credit"}}'); }
      if (scenario === '500') { res.writeHead(503); return res.end('upstream down'); }
      if (scenario === 'slow') { hang = true; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'zzz' } }] })}\n\n`); res.on('close', () => { hang = false; }); return; }
      if (anth) {
        if (afterTool) return sse([{ type: 'message_start', message: { usage: { input_tokens: 30 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'result: ' + toolText } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }], true);
        if (scenario.startsWith('tool ')) return sse([{ type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 5 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'running' } }, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'run_shell' } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(scenario.slice(5)) + '}' } }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }], true);
        return sse([{ type: 'message_start', message: { usage: { input_tokens: 10 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }], true);
      }
      if (afterTool) return sse([{ choices: [{ delta: { content: 'result: ' + toolText } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 40, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 8 } } }]);
      const callTool = (name: string, args: any) => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: JSON.stringify(args).slice(0, 8) } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(8) } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, { choices: [], usage: { prompt_tokens: 25, completion_tokens: 5 } }]);
      if (scenario.startsWith('tool ')) return callTool('run_shell', { command: scenario.slice(5) });
      if (scenario.startsWith('write ')) return callTool('write_file', { path: scenario.slice(6), content: 'hello' });
      if (scenario.startsWith('read ')) return callTool('read_file', { path: scenario.slice(5) });
      if (scenario.startsWith('fetch ')) return callTool('web_fetch', { url: scenario.slice(6) });
      if (scenario === 'recall') return callTool('recall', { query: 'cats' });
      if (scenario === 'badjson') return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'run_shell', arguments: '{"command": ' } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]);
      return sse([{ choices: [{ delta: { reasoning_content: 'hmm' } }] }, { choices: [{ delta: { content: 'Hel' } }] }, { choices: [{ delta: { content: 'lo' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } }]);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, seen, close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }), isHanging: () => hang };
}

const openai = (base: string, over: Partial<ApiEndpoint> = {}): ApiEndpoint => normalizeEndpoint({ id: 'fake', label: 'Fake AI', protocol: 'openai', baseUrl: `${base}/v1`, requiresKey: true, ...over });
const anthropic = (base: string): ApiEndpoint => normalizeEndpoint({ id: 'anth', label: 'Fake Claude', protocol: 'anthropic', baseUrl: `${base}/anth`, requiresKey: true });

function rig(ep: ApiEndpoint, o: { mode?: RuntimeMode; key?: string | null; deps?: Partial<DriverDeps>; cwd?: string; stateDir?: string } = {}) {
  const cwd = o.cwd ?? tmp(); const stateDir = o.stateDir ?? tmp();
  const deps = { graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => 'PERSONA', ...(o.deps ?? {}) } as unknown as DriverDeps;
  const driver = new ApiDriver(deps, { endpoint: ep, getKey: async () => (o.key === undefined ? GOOD : o.key), stateDir });
  const events: ChatEvent[] = [];
  driver.streamEvents((e) => events.push(e));
  const auto: { decision: 'accept' | 'decline' | null } = { decision: 'accept' };
  driver.streamEvents((e) => { if (e.type === 'approval.opened' && auto.decision) void driver.respondToApproval(e.threadId, e.requestId, auto.decision); });
  const input = (over: Partial<SessionStartInput> = {}): SessionStartInput => ({ threadId: 't1', agent: ep.agentId as any, cwd, account: null, runtimeMode: o.mode ?? 'auto', model: { model: 'm-a' }, ...over });
  const turn = async (text: string) => {
    const from = events.length;
    const h = await driver.sendTurn({ threadId: 't1', text });
    await waitFor(() => events.slice(from).some((e) => e.type === 'turn.settled' && e.turnId === h.turnId));
    return events.slice(from);
  };
  const text = (evs: ChatEvent[]) => evs.filter((e) => e.type === 'content.delta' && e.stream === 'assistant_text').map((e: any) => e.delta).join('');
  const settled = (evs: ChatEvent[]) => evs.find((e) => e.type === 'turn.settled') as any;
  return { cwd, stateDir, driver, events, input, turn, text, settled, auto };
}
const chats = (seen: Seen[]) => seen.filter((s) => s.method === 'POST');

test('models list + Test call: checks catalog access with GET /models only, never a chat message', async () => {
  const s = await fakeServer();
  const ep = openai(s.base);
  assert.deepEqual((await listApiModels(ep, GOOD)).map((m) => m.id), ['m-a', 'm-b']);
  s.seen.length = 0;
  const ok = await testApiEndpoint(ep, GOOD);
  assert.equal(ok.ok, true); assert.equal(ok.modelCount, 2); assert.match(ok.message, /2 models available/);
  const bad = await testApiEndpoint(ep, 'sk-wrong-key-00000');
  assert.equal(bad.ok, false); assert.equal(bad.kind, 'auth'); assert.match(bad.message, /rejected the API key \(HTTP 401\)/);
  assert.equal((await testApiEndpoint(ep, null)).kind, 'auth');
  assert.deepEqual([...new Set(s.seen.map((x) => x.method + ' ' + x.url))], ['GET /v1/models']);
  const nm = await testApiEndpoint(openai(s.base, { baseUrl: `${s.base}/nomodels`, requiresKey: false }), null);
  assert.equal(nm.ok, true); assert.equal(nm.kind, 'no-model-list');
  const down = await testApiEndpoint(normalizeEndpoint({ id: 'lm', label: 'LM Studio', baseUrl: `http://127.0.0.1:${await closedPort()}/v1` }), null);
  assert.equal(down.ok, false); assert.equal(down.kind, 'network'); assert.match(down.message, /Start LM Studio/);
  const a = await testApiEndpoint(anthropic(s.base), GOOD);
  assert.equal(a.ok, true); assert.equal(s.seen.at(-1)!.headers['anthropic-version'], '2023-06-01'); assert.equal(s.seen.at(-1)!.url, '/anth/v1/models?limit=1000');
  await s.close();
});

test('endpoint model: presets, URL validation, key names, SecretStore round trip', async () => {
  assert.equal(presetEndpoint('groq')!.baseUrl, 'https://api.groq.com/openai/v1'); assert.equal(presetEndpoint('ollama')!.requiresKey, false);
  assert.throws(() => normalizeEndpoint({ id: 'x', baseUrl: 'http://example.com/v1' }), /Only local servers may use http/);
  assert.throws(() => normalizeEndpoint({ id: 'x', baseUrl: 'https://u:p@example.com' }), /key field/);
  assert.throws(() => normalizeEndpoint({ id: 'Bad Id', baseUrl: 'https://example.com' }), /lowercase/);
  assert.equal(normalizeEndpoint({ id: 'x', baseUrl: 'https://example.com/v1/' }).baseUrl, 'https://example.com/v1');
  const store = new MemorySecretStore(); const keys = endpointKeys(store);
  assert.equal(await keys.has('fireworks'), false); await keys.set('fireworks', '  fw_abcdef123456 '); assert.equal(await keys.get('fireworks'), 'fw_abcdef123456'); assert.equal(secretNameFor('fireworks'), 'api-fireworks');
  await keys.delete('fireworks'); assert.equal(await keys.has('fireworks'), false);
});

test('OpenAI streaming: reasoning + text deltas, usage, persona as system message, tools offered, bearer key from the secret store', async () => {
  const s = await fakeServer(); const r = rig(openai(s.base));
  await r.driver.startSession(r.input());
  const evs = await r.turn('hello');
  assert.equal(r.text(evs), 'Hello'); assert.equal(r.settled(evs).state, 'completed');
  assert.equal((evs.find((e) => e.type === 'content.delta' && (e as any).stream === 'reasoning_text') as any).delta, 'hmm');
  assert.deepEqual(r.settled(evs).usage, { usageStatus: 'complete', inputTokens: 12, outputTokens: 2 });
  const req = chats(s.seen)[0]!;
  assert.equal(req.headers.authorization, `Bearer ${GOOD}`); assert.equal(req.body.model, 'm-a'); assert.equal(req.body.stream, true);
  assert.deepEqual(req.body.messages[0], { role: 'system', content: 'PERSONA' });
  assert.deepEqual(req.body.tools.map((t: any) => t.function.name), builtinToolDefs().map((t) => t.name));
  await s.close();
});

test('tool loop (OpenAI): split tool-call arguments are assembled, run_shell runs in the workspace, the result is fed back', async () => {
  const s = await fakeServer(); const r = rig(openai(s.base));
  await r.driver.startSession(r.input());
  fs.writeFileSync(path.join(r.cwd, 'note.txt'), 'x');
  const evs = await r.turn('tool ls');
  assert.equal(r.text(evs), 'result: note.txt');
  const started = evs.find((e) => e.type === 'tool.started') as any; const res = evs.find((e) => e.type === 'tool.result') as any;
  assert.equal(started.toolKind, 'command_execution'); assert.equal(started.title, '$ ls'); assert.equal(res.status, 'completed'); assert.equal(res.output, 'note.txt');
  assert.equal(evs.some((e) => e.type === 'approval.opened'), false);
  assert.equal(chats(s.seen).length, 2);
  const second = chats(s.seen)[1]!.body.messages;
  assert.equal(second.at(-2).tool_calls[0].function.arguments, '{"command":"ls"}'); assert.deepEqual(second.at(-1), { role: 'tool', tool_call_id: 'call_1', content: 'note.txt' });
  const h = r.driver.history('t1'); assert.deepEqual(h.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  await s.close();
});

test('tool loop (Anthropic): tool_use blocks, tool_result user message, x-api-key + version headers, cache-aware usage', async () => {
  const s = await fakeServer(); const r = rig(anthropic(s.base));
  await r.driver.startSession(r.input());
  const plain = await r.turn('hello'); assert.equal(r.text(plain), 'Hi there');
  const evs = await r.turn('tool echo hi');
  assert.equal(r.text(evs), 'running' + 'result: hi'); assert.equal(r.settled(evs).state, 'completed');
  const req = chats(s.seen).at(-1)!;
  assert.equal(req.headers['x-api-key'], GOOD); assert.equal(req.headers['anthropic-version'], '2023-06-01'); assert.equal(req.body.system, 'PERSONA');
  assert.equal(req.body.max_tokens > 0, true); assert.ok(req.body.tools[0].input_schema);
  const last = req.body.messages.at(-1); assert.deepEqual(last.content[0], { type: 'tool_result', tool_use_id: 'tu1', content: 'hi' });
  assert.equal(req.body.messages.at(-2).content[1].type, 'tool_use');
  assert.equal(r.settled(evs).usage.cachedInputTokens, 5);
  await s.close();
});

test('built-in tools obey the posture: Supervised asks (decline = not run), Auto outbound asks, writes cannot leave the folders', async () => {
  const s = await fakeServer();
  const sup = rig(openai(s.base), { mode: 'approval-required' });
  await sup.driver.startSession(sup.input()); sup.auto.decision = 'decline';
  let evs = await sup.turn(`tool touch '${path.join(sup.cwd, 'no.txt')}'`);
  assert.ok(evs.some((e) => e.type === 'approval.opened')); assert.equal(fs.existsSync(path.join(sup.cwd, 'no.txt')), false);
  assert.match((evs.find((e) => e.type === 'tool.result') as any).output, /Not run: The user declined/);
  sup.auto.decision = 'accept';
  evs = await sup.turn(`tool touch '${path.join(sup.cwd, 'yes.txt')}'`); assert.equal(fs.existsSync(path.join(sup.cwd, 'yes.txt')), true);

  const au = rig(openai(s.base), { mode: 'auto' }); await au.driver.startSession(au.input());
  evs = await au.turn('tool echo curl'); assert.match((evs.find((e) => e.type === 'approval.opened') as any).detail, /send data out/);
  const outside = tmp();
  evs = await au.turn(`write ${path.join(outside, 'w.txt')}`);
  assert.equal(fs.existsSync(path.join(outside, 'w.txt')), false); assert.match(au.text(evs), /outside the workspace/);
  evs = await au.turn('write docs/w.txt'); assert.equal(fs.readFileSync(path.join(au.cwd, 'docs', 'w.txt'), 'utf8'), 'hello');
  assert.deepEqual((evs.find((e) => e.type === 'tool.result') as any).changedFiles, [{ path: path.join(au.cwd, 'docs', 'w.txt'), additions: 0, deletions: 0 }]);
  fs.writeFileSync(path.join(outside, 's.txt'), 'SECRET');
  evs = await au.turn(`read ${path.join(outside, 's.txt')}`); assert.ok(evs.some((e) => e.type === 'approval.opened'), 'reading outside the folders asks');
  au.auto.decision = 'decline'; evs = await au.turn(`read ${path.join(outside, 's.txt')}`); assert.equal(/SECRET/.test(au.text(evs)), false);

  const full = rig(openai(s.base), { mode: 'full-access' }); await full.driver.startSession(full.input());
  evs = await full.turn('tool echo curl'); assert.equal(evs.some((e) => e.type === 'approval.opened'), false);
  await s.close();
});

test('web_fetch: local addresses are refused unless Full access; HTML is reduced to text', async () => {
  const s = await fakeServer();
  const a = rig(openai(s.base), { mode: 'auto' }); await a.driver.startSession(a.input());
  let evs = await a.turn(`fetch ${s.base}/page`); assert.match(a.text(evs), /local address|on this Mac/);
  const f = rig(openai(s.base), { mode: 'full-access' }); await f.driver.startSession(f.input());
  evs = await f.turn(`fetch ${s.base}/page`); assert.match(f.text(evs), /HTTP 200\nTitle Body & text/); assert.equal(/script|<h1>/.test(f.text(evs)), false);
  assert.equal(privateHost('192.168.1.5'), true); assert.equal(privateHost('example.com'), false); assert.equal(privateHost('172.20.0.1'), true);
  await s.close();
});

test('the blob\'s own tools (recall...) are offered next to the built-ins and run through their handler', async () => {
  const s = await fakeServer(); const cwd = tmp(); const calls: any[] = [];
  const r = rig(openai(s.base), { cwd, deps: { blobs: {
    byCwd: (c: string) => (c === cwd ? { id: 'blob_a', role: 'member', permission: 'auto', workspace: cwd } : null),
    toolSpecs: () => [{ name: 'recall', description: 'search memory', params: { query: { type: 'string' } }, handler: async (a: any) => { calls.push(a); return { text: 'cats are great' }; } }], skills: () => ({ dir: '', qualified: [] }),
  } } as any });
  await r.driver.startSession(r.input());
  const evs = await r.turn('recall');
  assert.deepEqual(calls, [{ query: 'cats' }]); assert.equal(r.text(evs), 'result: cats are great');
  const tools = chats(s.seen)[0]!.body.tools.map((t: any) => t.function.name); assert.ok(tools.includes('recall') && tools.includes('run_shell'));
  assert.deepEqual(chats(s.seen)[0]!.body.tools.find((t: any) => t.function.name === 'recall').function.parameters.required, ['query']);
  await s.close();
});

test('errors: 401 -> clear message; 429 -> rate-limit card event with reset time; 402 and 5xx; missing key; nothing throws', async () => {
  const s = await fakeServer(); const ep = openai(s.base);
  const r = rig(ep, { key: 'sk-wrong-key-00000' }); await r.driver.startSession(r.input());
  let evs = await r.turn('hello');
  assert.equal(r.settled(evs).state, 'failed'); assert.match(r.settled(evs).errorMessage, /rejected the API key \(HTTP 401\)/); assert.equal(evs.some((e) => e.type === 'usage.rate-limit'), false);

  const g = rig(ep); await g.driver.startSession(g.input());
  const before = Date.now();
  evs = await g.turn('429');
  const rl = evs.find((e) => e.type === 'usage.rate-limit') as any;
  assert.ok(rl); assert.match(rl.message, /rate-limiting this key \(HTTP 429\).*7s/); assert.ok(rl.resetsAt >= before + 6000 && rl.resetsAt <= Date.now() + 8000);
  assert.equal(g.settled(evs).state, 'failed');
  evs = await g.turn('402'); assert.ok(evs.some((e) => e.type === 'usage.rate-limit')); assert.match(g.settled(evs).errorMessage, /out of credit/);
  evs = await g.turn('500'); assert.match(g.settled(evs).errorMessage, /having trouble right now \(HTTP 503\)/); assert.equal(evs.some((e) => e.type === 'usage.rate-limit'), false);
  evs = await g.turn('hello'); assert.equal(g.settled(evs).state, 'completed', 'a failed turn leaves the thread usable');

  const nk = rig(ep, { key: null }); await nk.driver.startSession(nk.input());
  evs = await nk.turn('hello'); assert.match(nk.settled(evs).errorMessage, /needs an API key/);
  assert.equal(chats(s.seen).filter((x) => x.headers.authorization === undefined).length, 0, 'no request went out without a key');
  const dead = rig(normalizeEndpoint({ id: 'lm', label: 'LM Studio', baseUrl: `http://127.0.0.1:${await closedPort()}/v1` }), { key: null }); await dead.driver.startSession(dead.input());
  evs = await dead.turn('hello'); assert.match(dead.settled(evs).errorMessage, /Nothing is listening/);
  assert.equal((evs.find((e) => e.type === 'runtime.error') as any).errorClass, 'transport');
  await s.close();
});

test('malformed tool arguments are reported back to the model instead of crashing the turn', async () => {
  const s = await fakeServer(); const r = rig(openai(s.base)); await r.driver.startSession(r.input());
  const evs = await r.turn('badjson');
  const res = evs.find((e) => e.type === 'tool.result') as any;
  assert.equal(res.status, 'failed'); assert.match(res.output, /not valid JSON/);
  await s.close();
});

test('interrupt aborts the stream and kills a running shell; the thread keeps working', async () => {
  const s = await fakeServer(); const r = rig(openai(s.base)); await r.driver.startSession(r.input());
  const h = await r.driver.sendTurn({ threadId: 't1', text: 'slow' });
  await waitFor(() => r.events.some((e) => e.type === 'content.delta'));
  await r.driver.interruptTurn('t1');
  await waitFor(() => r.events.some((e) => e.type === 'turn.settled' && e.turnId === h.turnId));
  assert.equal(r.settled(r.events).state, 'interrupted');
  await waitFor(() => !s.isHanging());
  const h2 = await r.driver.sendTurn({ threadId: 't1', text: 'tool sleep 30' });
  await waitFor(() => r.events.some((e) => e.type === 'tool.started'));
  const t0 = Date.now();
  await r.driver.interruptTurn('t1');
  await waitFor(() => r.events.some((e) => e.type === 'turn.settled' && e.turnId === h2.turnId), 3000);
  assert.ok(Date.now() - t0 < 3000, 'the shell was killed, not waited for');
  assert.equal(r.events.filter((e) => e.type === 'turn.settled').at(-1) && (r.events.filter((e) => e.type === 'turn.settled').at(-1) as any).state, 'interrupted');
  const ok = await r.turn('hello'); assert.equal(r.settled(ok).state, 'completed');
  await s.close();
});

test('resume: the conversation is stored per thread and reloaded after a restart (tool pairs repaired)', async () => {
  const s = await fakeServer(); const stateDir = tmp(); const cwd = tmp();
  const a = rig(openai(s.base), { stateDir, cwd }); await a.driver.startSession(a.input()); await a.turn('hello'); await a.driver.stopSession('t1');
  const b = rig(openai(s.base), { stateDir, cwd });
  const start = await b.driver.startSession(b.input({ resume: 'api:t1' }));
  assert.equal(start.resume, 'api:t1');
  s.seen.length = 0; await b.turn('again');
  const msgs = chats(s.seen)[0]!.body.messages; assert.deepEqual(msgs.map((m: any) => m.role), ['system', 'user', 'assistant', 'user']); assert.equal(msgs[2].content, 'Hello');
  const fresh = rig(openai(s.base), { stateDir, cwd }); await fresh.driver.startSession(fresh.input({ resume: undefined }));
  assert.equal(fresh.driver.history('t1').length, 0, 'no resume cursor = a fresh conversation');
  await s.close();
});

test('pure helpers: repairHistory, trimHistory, message conversion, command paths, retry-after, classify', () => {
  const h: ChatMsg[] = [{ role: 'user', text: 'a' }, { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'run_shell', args: {} }, { id: 'c2', name: 'run_shell', args: {} }] }, { role: 'tool', callId: 'c1', name: 'run_shell', text: 'x' }];
  const fixed = repairHistory(h); assert.equal(fixed.length, 4); assert.equal((fixed[3] as any).callId, 'c2');
  const long: ChatMsg[] = Array.from({ length: 100 }, (_, i) => (i % 2 ? { role: 'assistant', text: 'a', toolCalls: [] } : { role: 'user', text: 'u' }));
  assert.equal(trimHistory(long, 10)[0]!.role, 'user'); assert.ok(trimHistory(long, 10).length <= 10);
  const anth = toAnthropicMessages([{ role: 'tool', callId: 'a', name: 'x', text: '1' }, { role: 'tool', callId: 'b', name: 'x', text: '2', isError: true }]) as any[];
  assert.equal(anth.length, 1); assert.equal(anth[0].content.length, 2); assert.equal(anth[0].content[1].is_error, true);
  assert.deepEqual((toOpenAiMessages('', [{ role: 'user', text: 'q' }]) as any[]), [{ role: 'user', content: 'q' }]);
  if (process.platform !== 'win32') assert.deepEqual(pathsInCommand('cat ~/x && ls /etc ../up "/a b" ./ok', '/w').sort(), [os.homedir() + '/x', '/etc', '/up', '/a'].sort());
  else assert.deepEqual(pathsInCommand('type C:\\Users\\x\\.ssh\\id_rsa && cat C:/a/b ~\\y ..\\up .\\ok', 'D:\\w').sort(), ['C:\\Users\\x\\.ssh\\id_rsa', 'C:/a/b', path.join(os.homedir(), 'y'), 'D:\\up'].sort());
  assert.equal(parseRetryAfter('7'), 7000); assert.equal(parseRetryAfter(null), undefined);
  const ep = openai('http://127.0.0.1:1'); const e = classifyHttp(ep, 429, '{"error":{"message":"x"}}', new Headers({ 'retry-after': '3' }));
  assert.ok(e instanceof ApiError); assert.equal(e.kind, 'rate_limit'); assert.equal(e.retryAfterMs, 3000);
  assert.equal(classifyHttp(ep, 404, 'nope').kind, 'client'); assert.equal(classifyHttp(ep, 502, '').kind, 'server');
});

test('an endpoint edited in Settings applies to the next turn of a LIVE thread (getEndpoint), not only to new threads', async () => {
  const one = await fakeServer(); const two = await fakeServer();
  let ep = openai(one.base);
  const cwd = tmp();
  const deps = { graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => 'PERSONA' } as unknown as DriverDeps;
  const driver = new ApiDriver(deps, { endpoint: ep, getEndpoint: () => ep, getKey: async () => GOOD, stateDir: tmp() });
  const events: ChatEvent[] = []; driver.streamEvents((e) => events.push(e));
  await driver.startSession({ threadId: 'L1', agent: ep.agentId as any, cwd, account: null, runtimeMode: 'auto', model: { model: 'm-a' } });
  const run = async (text: string) => { const from = events.length; const h = await driver.sendTurn({ threadId: 'L1', text }); await waitFor(() => events.slice(from).some((e) => e.type === 'turn.settled' && e.turnId === h.turnId)); };
  await run('hello');
  assert.equal(chats(one.seen).length, 1);
  ep = openai(two.base); // the user pointed the endpoint somewhere else
  await run('hello again');
  assert.equal(chats(one.seen).length, 1, 'the old server heard nothing more');
  assert.equal(chats(two.seen).length, 1, 'the next turn went to the new address');
  await one.close(); await two.close();
});

test('deep audit 2026-10-13: run_shell in Full access runs under the credential read-deny (an obfuscated ~/.ssh read finds nothing)', { skip: process.platform !== 'darwin' }, async () => {
  const { osSandboxSupported } = await import('../os-sandbox');
  if (!osSandboxSupported()) return;
  const dir = path.join(os.homedir(), '.ssh'); fs.mkdirSync(dir, { recursive: true });
  const canary = path.join(dir, `kora-api-canary-${process.pid}`); fs.writeFileSync(canary, 'API-CANARY');
  try {
    const s = await fakeServer(); const f = rig(openai(s.base), { mode: 'full-access' }); await f.driver.startSession(f.input());
    // The text names no credential path (the posture check passes it); the shell builds the path at run time.
    const evs = await f.turn(`tool cat "$HOME/$(printf '\\056ssh')/kora-api-canary-${process.pid}"; echo done`);
    const res = evs.find((e) => e.type === 'tool.result') as any;
    assert.ok(res, 'the command ran'); assert.equal(/API-CANARY/.test(String(res.output)), false, String(res.output));
    await s.close();
  } finally { fs.rmSync(canary, { force: true }); }
});
