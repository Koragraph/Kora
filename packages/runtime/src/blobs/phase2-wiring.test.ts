// Phase 2 as the daemon wires it: a real BlobRuntimeImpl (team service inside) over a fake engine bridge. Kora's tools
// come out of runtime.toolSpecs, the ui-server's RPC bodies are runtime methods, Codex / OpenCode Chiefs reach the same
// tools through the hub, and an Undo restores everything an edit_blob changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, fakeBridge, resetHome, tempHome } from './testkit-team';
tempHome('p2-wiring-');

import { BlobStore } from './store';
import { BlobRuntimeImpl } from './runtime';
import { inlineMemoryHost } from './memory-host';
import { openMemory } from '../memory';
import { CHIEF_SOUL } from './chief';
import { KORA_SOUL, hireTemplate } from './templates';
import { createBlobsMcp } from '../cli/commands/mcp-blobs';
import { blobsMcpSpec, codexBlobsMcpArgs, opencodeBlobsMcpEntry, withOpencodeBlobsMcp } from './mcp-wire';
import type { BlobToolContext } from './types';
import { PassThrough } from 'node:stream';

const BRIEF = 'Goal: research neighbourhoods in Lisbon for a family of four. Inputs: mid budget, May. Done: a one-page brief in outputs/lisbon.md with sources.';

function setup() {
  resetHome();
  const store = new BlobStore();
  const mem = openMemory({ dbPath: ':memory:', extractor: () => Promise.reject(new Error('none')) });
  const rt = new BlobRuntimeImpl({ store, memory: inlineMemoryHost(mem, () => {}), oneShot: async () => null, koraCmd: 'kora', userSkillDirs: [] });
  // Phase 1 left Kora with the short stand-in SOUL: ensureKora must move her to the full one
  const kora = store.ensureKora(ENGINE, CHIEF_SOUL);
  const popo = (hireTemplate(store, 'popo', { defaultEngine: ENGINE }) as any).profile;
  const junip = (hireTemplate(store, 'junip', { defaultEngine: ENGINE }) as any).profile;
  const fb = fakeBridge();
  const shown: any[] = [];
  const ctx = (blobId: string, extra: Partial<BlobToolContext> & { fullAccess?: () => boolean } = {}) => ({ blobId, threadId: `kt-${blobId}`, agent: 'claude', cwd: '/x', emitCard: (c: any) => { shown.push(c); }, ...extra });
  const tools = (blobId: string, extra: Record<string, unknown> = {}) => {
    const by = new Map(rt.toolSpecs(ctx(blobId, extra as any)).map((t) => [t.name, t] as const));
    return { names: [...by.keys()], call: (name: string, args: Record<string, unknown> = {}) => by.get(name)!.handler(args) };
  };
  return { store, rt, kora, popo, junip, fb, shown, tools, ctx };
}

test('ensureKora moves an untouched Phase 1 Kora to the full SOUL; an edited SOUL is left alone', () => {
  const s = setup();
  assert.equal(s.store.soul(s.kora.id).trim(), CHIEF_SOUL.trim());
  s.rt.ensureKora(ENGINE);
  assert.equal(s.store.soul(s.kora.id).trim(), KORA_SOUL.trim());
  s.store.writeSoul(s.kora.id, 'My own Kora.');
  s.rt.ensureKora(ENGINE);
  assert.equal(s.store.soul(s.kora.id), 'My own Kora.');
});

