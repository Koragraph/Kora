// Live QA #2 (2026-10-09) fixes at the BlobRuntime seam: Kora's brief is not the user's words, memory.md reads with explicit
// subjects, a helper's brief carries no memory, "Always for this blob" is persisted without restarting the blob's sessions,
// and a blob's prompt never speaks swarm / worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-qa2-'));
process.env.KORA_BLOBS_ROOT = path.join(root, 'Blobs');
process.env.KORA_HOME = path.join(root, 'kora-home');

import { BlobStore } from './store';
import { BlobRuntimeImpl } from './runtime';
import { inlineMemoryHost, type ExtractorFn } from './memory-host';
import { openMemory } from '../memory';
import { userOf } from '../memory/testkit';
import { blobHome } from './home';

const ENGINE = { instanceId: 'claude', model: 'sonnet', effort: null };

function setup(script: (user: string, prompt: string) => unknown = () => ({ ops: [] })) {
  fs.rmSync(path.join(process.env.KORA_HOME!, 'blobs'), { recursive: true, force: true });
  const store = new BlobStore();
  let ext: ExtractorFn | null = null;
  const mem = openMemory({ dbPath: ':memory:', extractor: (r) => (ext ? ext(r) : Promise.reject(new Error('none'))) });
  const oneShot = async (prompt: string) => ({ text: JSON.stringify(script(userOf(prompt), prompt)), model: 'fake' });
  const rt = new BlobRuntimeImpl({ store, memory: inlineMemoryHost(mem, (fn) => { ext = fn; }), oneShot, koraCmd: 'kora', userSkillDirs: [] });
  const popo = store.create({ name: 'Popo', title: 'Researcher', soul: 'Curious.', engine: ENGINE });
  return { store, rt, mem, popo };
}
const turn = (blobId: string, threadId: string, user: string, n: number, extra: object = {}) => ({ blobId, threadId, messageIds: { user: `u${n}`, assistant: `a${n}` }, userText: user, assistantText: 'Got it, noted.', at: Date.now(), ...extra });

test('a Kora hand-off brief is indexed but never learned from; the user\'s own follow-up in that thread is', async () => {
  const { rt, mem, popo } = setup(() => ({ ops: [{ op: 'add', scope: 'you', text: 'You live in Lisbon.', confidence: 0.95 }] }));
  const brief = 'Plan three days in Lisbon for the user, who lives in Lisbon and is allergic to nuts. Write the plan to outputs/.';
  assert.deepEqual(await rt.afterTurn(turn(popo.id, 'tK', brief, 1, { brief: true })), []);
  assert.equal(mem.listFacts().length, 0);
  assert.equal(mem.listPending().length, 0);
  const r = await rt.afterTurn(turn(popo.id, 'tK', 'I live in Lisbon, by the way', 2));
  assert.equal(r.length, 1);
  assert.equal(mem.listFacts()[0]?.text, 'You live in Lisbon.');
  mem.close();
});

test('memory.md and the Core notes read with explicit subjects, even for facts written before subjects existed', async () => {
  const { rt, mem, popo } = setup();
  await mem.addFact({ scope: 'you', text: 'Lives in Dallas.', important: true });
  await mem.addFact({ scope: 'you', text: 'Prefers morning meetings.', important: true });
  await mem.addFact({ scope: 'you', text: 'Sam lives in Austin.', important: true });
  await mem.tidy();
  await rt.refreshCore(popo.id);
  const md = fs.readFileSync(path.join(blobHome(popo.id), 'memory.md'), 'utf8');
  assert.match(md, /You live in Dallas/);
  assert.match(md, /You prefer morning meetings/);
  assert.match(md, /Sam lives in Austin/);
  assert.doesNotMatch(md, /^- Lives in/m);
  assert.doesNotMatch(md, /^- Prefers/m);
  mem.close();
});

