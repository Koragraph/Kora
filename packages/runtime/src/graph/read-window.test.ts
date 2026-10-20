import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  chooseWindow, decideRead, expandRate, isGraphLookupCommand, newReadWindowState, noteExplore, noteInjection, parseHitLines,
  parseOutline, promptNamesFile, promptWantsWhole, renderBoundNotice, reviveReadWindowState, startTurn, toolResponseText,
  type OutlineSym, type ReadIO,
} from './read-window';

const CWD = '/repo';
const REL = 'src/big.ts';
const ABS = '/repo/src/big.ts';
// 100 handlers of 6 lines: handlerN starts at line 2 + (N-1)*6
const SYMS_TEXT = '101 symbol(s) in src/big.ts\n  src/big.ts: ' + Array.from({ length: 100 }, (_, i) => `FUNCTION handler${i + 1}:${2 + i * 6}`).join(', ') + ', FILE src/big.ts:1';
const INJ = 'Graph, for this prompt (file:line, already resolved — no need to grep):\n■ FUNCTION handler50 @ src/big.ts:296 — handler50(input)\n  callers: x@src/other.ts:3\nother matches:\n  FUNCTION handler51 @ src/big.ts:302\n(resolved from the graph)';

function io(over: Partial<ReadIO> & { lines?: number } = {}): ReadIO & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    stat: async (p) => { calls.push('stat'); return over.stat ? over.stat(p) : { lines: over.lines ?? 602, bytes: (over.lines ?? 602) * 30 }; },
    indexed: async () => { calls.push('indexed'); return over.indexed ? over.indexed() : true; },
    outline: async (r) => { calls.push('outline'); return over.outline ? over.outline(r) : SYMS_TEXT; },
    ...(over.sensitive ? { sensitive: over.sensitive } : {}),
  };
}

test('parseHitLines reads ■ hits and the ranked tail, in rank order, and ignores callers', () => {
  const m = parseHitLines(INJ);
  assert.deepEqual(m.get('src/big.ts'), [296], 'the ■ hit wins over the looser ranked tail');
  assert.deepEqual(parseHitLines('other matches:\n  FUNCTION a @ src/x.ts:5\n  FUNCTION b @ src/x.ts:9').get('src/x.ts'), [5, 9], 'tail only when there is no hit');
  assert.equal(m.has('src/other.ts'), false);
  assert.equal(parseHitLines('nothing here').size, 0);
});

test('parseOutline: structured, sorted by line, tolerant of junk', () => {
  const o = parseOutline(REL, SYMS_TEXT);
  assert.equal(o.length, 101);
  assert.deepEqual(o[0], { kind: 'FILE', name: 'src/big.ts', line: 1 });
  assert.deepEqual(o[1], { kind: 'FUNCTION', name: 'handler1', line: 2 });
  assert.deepEqual(parseOutline(REL, 'No graph nodes'), []);
  assert.deepEqual(parseOutline(REL, ''), []);
});

test('chooseWindow: injection hit gets a >=100-line window padded above, and rides a neighbour along', () => {
  const o = parseOutline(REL, SYMS_TEXT);
  const w = chooseWindow(602, o, [296], undefined)!;
  assert.equal(w.source, 'injection');
  assert.equal(w.offset, 284);
  assert.ok(w.limit >= 100 && w.limit <= 250);
  assert.ok(w.offset <= 296 && w.offset + w.limit - 1 >= 301, 'covers the whole declaration');
  // a second hit close by widens the window within the cap
  const w2 = chooseWindow(602, o, [296, 350], undefined)!;
  assert.ok(w2.offset <= 296 && w2.offset + w2.limit - 1 >= 355);
  assert.ok(w2.limit <= 250);
  // a second hit too far away is left out
  const w3 = chooseWindow(602, o, [296, 560], undefined)!;
  assert.ok(w3.offset + w3.limit - 1 < 560);
});

test('chooseWindow: explore hits are the second choice, lines 1..250 the last; a window near the file size is not worth it', () => {
  const o = parseOutline(REL, SYMS_TEXT);
  assert.equal(chooseWindow(602, o, undefined, [100])!.source, 'explore');
  assert.equal(chooseWindow(602, o, [], [])!.source, 'head');
  assert.deepEqual(chooseWindow(602, o, undefined, undefined), { offset: 1, limit: 250, source: 'head' });
  // 320 lines: a 250-line head window covers 78% -> no gain, read whole
  assert.equal(chooseWindow(320, [], undefined, undefined), null);
  // a hit near the end of the file still gets a full 100-line window
  const end = chooseWindow(602, o, [600], undefined)!;
  assert.equal(end.offset + end.limit - 1, 602);
  assert.ok(end.limit >= 100);
});