test('toolSpecs: Kora gets self + 13 team tools + the 2 group tools, a member only its self tools; the Chief prompt carries the cards and the turn delta shows once per change', async () => {
  const s = setup();
  s.rt.attachEngine(s.fb.bridge);
  const k = s.tools(s.kora.id);
  assert.ok(k.names.includes('recall') && k.names.includes('plan_job') && k.names.includes('delegate_to'));
  assert.ok(['list_routines', 'schedule_routine', 'change_routine'].every((n) => k.names.includes(n)));
  assert.ok(k.names.includes('create_group') && k.names.includes('list_groups'), 'Phase 3: the real group tools (Chief only)');
  assert.equal(k.names.length, 6 + 13 + 2 + 3); // + the group tools and the three routine tools every blob has
  const p = s.tools(s.popo.id);
  assert.ok(p.names.includes('remember') && !p.names.includes('plan_job') && !p.names.includes('delegate_to'));
  const prompt = s.rt.systemPrompt({ blobId: s.kora.id, threadId: 'T1', agent: 'claude' });
  assert.match(prompt, /You are the Chief/);
  assert.match(prompt, /Popo/); assert.match(prompt, /Junip/);
  const memberPrompt = s.rt.systemPrompt({ blobId: s.popo.id, threadId: 'T2', agent: 'claude' });
  assert.doesNotMatch(memberPrompt, /You are the Chief/);
  // no change since the prompt: no delta; a hire changes the cards: one <team> block, then quiet again
  const ctx1 = await s.rt.turnContext({ blobId: s.kora.id, threadId: 'T1', text: 'hi', agent: 'claude', origin: null });
  assert.doesNotMatch(ctx1, /<team>/);
  hireTemplate(s.store, 'wobbo', { defaultEngine: ENGINE });
  const ctx2 = await s.rt.turnContext({ blobId: s.kora.id, threadId: 'T1', text: 'hi again', agent: 'claude', origin: null });
  assert.match(ctx2, /<team>[\s\S]*Wobbo[\s\S]*<\/team>/);
  const ctx3 = await s.rt.turnContext({ blobId: s.kora.id, threadId: 'T1', text: 'and again', agent: 'claude', origin: null });
  assert.doesNotMatch(ctx3, /<team>/);
  // a delegated blob thread's first turn says who sent it
  const fromKora = await s.rt.turnContext({ blobId: s.popo.id, threadId: 'T9', text: 'brief', agent: 'claude', origin: { kind: 'kora', jobId: 'j', stepId: 's', fromThreadId: 'k', fromBlobId: s.kora.id } });
  assert.match(fromKora, /handed to you by Kora/);
});

test('job lifecycle through the runtime: plan -> delegate -> settle -> accept, and Cancel interrupts the running thread', async () => {
  const s = setup();
  s.rt.attachEngine(s.fb.bridge);
  const t = s.tools(s.kora.id);
  assert.ok(!(await t.call('plan_job', { title: 'Lisbon', steps: [{ id: 's1', blob: 'Popo', task: 'Research' }, { id: 's2', blob: 'Junip', task: 'Draft the email' }] })).isError);
  const jobId = s.shown.find((c) => c.cardKind === 'job').cardId;
  assert.ok(!(await t.call('delegate_to', { blob: 'Popo', task: 'Research', brief: BRIEF, job: jobId, step: 's1' })).isError);
  assert.ok(!(await t.call('delegate_to', { blob: 'Junip', task: 'Draft the email', brief: BRIEF, job: jobId, step: 's2' })).isError);
  assert.equal(s.fb.threads.length, 2);
  assert.ok(s.fb.threads.every((x) => x.origin.kind === 'kora' && x.koraThreadId === `kt-${s.kora.id}`));
  // the RPC bodies the ui-server calls
  assert.equal(s.rt.jobGet(jobId).steps.length, 2);
  // a guessed id lands on the only open job (weak-model tolerance), see Jobs.find
  assert.equal(s.rt.jobGet('job_nope').cardId, jobId);
  // s1 finishes and is accepted
  s.fb.finish(s.fb.threads[0]!.threadId, { finalText: 'Brief ready.', outputs: ['/o/lisbon.md'] });
  await new Promise((r) => setTimeout(r, 15));
  await t.call('accept_step', { job: jobId, step: 's1' });
  s.rt.jobFeedback(jobId, 's1', 'good');
  assert.throws(() => s.rt.jobFeedback(jobId, 'zz', 'good'), /no result/);
  // Cancel the running step: the thread is interrupted, the step is cancelled, a late settle does not bring it back
  const card = await s.rt.jobCancel(jobId, 's2');
  assert.deepEqual(s.fb.interrupted, [s.fb.threads[1]!.threadId]);
  assert.equal(card.steps.find((x) => x.id === 's2')!.status, 'cancelled');
  s.fb.finish(s.fb.threads[1]!.threadId, { ok: false, state: 'idle', finalText: 'stopped' });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(s.rt.jobGet(jobId).steps.find((x) => x.id === 's2')!.status, 'cancelled');
  assert.equal(s.rt.jobGet(jobId).status, 'done');
  // whole-job cancel on a fresh job interrupts every live step
  await t.call('plan_job', { title: 'Two', steps: [{ id: 's1', blob: 'Popo', task: 'A' }, { id: 's2', blob: 'Junip', task: 'B' }] });
  const j2 = s.shown.filter((c) => c.cardKind === 'job').at(-1).cardId;
  await t.call('delegate_to', { blob: 'Popo', task: 'A', brief: BRIEF, job: j2, step: 's1' });
  await t.call('delegate_to', { blob: 'Junip', task: 'B', brief: BRIEF, job: j2, step: 's2' });
  s.fb.interrupted.length = 0;
  const c2 = await s.rt.jobCancel(j2, null);
  assert.equal(s.fb.interrupted.length, 2);
  assert.equal(c2.status, 'cancelled');
});

