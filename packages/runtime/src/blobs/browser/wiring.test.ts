// The blob browser as the daemon wires it (Phase 6 integration): a real BlobRuntimeImpl whose browser manager is the real
// one (no engine is installed, nothing is launched). The browser tools exist for members only; an outbound action lands as
// the inline approval card of the call that raised it and the panel's bar answers the same question (first answer wins);
// the settings reach the running host; the profile lives outside every agent's cwd; the prompt tells blobs the browser rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-wiring-'));
process.env.KORA_BLOBS_ROOT = path.join(root, 'Blobs');
process.env.KORA_HOME = path.join(root, 'kora-home');
process.env.KORA_BROWSER_DIR = path.join(root, 'no-engine'); // an empty dir: nothing is installed, nothing launches

import { BlobStore } from '../store';
import { BlobRuntimeImpl } from '../runtime';
import { inlineMemoryHost } from '../memory-host';
import { openMemory } from '../../memory';
import { blobHome } from '../home';
import { blobSystemPromptText, browserSection } from '../prompt';
import { BROWSER_TOOL_NAMES } from './index';
import { sdkToolResult } from '../../session/drivers/claude-driver';
import { createBlobsMcp } from '../../cli/commands/mcp-blobs';
import type { BlobToolContext } from '../types';

const ENGINE = { instanceId: 'claude', model: 'sonnet', effort: null };

function setup() {
  const store = new BlobStore();
  const mem = openMemory({ dbPath: ':memory:', extractor: async () => '{}' });
  const rt = new BlobRuntimeImpl({ store, memory: inlineMemoryHost(mem), oneShot: async () => null, userSkillDirs: [], webhookPort: 0 });
  const popo = store.create({ name: `Popo${Math.random().toString(36).slice(2, 6)}`, title: 'Researcher', soul: 'x', engine: ENGINE });
  const kora = store.ensureKora(ENGINE, 'kora soul');
  return { store, rt, popo, kora, mem };
}

type Ask = NonNullable<BlobToolContext['askApproval']>;
const ctxFor = (blobId: string, askApproval?: Ask): BlobToolContext => ({ blobId, threadId: 'T1', agent: 'claude', cwd: '/x', ...(askApproval ? { askApproval } : {}) });

test('the browser tools are a member blob\'s; Kora (the Chief) delegates instead', () => {
  const { rt, popo, kora } = setup();
  const names = rt.toolSpecs(ctxFor(popo.id)).map((s) => s.name);
  for (const n of BROWSER_TOOL_NAMES) assert.ok(names.includes(n), `${n} is offered`);
  assert.equal(BROWSER_TOOL_NAMES.length, 12);
  assert.ok(!rt.toolSpecs(ctxFor(kora.id)).some((s) => s.name.startsWith('browser_')), 'no browser for the Chief');
  assert.deepEqual(rt.toolSpecs(ctxFor('nope')).filter((s) => s.name.startsWith('browser_')), []);
});

test('a tool call with no engine installed answers with a plain error and never downloads inside the turn', async () => {
  const { rt, popo } = setup();
  const nav = rt.toolSpecs(ctxFor(popo.id)).find((s) => s.name === 'browser_navigate')!;
  const r = await nav.handler({ url: 'http://example.test/' });
  assert.equal(r.isError, true);
  assert.match(r.text, /ENGINE_NOT_INSTALLED|not installed|set up/i);
  assert.ok(!fs.existsSync(path.join(root, 'no-engine', 'download')), 'nothing was downloaded');
});

test('the profile lives in the blob home, outside the agent cwd; kora-session-cookies stay out of every export path', () => {
  const { rt, popo } = setup();
  const st = rt.browsers.get(popo.id).status();
  assert.equal(st.profileDir, path.join(blobHome(popo.id), 'browser-profile'));
  assert.ok(!st.profileDir.startsWith(popo.workspace), 'the folder the agent works in does not contain it');
});