test('renderBoundNotice: states the window, shows an outline, stays small', () => {
  const o = parseOutline(REL, SYMS_TEXT);
  const t = renderBoundNotice(REL, { offset: 284, limit: 120 }, 602, o);
  assert.match(t, /lines 284-403 of 602 in src\/big\.ts/);
  assert.match(t, /Read it again for the whole file/);
  assert.match(t, /Outline \(name:line, \d+ of 100\)/);
  assert.match(t, /handler1:2/);
  assert.ok(t.length < 760, `notice is ${t.length} chars`);
  // an even sample reaches the end of the file, not just the first symbols
  const lines = [...t.matchAll(/handler(\d+):(\d+)/g)].map((m) => parseInt(m[2]!, 10));
  assert.ok(lines[lines.length - 1]! > 500, `outline spans the file: last ${lines[lines.length - 1]}`);
  const few = renderBoundNotice(REL, { offset: 1, limit: 250 }, 602, o.slice(0, 6));
  assert.doesNotMatch(few, /of \d+\)/); assert.match(few, /handler5:/);
});

test('decideRead: bounds a whole-file Read of a long indexed code file, with offset/limit + outline', async () => {
  const s = newReadWindowState(); startTurn(s, 'how does handler50 behave'); noteInjection(s, INJ);
  const r = await decideRead(s, { file_path: ABS }, CWD, io());
  assert.ok(r.bound);
  assert.equal(r.bound!.updatedInput.file_path, ABS);
  assert.equal(r.bound!.updatedInput.offset, 284);
  assert.ok((r.bound!.updatedInput.limit as number) >= 100);
  assert.equal(r.bound!.record.source, 'injection');
  assert.ok(r.bound!.avoidedTokens > 1000);
  assert.match(r.bound!.additionalContext, /bounded to lines 284-/);
  assert.equal(s.counts.bounded, 1);
});

test('decideRead: the second Read of the same path passes through whole (fail open)', async () => {
  const s = newReadWindowState(); startTurn(s, 'look at handler50');
  const a = await decideRead(s, { file_path: ABS }, CWD, io());
  assert.ok(a.bound);
  const b = await decideRead(s, { file_path: ABS }, CWD, io());
  assert.equal(b.bound, null); assert.equal(b.skip, 'seen');
});

test('decideRead: a path already Read with a model-issued range, or Edited, is left alone', async () => {
  const s = newReadWindowState(); startTurn(s, 'x');
  assert.equal((await decideRead(s, { file_path: ABS, offset: 10, limit: 20 }, CWD, io())).skip, 'has-range');
  assert.equal((await decideRead(s, { file_path: ABS }, CWD, io())).skip, 'seen');
});

test('decideRead: skip rules - prompt names the file, wants the whole thing, small file, non-code, outside the repo, not indexed, sensitive', async () => {
  const run = async (prompt: string, input: Record<string, unknown>, o: ReturnType<typeof io>) => { const s = newReadWindowState(); startTurn(s, prompt); return decideRead(s, input, CWD, o); };
  assert.equal((await run('fix the bug in big.ts please', { file_path: ABS }, io())).skip, 'prompt-names-file');
  assert.equal((await run('look at src/big.ts', { file_path: ABS }, io())).skip, 'prompt-names-file');
  assert.equal((await run('show me the whole file', { file_path: ABS }, io())).skip, 'prompt-wants-whole');
  assert.equal((await run('read the ENTIRE thing', { file_path: ABS }, io())).skip, 'prompt-wants-whole');
  assert.equal((await run('x', { file_path: ABS }, io({ lines: 300 }))).skip, 'small');
  assert.equal((await run('x', { file_path: '/repo/README.md' }, io())).skip, 'not-code');
  assert.equal((await run('x', { file_path: '/elsewhere/a.ts' }, io())).skip, 'outside-repo');
  assert.equal((await run('x', { file_path: '/repo/../etc/a.ts' }, io())).skip, 'outside-repo');
  assert.equal((await run('x', { file_path: ABS }, io({ indexed: async () => false }))).skip, 'not-indexed');
  assert.equal((await run('x', { file_path: ABS }, io({ sensitive: () => true }))).skip, 'sensitive');
  assert.equal((await run('x', { file_path: ABS }, io({ stat: async () => null }))).skip, 'unreadable');
  assert.equal((await run('x', { file_path: ABS }, io({ lines: 330 }))).skip, 'no-gain');
});

test('decideRead: cheap checks run before any I/O', async () => {
  const s = newReadWindowState(); startTurn(s, 'x');
  const o = io();
  await decideRead(s, { file_path: '/repo/notes.md' }, CWD, o);
  await decideRead(s, { file_path: ABS, limit: 5 }, CWD, o);
  assert.deepEqual(o.calls, []);
});

test('decideRead: any I/O failure is a pass-through, never a throw', async () => {
  const s = newReadWindowState(); startTurn(s, 'x');
  const r = await decideRead(s, { file_path: ABS }, CWD, io({ stat: async () => { throw new Error('boom'); } }));
  assert.equal(r.bound, null); assert.equal(r.skip, 'error');
  // a broken outline only loses the outline: the head window still applies
  const s2 = newReadWindowState(); startTurn(s2, 'x');
  const r2 = await decideRead(s2, { file_path: ABS }, CWD, io({ outline: async () => { throw new Error('graph down'); } }));
  assert.ok(r2.bound); assert.equal(r2.bound!.record.source, 'head');
});