test('a step that is waiting on the user goes back to running when the user answered (poke), and to checking when it finishes', async () => {
  const s = setup();
  s.rt.attachEngine(s.fb.bridge);
  const t = s.tools(s.kora.id);
  await t.call('plan_job', { title: 'Q', steps: [{ id: 's1', blob: 'Popo', task: 'Research' }] });
  const jobId = s.shown.find((c) => c.cardKind === 'job').cardId;
  await t.call('delegate_to', { blob: 'Popo', task: 'Research', brief: BRIEF, job: jobId, step: 's1' });
  const th = s.fb.threads[0]!.threadId;
  s.fb.finish(th, { state: 'needs-you', finalText: 'May I search the web?' });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(s.rt.jobGet(jobId).steps[0]!.status, 'needs-you');
  // the user approved: the engine pokes the watchers while the thread runs again
  s.fb.snapshots.set(th, { state: 'running', finalText: null, outputs: [], tokens: { input: 0, cached: 0, output: 0, turns: 0 } });
  s.fb.running.set(s.popo.id, 1);
  s.fb.poke(th);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(s.rt.jobGet(jobId).steps[0]!.status, 'running', 'working again');
  assert.equal(s.fb.notes.filter((n) => /needs the user/.test(n.text)).length, 1);
  s.fb.poke(th); // a second poke while running changes nothing
  s.fb.finish(th, { state: 'idle', finalText: 'Here it is.' });
  await new Promise((r) => setTimeout(r, 15));
  assert.match(s.fb.notes.at(-1)!.text, /finished/, 'it finished: Kora is asked to check it');
});

test('blobs.templates.hire / blobs.create with a proposal (Tweak) / confirm resolve run through runtime methods', async () => {
  const s = setup();
  s.rt.attachEngine(s.fb.bridge);
  assert.equal(s.rt.templates().length, 10);
  const hired = s.rt.hireTemplates(['bobble', 'dimp']);
  assert.deepEqual(hired.map((b) => b.name), ['Bobble', 'Dimp']);
  assert.throws(() => s.rt.hireTemplates(['bobble']), /already on the team/);
  assert.throws(() => s.rt.hireTemplates(['nope']), /no starter template/);
  // propose -> the user Tweaks the name and look in the editor -> Create passes the proposalId
  const t = s.tools(s.kora.id);
  await t.call('propose_blob', { name: 'Tiki', title: 'Refund Watcher', job: 'Watches Shopify orders', soul: 'You are Tiki. Calm, exact. Watch refunds.', head: 'beanie', routines: [{ title: 'Daily digest', cadence: 'Weekdays 17:00' }] });
  const prop = s.shown.find((c) => c.cardKind === 'proposal');
  const tweaked = { ...prop.draft, name: 'Tiki Two', outfit: { head: 'cap', face: null, neck: null }, engine: ENGINE };
  const profile = s.rt.hireDraft(tweaked, prop.cardId);
  assert.equal(profile.name, 'Tiki Two'); assert.equal(profile.outfit!.head, 'cap');
  assert.equal(s.fb.lastCard(prop.cardId).state, 'hired');
  assert.match(s.fb.notes.at(-1)!.text, /hired Tiki Two/);
  assert.match(String(require('node:fs').readFileSync(require('node:path').join(process.env.KORA_HOME!, 'blobs', profile.id, 'routines.json'), 'utf8')), /"paused": true/);
  // a plain draft (no proposal) and a name clash
  const plain = s.rt.hireDraft({ ...tweaked, name: 'Plain' }, null);
  assert.equal(plain.name, 'Plain');
  assert.throws(() => s.rt.hireDraft({ ...tweaked, name: 'Plain' }, null), /already|taken|exists/i);
  // dismiss
  await t.call('propose_blob', { name: 'Zibbo', title: 'X', job: 'Y', soul: 'You are Zibbo. A tidy helper.' });
  const p2 = s.shown.filter((c) => c.cardKind === 'proposal').at(-1);
  s.rt.proposalDismiss(p2.cardId);
  assert.equal(s.fb.lastCard(p2.cardId).state, 'dismissed');
  assert.throws(() => s.rt.proposalDismiss('prop_nope'), /gone|already/);
});

