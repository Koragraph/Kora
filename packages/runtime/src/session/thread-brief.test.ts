import { test } from 'node:test';
import assert from 'node:assert';
import { digestTranscript, renderDigest, draftBrief, readTail, BRIEF_SYSTEM } from './thread-brief';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sideQuery, sideSessionOptions } from './side-session';
import { thread } from './prune.fixture';

const transcript = thread(12).map((e) => JSON.stringify(e)).join('\n') + '\n';

test('digest: every request, the closing words, the files changed and what failed - without the file bodies', () => {
  const d = digestTranscript(transcript);
  assert.equal(d.turns, 12);
  assert.equal(d.prompts[0], 'turn 1: look at src/f1.ts');
  assert.equal(d.filesChanged.length, 12);
  assert.ok(d.filesChanged.includes('/repo/src/f3.ts'));
  assert.ok(d.failures.some((f) => f.includes('`false`')));
  const text = renderDigest(d);
  assert.ok(text.length < 4000, `digest is small (${text.length} chars)`);
  assert.ok(!text.includes('xxxxxxxx'), 'no tool output in the digest');
});

test('side session options: no tools, no settings, no MCP, nothing saved, one turn, Haiku', () => {
  const o = sideSessionOptions({ system: 's', prompt: 'p' }, new AbortController()) as any;
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(o.mcpServers, {});
  assert.equal(o.persistSession, false);
  assert.equal(o.maxTurns, 1);
  assert.deepEqual(o.thinking, { type: 'disabled' });
  assert.equal((o.env as any).MAX_THINKING_TOKENS, '0');
  assert.equal(o.model, 'claude-haiku-5-5');
  assert.equal(o.systemPrompt, 's');
});

async function* fake(...msgs: any[]) { for (const m of msgs) yield m; }

test('sideQuery returns the reply text; errors and empty replies are null; never throws', async () => {
  const ok = await sideQuery({ system: 's', prompt: 'p', queryFn: () => fake({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }, { type: 'result', subtype: 'success', is_error: false, result: 'hello' }) });
  assert.equal(ok, 'hello');
  assert.equal(await sideQuery({ system: 's', prompt: 'p', queryFn: () => fake({ type: 'result', is_error: true, result: 'boom' }) }), null);
  assert.equal(await sideQuery({ system: 's', prompt: 'p', queryFn: () => { throw new Error('no sdk'); } }), null);
  assert.equal(await sideQuery({ system: 's', prompt: 'p', timeoutMs: 20, queryFn: () => (async function* () { await new Promise((r) => setTimeout(r, 200)); yield { type: 'result', result: 'late' }; })() }), 'late');
});

test('draftBrief: the side session gets the digest only; its reply is the brief; a failure falls back to the digest', async () => {
  let seen = '';
  const good = await draftBrief({ transcript, queryFn: ({ prompt, options }) => { seen = prompt + '|' + (options as any).systemPrompt; return fake({ type: 'result', is_error: false, result: 'Goal: ship it.\nFiles: a.ts\nDecisions: none\nNext step: test.' }); } });
  assert.equal(good.source, 'side-session');
  assert.match(good.brief, /^Goal:/);
  assert.ok(seen.includes('turn 1: look at src/f1.ts') && seen.includes(BRIEF_SYSTEM));
  assert.ok(seen.length < 8000, 'the side session sees a digest, not the 300 kB transcript');
  const bad = await draftBrief({ transcript, queryFn: () => { throw new Error('offline'); } });
  assert.equal(bad.source, 'digest');
  assert.match(bad.brief, /Context from an earlier thread/);
  const rambling = await draftBrief({ transcript, queryFn: () => fake({ type: 'result', is_error: false, result: 'word '.repeat(600) }) });
  assert.equal(rambling.source, 'digest', 'an over-long reply is not used');
});

test('S6: a huge transcript is read from its tail only, cut at a line start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-tail-'));
  try {
    const f = path.join(dir, 't.jsonl');
    const lines = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(100) }));
    fs.writeFileSync(f, lines.join('\n') + '\n');
    const tail = await readTail(f, 10_000);
    assert.ok(tail.length <= 10_000);
    for (const l of tail.split('\n').filter(Boolean)) JSON.parse(l); // no cut line survives
    assert.ok(tail.includes('"i":1999'));
    assert.equal(await readTail(f, 10_000_000), lines.join('\n') + '\n', 'a small file is read whole');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