test('scrubBrief: lines a blob copied out of the user\'s memory / About me / Core notes are left out of a helper\'s brief', async () => {
  const { rt, mem, popo, store } = setup();
  await mem.addFact({ scope: 'you', text: 'Your wife Anna has a birthday on 3 March.' });
  store.setAboutMe('I run a bakery called Crumb in Lisbon.\nI am allergic to peanuts.');
  const brief = ['Find the five best flour suppliers near Lisbon with prices.', 'Context: Your wife Anna has a birthday on 3 March.', 'I run a bakery called Crumb in Lisbon.', 'Report as a table.'].join('\n');
  const out = await rt.scrubBrief(popo.id, brief);
  assert.match(out, /five best flour suppliers/);
  assert.match(out, /Report as a table/);
  assert.doesNotMatch(out, /Anna/);
  assert.doesNotMatch(out, /bakery called Crumb/);
  assert.match(out, /2 lines with personal details were left out/);
  const plain = 'Compare three standing desks: price, warranty, return window. Cite sources.';
  assert.equal(await rt.scrubBrief(popo.id, plain), plain, 'a brief with nothing personal is returned untouched');
  mem.close();
});

test('Always for this blob: the rule is saved on the profile, applies at once, and does NOT restart the blob\'s open sessions', async () => {
  const { rt, mem, popo, store } = setup();
  let prompts = 0;
  rt.onPromptChanged(() => { prompts++; });
  assert.equal(rt.alwaysAllowed(popo.id, 'Bash', { command: 'echo hi' }), false);
  assert.deepEqual(rt.approvalRuleFor('Bash', { command: 'echo hi' }), { label: 'Run echo' });
  assert.equal(rt.approvalRuleFor('Bash', { command: 'curl https://x.example' }), null);
  const rule = rt.rememberAlways(popo.id, 'Bash', { command: 'echo hi' });
  assert.equal(rule?.match, 'echo');
  assert.equal(rt.alwaysAllowed(popo.id, 'Bash', { command: 'echo something' }), true);
  assert.equal(rt.alwaysAllowed(popo.id, 'Bash', { command: 'echo a; rm -rf x' }), false);
  assert.equal(prompts, 0, 'a standing approval is not a prompt input');
  assert.equal(store.get(popo.id)!.toolGrants.approvals?.length, 1);
  // it survives a reload from disk, and a second identical answer does not duplicate it
  rt.rememberAlways(popo.id, 'Bash', { command: 'echo again' });
  const reloaded = new BlobStore();
  assert.equal(reloaded.get(popo.id)!.toolGrants.approvals?.length, 1);
  mem.close();
});

test('Free helpers are on by default (at most two at a time, fall back to doing the work); the per-blob switch removes them', () => {
  const { rt, store, mem, popo } = setup();
  assert.equal(popo.helpers, undefined, 'absent = on');
  const on = rt.systemPrompt({ blobId: popo.id, threadId: 'h1', agent: 'claude' });
  assert.match(on, /# Helpers/);
  assert.match(on, /At most two run at a time/);
  assert.match(on, /do that part\s+yourself and carry on/, 'free models down -> the blob does the work itself');
  store.update(popo.id, { helpers: false });
  assert.equal(store.get(popo.id)!.helpers, false);
  const off = rt.systemPrompt({ blobId: popo.id, threadId: 'h2', agent: 'claude' });
  assert.doesNotMatch(off, /kora_spawn|# Helpers/);
  store.update(popo.id, { helpers: true });
  assert.match(rt.systemPrompt({ blobId: popo.id, threadId: 'h3', agent: 'claude' }), /# Helpers/);
  mem.close();
});

test('a blob\'s prompt: helpers in plain words, no swarm / worker talk, behaviour rules; Codex / OpenCode blobs are not told about tools they lack', async () => {
  const { rt, mem, popo } = setup();
  const claude = rt.systemPrompt({ blobId: popo.id, threadId: 't1', agent: 'claude' });
  assert.match(claude, /# Helpers/);
  assert.match(claude, /kora_spawn/);
  assert.match(claude, /Never end a turn by promising a follow-up/);
  assert.match(claude, /Never narrate Kora's internals/);
  assert.doesNotMatch(claude, /swarm|free workers|your tokens are the user's scarce/i, 'no Code-surface vocabulary');
  for (const agent of ['codex', 'opencode'] as const) {
    const p = rt.systemPrompt({ blobId: popo.id, threadId: `t-${agent}`, agent });
    assert.doesNotMatch(p, /kora_spawn|# Helpers/, `${agent} has no helper tools`);
    assert.match(p, /Never end a turn by promising a follow-up/);
  }
  const kora = rt.ensureKora(ENGINE);
  const kp = rt.systemPrompt({ blobId: kora.id, threadId: 'tk', agent: 'claude' });
  assert.match(kp, /fits a ready-made blob the user has not hired/);
  assert.match(kp, /Mibble/);
  mem.close();
});