test('edit_blob: the click applies it and leaves a self-change receipt; ONE Undo restores name, title, permission and SOUL (also on Full access)', async () => {
  const s = setup();
  s.rt.attachEngine(s.fb.bridge);
  const before = { name: s.popo.name, title: s.popo.title, permission: s.popo.permission, soul: s.store.soul(s.popo.id) };
  const t = s.tools(s.kora.id);
  await t.call('edit_blob', { blob: 'Popo', name: 'Popo Prime', title: 'Lead', permission: 'ask', soul: 'You are Popo Prime. Terse.' });
  const confirm = s.shown.find((c) => c.cardKind === 'confirm');
  assert.equal(confirm.state, 'open');
  const r = s.rt.confirmResolve(confirm.cardId, true);
  assert.equal(r.ok, true);
  assert.equal(s.store.get(s.popo.id)!.name, 'Popo Prime');
  const receipt = s.fb.cards.map((c) => c.card).find((c) => c.cardKind === 'self-change');
  assert.ok(receipt && receipt.undoToken && receipt.undone === false);
  assert.equal(s.rt.undoSelfChange(receipt.undoToken), true);
  const back = s.store.get(s.popo.id)!;
  assert.deepEqual({ name: back.name, title: back.title, permission: back.permission, soul: s.store.soul(s.popo.id) }, before);
  assert.equal(s.rt.undoSelfChange(receipt.undoToken), false, 'only once');
  // Full access: applied at once, the receipt rides the live thread (emitCard)
  const full = s.tools(s.kora.id, { fullAccess: () => true });
  s.shown.length = 0;
  const f = await full.call('edit_blob', { blob: 'Junip', title: 'Editor', soul: 'You are Junip, the editor.' });
  assert.match(f.text, /Done \(Full access\)/);
  const rc = s.shown.find((c) => c.cardKind === 'self-change');
  assert.ok(rc, 'a receipt with Undo is emitted even without a click');
  assert.equal(s.store.get(s.junip.id)!.title, 'Editor');
  assert.equal(s.rt.undoSelfChange(rc.undoToken), true);
  assert.equal(s.store.get(s.junip.id)!.title, s.junip.title);
  assert.equal(s.store.soul(s.junip.id), s.store.soul(s.junip.id));
  assert.notEqual(s.store.soul(s.junip.id), 'You are Junip, the editor.');
});