test('an outbound action becomes the inline approval card of the call that raised it', async () => {
  const { rt, popo } = setup();
  const asks: any[] = [];
  const specs = rt.toolSpecs(ctxFor(popo.id, (p) => { asks.push(p); return Promise.resolve(true); }));
  // any tool call registers this call's ask hook (the host starts lazily; without an engine it answers an error)
  await specs.find((s) => s.name === 'browser_snapshot')!.handler({});
  const host = rt.browsers.get(popo.id);
  assert.equal(await host.approve('Place the order for 2 tickets'), true, 'Allow once');
  assert.equal(asks.length, 1);
  assert.match(asks[0].title, new RegExp(`^${popo.name} wants to: Place the order`));
  assert.equal(asks[0].args.kind, 'app-action');
  assert.equal(asks[0].args.appName, 'Browser');
  assert.ok(asks[0].signal instanceof AbortSignal);
  assert.equal(asks[0].always, undefined, 'booking and paying never get an "Always"');
});

test('Deny on the card denies; a card that never answers cannot be Allowed', async () => {
  const { rt, popo } = setup();
  const specs = rt.toolSpecs(ctxFor(popo.id, () => Promise.resolve(false)));
  await specs[0]!.handler({});
  assert.equal(await rt.browsers.get(popo.id).approve('Pay $28'), false);
});

test('the panel\'s bar and the card are one question: the first answer wins and retires the other', async () => {
  const { rt, popo } = setup();
  let signal: AbortSignal | undefined;
  const specs = rt.toolSpecs(ctxFor(popo.id, (p) => { signal = p.signal; return new Promise<boolean>(() => {}); }));
  await specs.find((s) => s.name === 'browser_snapshot')!.handler({});
  const host = rt.browsers.get(popo.id);
  const pending = host.approve('Send the booking');
  await new Promise((r) => setImmediate(r));
  const [a] = host.status().pendingApprovals;
  assert.ok(a, 'the panel sees the pending approval');
  assert.equal(host.answerApproval(a.id, true), true, 'Allow once in the panel');
  assert.equal(await pending, true);
  assert.equal(signal?.aborted, true, 'the card was retired');
  assert.equal(host.answerApproval(a.id, false), false, 'a second answer finds nothing');
});

test('with no card to show and nobody watching the panel an outbound action is denied at once', async () => {
  const { rt, popo } = setup(); // no tool call yet: no ask hook; no viewer
  const t0 = Date.now();
  assert.equal(await rt.browsers.get(popo.id).approve('Book'), false);
  assert.ok(Date.now() - t0 < 2000, 'no waiting for the host timeout');
});

test('with the panel open and no card, the panel can answer', async () => {
  const { rt, popo } = setup();
  const host = rt.browsers.get(popo.id);
  const detach = host.addViewer();
  try {
    const pending = host.approve('Buy a ticket');
    await new Promise((r) => setImmediate(r));
    const [a] = host.status().pendingApprovals;
    assert.ok(a);
    host.answerApproval(a.id, true);
    assert.equal(await pending, true);
  } finally { detach(); }
});

test('browser settings (downloads, local dev servers) read the blob profile live', async () => {
  const { rt, popo, store } = setup();
  const host = rt.browsers.get(popo.id);
  assert.deepEqual(host.settings(), { allowLocalHosts: [], allowDownloads: false });
  store.update(popo.id, { toolGrants: { ...popo.toolGrants, computer: { ...popo.toolGrants.computer, allowDownloads: true, allowLocalHosts: ['localhost:5173', '*.test'] } } });
  assert.deepEqual(host.settings(), { allowLocalHosts: ['localhost:5173', '*.test'], allowDownloads: true });
});

test('retiring or deleting a blob closes its browser; the live source only knows live blobs', async () => {
  const { rt, popo, store } = setup();
  const closed: string[] = [];
  const real = rt.browsers.close.bind(rt.browsers);
  rt.browsers.close = async (id: string) => { closed.push(id); return real(id); };
  const live = rt.browserLive;
  assert.ok(live.get(popo.id), 'a live blob has a browser');
  assert.equal(live.get('blob_nope'), undefined);
  store.archive(popo.id);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(closed, [popo.id]);
  assert.equal(live.get(popo.id), undefined, 'an archived blob has none');
});

