import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noteTouchedFromEvents, carryFile, isDeicticFollowUp, loadCarry, markOutlined, noteEntities, noteInjectedText, tickCarry } from './inject-carry';
import { editProseQualifies, injectForPrompt, lastInjectRecord } from './prompt-inject';

const sid = (x: string) => `carry-${x}-${process.pid}-${Date.now()}`;

test('editProseQualifies: edit-shaped task prompts with no identifier; not chatter, questions-only, statements or text hunts', () => {
  for (const p of [
    'make the window size a little bigger when the hit is a class',
    'add a cooldown so the swarm catalog does not refresh so often',
    'ok now make the stop button red when it is disabled',
    'the lock holder check should also log who holds it',
  ]) assert.ok(editProseQualifies(p), p);
  for (const p of [
    'thanks that looks good', 'add a test', 'what do you think about the pricing page copy', 'lets talk about onboarding for a bit',
    'rename every occurrence of the old flag in the docs', 'we never use sessions here, always add tokens to the header please', '/compact the context now please',
    'x'.repeat(320),
  ]) assert.ok(!editProseQualifies(p), p);
});

test('isDeicticFollowUp: points at something in hand; "it" alone does not count', () => {
  for (const p of ['why is that file so slow to start', 'add a test for it please', 'ok now make that function return the pid too', 'rename the helper in the same file']) assert.ok(isDeicticFollowUp(p), p);
  for (const p of ['do it', 'thanks', 'i think it is fine', 'what is the weather like today', '/foo that file here', 'that file']) assert.ok(!isDeicticFollowUp(p), p);
});

test('carry memory: newest touched file within the age window; an outline is not repeated; old entries expire', () => {
  const s = sid('mem');
  tickCarry(s);                                          // turn 1
  noteEntities(s, { files: ['./src/a.ts', 'src/b.ts'], symbols: [{ name: 'foo', file: 'src/c.ts' }] });
  tickCarry(s);                                          // turn 2
  let st = loadCarry(s);
  assert.equal(carryFile(st, 'why is that file so slow'), 'src/c.ts', 'the newest mention wins (symbols note their file)');
  assert.equal(carryFile(st, 'tell me a story about the weather'), null, 'not deictic');
  markOutlined(s, 'src/c.ts');
  st = loadCarry(s);
  assert.equal(carryFile(st, 'why is that file so slow'), null, 'the newest file was outlined a moment ago: "that file" is in context already');
  for (let i = 0; i < 6; i++) tickCarry(s);
  assert.equal(carryFile(loadCarry(s), 'why is that file so slow'), null, 'stale after CARRY_MAX_AGE_TURNS prompts');
  noteEntities(s, { files: ['../escape.ts', '/abs/x.ts'] });
  assert.ok(!loadCarry(s).files.some((f) => f.rel.startsWith('..') || f.rel.startsWith('/')), 'only repo-relative paths');
  assert.deepEqual(loadCarry(sid('none')).files, [], 'a session with no state is empty');
});

test('noteInjectedText reads ■ declarations and file outlines out of an injection', () => {
  const s = sid('inj');
  noteInjectedText(s, 'Graph, for this prompt:\n■ METHOD lockHolder @ src/graph/lock.ts:12 — lockHolder(root)\nFile src/graph/offload.ts — declarations (name:line): a:1, b:2\n');
  const st = loadCarry(s);
  assert.deepEqual(st.symbols.map((y) => [y.name, y.file]), [['lockHolder', 'src/graph/lock.ts']]);
  assert.deepEqual(st.files.map((f) => f.rel), ['src/graph/offload.ts']);
  noteInjectedText(null, 'x'); noteInjectedText(s, null);   // no throw
});

function withFuzzy(symbols: { name: string; parts: string[] }[], fn: () => Promise<void>) {
  const fz = require('./fuzzy'); const orig = fz.fuzzyForPrompt; fz.fuzzyForPrompt = (p: string) => fz.fuzzyFind(fz.fuzzyWords(p), symbols);
  return fn().finally(() => { fz.fuzzyForPrompt = orig; });
}