test('decideRead: shadow mode rewrites nothing but says what it would have saved', async () => {
  const s = newReadWindowState(); startTurn(s, 'x');
  const r = await decideRead(s, { file_path: ABS }, CWD, io(), { mode: 'shadow' });
  assert.equal(r.bound, null);
  assert.ok(r.shadowRecord && r.shadowRecord.avoidedTokens > 1000);
  assert.equal(s.counts.shadow, 1); assert.equal(s.counts.bounded, 0);
  // and the file still counts as seen: the agent's real (whole) Read is not double counted
  assert.equal((await decideRead(s, { file_path: ABS }, CWD, io(), { mode: 'shadow' })).skip, 'seen');
});

test('expand: a follow-up Read of a bounded path within 3 turns counts once; a range inside the window does not', async () => {
  const s = newReadWindowState(); startTurn(s, 'x');
  const a = await decideRead(s, { file_path: ABS }, CWD, io());
  const w = a.bound!.record;
  const inside = await decideRead(s, { file_path: ABS, offset: w.offset + 1, limit: 5 }, CWD, io());
  assert.equal(inside.expanded, undefined);
  startTurn(s, 'more'); startTurn(s, 'more2');
  const b = await decideRead(s, { file_path: ABS }, CWD, io());
  assert.equal(b.expanded?.path, path.resolve(ABS)); assert.equal(expandRate(s), 1);
  const c = await decideRead(s, { file_path: ABS }, CWD, io());
  assert.equal(c.expanded, undefined, 'counted once');
  // too late
  const s2 = newReadWindowState(); startTurn(s2, 'x');
  await decideRead(s2, { file_path: ABS }, CWD, io());
  for (let i = 0; i < 4; i++) startTurn(s2, 'later');
  // late: still an expand for the ledger (the agent paid for the file after all, audit 2026-10-15 #4), but not the
  // within-3-turns quality signal
  assert.ok((await decideRead(s2, { file_path: ABS, offset: 1, limit: 600 }, CWD, io())).expanded);
  assert.equal(expandRate(s2), 0);
  assert.equal(expandRate(newReadWindowState()), null);
});

test('hints: this turn\'s injection replaces last turn\'s; explore hits are newest first', () => {
  const s = newReadWindowState(); startTurn(s, 'a'); noteInjection(s, INJ);
  assert.deepEqual(s.hints[REL]!.inj, [296]);
  startTurn(s, 'b');
  assert.equal(s.hints[REL]!.inj, undefined);
  noteExplore(s, '■ FUNCTION a @ src/big.ts:10 — a()'); noteExplore(s, '■ FUNCTION b @ src/big.ts:400 — b()');
  assert.deepEqual(s.hints[REL]!.exp, [400, 10]);
});

test('prompt rules', () => {
  assert.ok(promptWantsWhole('Please read the full file'));
  assert.ok(!promptWantsWhole('how does the pull-based model work'));
  assert.ok(promptNamesFile('what is in claude-driver.ts', '/repo/src/claude-driver.ts', CWD));
  assert.ok(!promptNamesFile('how does the driver work', '/repo/src/claude-driver.ts', CWD));
  assert.ok(!promptNamesFile('', '/repo/src/claude-driver.ts', CWD));
});

test('graph lookup command + tool response text helpers', () => {
  assert.ok(isGraphLookupCommand('kora graph explore "foo"'));
  assert.ok(isGraphLookupCommand('node "/Users/x/.kora/app/bin/kora.js" graph search_code foo'));
  assert.ok(!isGraphLookupCommand('kora graph blast_radius --file a.ts'));
  assert.ok(!isGraphLookupCommand(undefined));
  assert.equal(toolResponseText({ stdout: 'out', stderr: '' }), 'out');
  assert.equal(toolResponseText('plain'), 'plain');
  assert.equal(toolResponseText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(toolResponseText(null), '');
});

test('reviveReadWindowState survives garbage', () => {
  assert.deepEqual(reviveReadWindowState(null), newReadWindowState());
  assert.deepEqual(reviveReadWindowState('x'), newReadWindowState());
  const s = reviveReadWindowState({ turn: 4, prompt: 'p', seen: ['/a', 3], hints: { 'a.ts': { inj: [1, 'x', 5] }, bad: 3 }, bounded: [{ path: '/a', turn: 1, offset: 1, limit: 2, total: 3 }, { nope: 1 }], counts: { bounded: 2, skipped: { seen: 1 } } });
  assert.equal(s.turn, 4); assert.deepEqual(s.seen, ['/a']); assert.deepEqual(s.hints['a.ts']!.inj, [1, 5]);
  assert.equal(s.bounded.length, 1); assert.equal(s.counts.bounded, 2); assert.equal(s.counts.skipped.seen, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test('OutlineSym shape is stable', () => {
  const o: OutlineSym[] = parseOutline(REL, SYMS_TEXT);
  assert.ok(o.every((x) => typeof x.kind === 'string' && typeof x.name === 'string' && Number.isInteger(x.line)));
});