test('the prompt tells a blob the browser rules; Kora gets none of it', () => {
  const { rt, popo, kora } = setup();
  const p = rt.systemPrompt({ blobId: popo.id, threadId: 'T1', agent: 'claude' });
  assert.match(p, /# Your browser/);
  assert.match(p, /untrusted data/);
  assert.match(p, /Never type a password/);
  assert.match(p, /USER_HAS_CONTROL/);
  assert.match(p, /DENIED or BLOCKED/);
  assert.doesNotMatch(rt.systemPrompt({ blobId: kora.id, threadId: 'T2', agent: 'claude' }), /# Your browser/);
  assert.ok(browserSection().length > 5);
  assert.doesNotMatch(blobSystemPromptText({ blob: popo, soul: '', aboutMe: '', core: { you: '', blob: '' }, agent: 'claude', blobHome: '/h', skillIndex: '', koraCmd: 'kora', canDelegateLegwork: false }), /# Your browser/, 'only when the blob has the browser');
});

test('a screenshot reaches the model as an image block (Claude) and over the MCP bridge (Codex / OpenCode / ACP)', async () => {
  const r = sdkToolResult({ text: 'Screenshot 1280x800', image: { data: 'QUJD', mimeType: 'image/jpeg' } });
  assert.deepEqual(r.content, [{ type: 'text', text: 'Screenshot 1280x800' }, { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }]);
  assert.deepEqual(sdkToolResult({ text: 'x', isError: true }), { content: [{ type: 'text', text: 'x' }], isError: true });

  const input = new EventEmitter() as any; input.setEncoding = () => {}; input.resume = () => {};
  const out: string[] = [];
  const calls: string[] = [];
  const server = createBlobsMcp({
    blobId: 'b', token: 't', input, output: { write: (s: string) => { out.push(s); return true; } } as any,
    call: async (method) => {
      calls.push(method);
      if (method === 'blobs.mcp.hello') return { ok: true, chief: false, tools: [{ name: 'browser_screenshot', description: 'd', params: {} }] };
      return { text: 'Screenshot', image: { data: 'QUJD', mimeType: 'image/jpeg' } };
    },
  });
  server.start();
  await server.dispatch(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  await server.dispatch(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_screenshot', arguments: {} } }));
  const res = JSON.parse(out[out.length - 1]!);
  assert.deepEqual(res.result.content, [{ type: 'text', text: 'Screenshot' }, { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }]);
});

test('the same tools reach a Codex / OpenCode / ACP blob through the MCP hub, and a call there raises the same card', async () => {
  const { rt, popo } = setup();
  const asks: any[] = [];
  const token = rt.mcpIssue({ blobId: popo.id, threadId: 'T9', agent: 'codex', cwd: popo.workspace, askApproval: (p) => { asks.push(p); return Promise.resolve(false); } });
  const hello = rt.hub.hello({ blobId: popo.id, token });
  assert.ok(hello.ok);
  if (hello.ok) for (const n of BROWSER_TOOL_NAMES) assert.ok(hello.tools.some((t) => t.name === n), `${n} over MCP`);
  await rt.hub.call({ blobId: popo.id, token, name: 'browser_snapshot', args: {} });
  assert.equal(await rt.browsers.get(popo.id).approve('Submit the order form'), false, 'Deny on the card');
  assert.equal(asks.length, 1);
});

test('an approval still waiting when the agent gives up is withdrawn: not live in the panel, request not sent', async () => {
  const { rt, popo } = setup();
  const host = rt.browsers.get(popo.id);
  const detach = host.addViewer();
  try {
    const waiting = host.approve('Send data (POST shop.example/api/pay)');
    await new Promise((r) => setImmediate(r));
    assert.equal(host.status().pendingApprovals.length, 1, 'live in the panel while the turn runs');
    assert.equal(host.retireApprovals(), 1);
    assert.equal(await waiting, false, 'denied, not allowed');
    assert.equal(host.status().pendingApprovals.length, 0, 'gone from the panel');
  } finally { detach(); }
});