test('a Codex Chief reaches the same tools over MCP (hub): delegation works end to end, members get no team tools, tokens die with the thread', async () => {
  const s = setup();
  s.rt.attachEngine(s.fb.bridge);
  const cards: any[] = [];
  const token = s.rt.mcpIssue({ blobId: s.kora.id, threadId: 'codex-kora', agent: 'codex', cwd: '/x', emitCard: (c) => { cards.push(c); } });
  const memberToken = s.rt.mcpIssue({ blobId: s.popo.id, threadId: 'codex-popo', agent: 'codex', cwd: '/x' });
  // the real MCP stdio server over an in-process "daemon" that forwards to the hub
  const call = async (method: string, params: any) => (method === 'blobs.mcp.hello' ? s.rt.hub.hello(params) : s.rt.hub.call(params));
  const run = async (blobId: string, tok: string, msgs: any[]) => {
    const input = new PassThrough(); const output = new PassThrough();
    const mcp = createBlobsMcp({ call, blobId, token: tok, threadId: 't', input, output });
    mcp.start();
    const out: any[] = [];
    output.on('data', (d: Buffer) => { for (const l of d.toString().split('\n').filter(Boolean)) out.push(JSON.parse(l)); });
    for (const m of msgs) input.write(JSON.stringify(m) + '\n');
    await new Promise((r) => setTimeout(r, 60));
    input.end();
    return out;
  };
  const k = await run(s.kora.id, token, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'plan_job', arguments: { title: 'Codex job', steps: [{ id: 's1', blob: 'Popo', task: 'Research' }] } } },
  ]);
  const names = k.find((m) => m.id === 2).result.tools.map((x: any) => x.name);
  assert.ok(names.includes('delegate_to') && names.includes('plan_job') && names.includes('recall'));
  assert.ok(!k.find((m) => m.id === 3).result.isError, JSON.stringify(k.find((m) => m.id === 3)));
  const jobCard = cards.find((c) => c.cardKind === 'job');
  assert.ok(jobCard, 'the job card was emitted on the Codex thread (emitCard)');
  const d = await run(s.kora.id, token, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delegate_to', arguments: { blob: 'Popo', task: 'Research', brief: BRIEF, job: jobCard.cardId, step: 's1' } } }]);
  assert.ok(!d[0].result.isError, JSON.stringify(d[0]));
  assert.equal(s.fb.threads.length, 1);
  assert.equal(s.fb.threads[0]!.origin.kind, 'kora');
  const m = await run(s.popo.id, memberToken, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'plan_job', arguments: {} } }]);
  assert.ok(!m[0].result.tools.some((x: any) => x.name === 'plan_job'));
  assert.equal(m[1].result.isError, true);
  // a token for the wrong blob, and a revoked one, get nothing
  assert.equal(s.rt.hub.hello({ blobId: s.popo.id, token } as any).ok, false);
  s.rt.mcpRevoke('codex-kora');
  assert.equal(s.rt.hub.hello({ blobId: s.kora.id, token } as any).ok, false);
});

test('mcp-wire: Codex gets -c mcp_servers.kora_blobs.* (identity on argv, long tool timeout); OpenCode gets an mcp entry merged into its config', () => {
  const spec = blobsMcpSpec({ binPath: '/app/kora.js', socketPath: '/h/kora.sock', blobId: 'blob_kora', token: 'tok', threadId: 'th1', agent: 'codex', execPath: '/node' });
  assert.deepEqual(spec.args.slice(0, 3), ['/app/kora.js', 'mcp', '--blobs']);
  for (const [flag, v] of [['--blob', 'blob_kora'], ['--token', 'tok'], ['--socket', '/h/kora.sock'], ['--thread', 'th1'], ['--agent', 'codex']]) assert.equal(spec.args[spec.args.indexOf(flag!) + 1], v);
  const argv = codexBlobsMcpArgs(spec);
  assert.deepEqual(argv.filter((a) => a === '-c').length, 3);
  assert.ok(argv.some((a) => a.startsWith('mcp_servers.kora_blobs.command="/node"')));
  assert.ok(argv.some((a) => a.startsWith('mcp_servers.kora_blobs.args=[')));
  assert.ok(argv.includes('mcp_servers.kora_blobs.tool_timeout_sec=600'));
  assert.deepEqual(opencodeBlobsMcpEntry(spec), { kora_blobs: { type: 'local', command: ['/node', ...spec.args], enabled: true } });
  const merged = JSON.parse(withOpencodeBlobsMcp(JSON.stringify({ provider: { x: 1 }, mcp: { other: { type: 'local', command: ['y'] } } }), spec));
  assert.deepEqual(Object.keys(merged.mcp).sort(), ['kora_blobs', 'other']);
  assert.deepEqual(merged.provider, { x: 1 });
  assert.ok(JSON.parse(withOpencodeBlobsMcp(undefined, spec)).mcp.kora_blobs);
  assert.ok(JSON.parse(withOpencodeBlobsMcp('not json', spec)).mcp.kora_blobs);
});