test('edit prose: a strong fuzzy match is injected lean (declaration, no body); a weak or absent match is not; recall off restores the old skip', async () => {
  process.env.KORA_INJECT_LOG = '0';
  const decl = '1 match.\n\n■ METHOD refreshSwarmCatalog @ src/swarm-catalog.ts:152 — refreshSwarmCatalog(opts)\n  --- source src/swarm-catalog.ts:152-160 ---\n  async function refreshSwarmCatalog() {}\n';
  const graph: any = { status: async () => ({ indexed: true, repoRoot: '/nope' }), callTool: async (_n: string, a: any) => ({ text: a.query === 'refreshSwarmCatalog' ? decl : 'NO DECLARATION NAMED x' }) };
  const symbols = [{ name: 'refreshSwarmCatalog', parts: ['refresh', 'swarm', 'catalog'] }, { name: 'orderBySupply', parts: ['order', 'supply'] }];
  await withFuzzy(symbols, async () => {
    const s1 = sid('edit');
    const out = await injectForPrompt({ prompt: 'add a cooldown so the swarm catalog does not refresh so often', cwd: '/nope', sessionId: s1, graph, fileHints: false });
    assert.ok(out && out.includes('■ METHOD refreshSwarmCatalog'), String(out));
    assert.ok(!out!.includes('async function'), 'edit prompts get the declaration only, no body');
    assert.equal(lastInjectRecord!.via, 'edit-prose');
    const weak = await injectForPrompt({ prompt: 'make the supply list look nicer when it is long', cwd: '/nope', sessionId: sid('weak'), graph, fileHints: false });
    assert.equal(weak, null, 'one weak word is not enough evidence for an edit prompt');
    const none = await injectForPrompt({ prompt: 'make the onboarding screen feel friendlier for new people', cwd: '/nope', sessionId: sid('none'), graph, fileHints: false });
    assert.equal(none, null);
    process.env.KORA_INJECT_RECALL = '0';
    try {
      const off = await injectForPrompt({ prompt: 'add a cooldown so the swarm catalog does not refresh so often', cwd: '/nope', sessionId: sid('off'), graph, fileHints: false });
      assert.equal(off, null, 'KORA_INJECT_RECALL=0: the old not-code-shaped skip');
      assert.equal(lastInjectRecord!.reason, 'not-code-shaped');
    } finally { delete process.env.KORA_INJECT_RECALL; }
  });
});

test('deictic follow-up: the recently touched file gets its outline once; a prompt with its own identifier or no recent file gets nothing extra', async () => {
  process.env.KORA_INJECT_LOG = '0';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-carry-')); fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src', 'pool.ts'), 'x');
  const calls: string[] = [];
  const graph: any = {
    status: async () => ({ indexed: true, repoRoot: root }),
    callTool: async (n: string, a: any) => { calls.push(n); return n === 'file_symbols' ? { text: '2 symbol(s) in src/pool.ts\n  src/pool.ts: FUNCTION start:3, FUNCTION stop:20' } : { text: 'NO DECLARATION NAMED x' }; },
  };
  const s = sid('deictic');
  noteEntities(s, { files: ['src/pool.ts'] });
  const out = await injectForPrompt({ prompt: 'why is that file so slow to start', cwd: root, sessionId: s, graph });
  assert.ok(out && /File src\/pool\.ts — declarations/.test(out), String(out));
  assert.equal(lastInjectRecord!.via, 'carry-file');
  const again = await injectForPrompt({ prompt: 'and what about the shutdown in that file', cwd: root, sessionId: s, graph });
  assert.equal(again, null, 'already outlined a moment ago: it is in context');
  const cold = await injectForPrompt({ prompt: 'why is that file so slow to start', cwd: root, sessionId: sid('cold'), graph });
  assert.equal(cold, null, 'nothing recent to point at');
});

test('noteTouchedFromEvents: changed files and opened files inside cwd become repo-relative entities; outside paths are dropped', () => {
  const s = sid('events');
  noteTouchedFromEvents(s, '/repo', [
    { type: 'tool.result', itemId: 'a', status: 'completed', changedFiles: [{ path: '/repo/src/x.ts' }, { path: '/etc/passwd' }] },
    { type: 'tool.started', itemId: 'b', toolKind: 'file_read', toolName: 'view_file', input: { AbsolutePath: '/repo/src/y.ts' } },
    { type: 'tool.started', itemId: 'c', toolKind: 'command_execution', input: { path: '/repo/src/z.ts' } },
    { type: 'content.delta' },
  ]);
  assert.deepEqual(loadCarry(s).files.map((f) => f.rel).sort(), ['src/x.ts', 'src/y.ts']);
  noteTouchedFromEvents(null, '/repo', []); noteTouchedFromEvents(s, '/repo', undefined as any);
});
