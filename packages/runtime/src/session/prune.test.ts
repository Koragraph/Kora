import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUPERSEDED_FORK_KEEP_MS, forgetFork, sweepForks, sweepStaleForkTmp, pruneEntries, pruneText, forkPrunedSync, forkPrunedInChild, prepareColdResume, locateTranscript, claudeSlug, stubText, maskNote, type Entry } from './prune';

import { SID, thread, prompt, asst, use, result, big } from './prune.fixture';

const resultBlock = (e: Entry): any => e.message.content[0];

test('prune: old bulk results become one-line stubs; recent turns, edits, errors and structure stay', () => {
  const src = thread(14);
  const { entries, report } = pruneEntries(src, { keepTurns: 10 });
  assert.equal(entries.length, src.length, 'same number of entries - the parent chain is untouched');
  assert.equal(report.turns, 14);
  // turns 1-4 are old: 4 Reads + 4 Bash stubbed
  assert.equal(report.stubbed, 8);
  assert.deepEqual(report.byTool, { Read: 4, Bash: 4 });
  const stubs = entries.filter((e) => e.type === 'user' && typeof resultBlock(e)?.content === 'string' && resultBlock(e).content.startsWith('[Kora:'));
  assert.equal(stubs.length, 8);
  assert.match(resultBlock(stubs[0]!).content, /^\[Kora: Read of \/repo\/src\/f1\.ts, about [\d,]+ tokens, elided on resume/);
  assert.match(resultBlock(stubs[1]!).content, /^\[Kora: Bash `npm test -- f1`/);
  assert.equal(resultBlock(stubs[0]!).tool_use_id, 'r1', 'tool_use ids are kept');
  assert.equal(stubs[0]!.toolUseResult, undefined, 'the UI copy of an elided result is dropped');
  // edits and failures from the OLD turns are kept whole
  const old = entries.slice(0, entries.findIndex((e) => e.type === 'user' && e.message?.content === 'turn 5: look at src/f5.ts'));
  assert.ok(old.some((e) => e.type === 'user' && resultBlock(e)?.tool_use_id === 'e1' && resultBlock(e).content.includes('has been updated')));
  assert.ok(old.some((e) => e.type === 'user' && resultBlock(e)?.tool_use_id === 'x1' && resultBlock(e).is_error === true && resultBlock(e).content.includes('stack trace')));
  // the last 10 turns are the same objects
  const idx = src.findIndex((e) => e.message?.content === 'turn 5: look at src/f5.ts');
  for (let i = idx; i < src.length; i++) assert.strictEqual(entries[i], src[i]);
  // assistant messages (thinking blocks are signed) are never touched
  src.forEach((e, i) => { if (e.type === 'assistant') assert.strictEqual(entries[i], e); });
  assert.ok(report.tokensSaved > 5000 && report.tokensSaved < report.contextBefore);
});

test('prune: nothing to do when the thread has no more than keepTurns prompts', () => {
  const src = thread(10);
  const { entries, report } = pruneEntries(src, { keepTurns: 10 });
  assert.equal(report.stubbed, 0);
  assert.strictEqual(entries, src);
});

test('prune: a file the recent turns name keeps its old Read; small results and non-bulk tools are kept', () => {
  const src = thread(14);
  // recent prompt names f2.ts: its old Read stays
  src.push(prompt('and src/f2.ts again, what did it look like?'));
  const r = pruneEntries(src, { keepTurns: 10 });
  assert.equal(r.report.kept.referenced, 1);
  assert.equal(r.report.byTool.Read, 4);
  // small result, an AskUserQuestion answer and a fleet report are not stubbed
  const mix: Entry[] = [prompt('start')];
  mix.push(asst([use('s1', 'Read', { file_path: '/repo/small.ts' })]), result('s1', 'tiny'));
  mix.push(asst([use('q1', 'AskUserQuestion', {})]), result('q1', big('User has answered', 3000)));
  mix.push(asst([use('k1', 'mcp__kora__kora_wait', {})]), result('k1', big('worker report', 3000)));
  mix.push(asst([use('g1', 'mcp__kora__explore', { query: 'foo' })]), result('g1', big('graph hits', 3000)));
  for (let t = 0; t < 3; t++) mix.push(prompt(`later ${t}`), asst([{ type: 'text', text: 'ok' }]));
  const m = pruneEntries(mix, { keepTurns: 2 });
  assert.equal(m.report.stubbed, 1, 'only the graph read');
  assert.equal(m.report.byTool['mcp__kora__explore'], 1);
  assert.equal(m.report.kept.small, 1);
  assert.equal(m.report.kept.other, 2);
});

test('prune: images in an old tool result are stubbed too', () => {
  const t: Entry[] = [prompt('shot')];
  t.push(asst([use('i1', 'mcp__Claude_Browser__computer', { action: 'screenshot' })]));
  t.push(result('i1', [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(90000) } }, { type: 'text', text: 'ok' }]));
  for (let k = 0; k < 4; k++) t.push(prompt(`p${k}`), asst([{ type: 'text', text: 'ok' }]));
  const r = pruneEntries(t, { keepTurns: 2 });
  assert.equal(r.report.stubbed, 1);
  assert.ok(r.report.tokensSaved >= 1400);
});

test('prune: only entries after the last compaction count', () => {
  const t = thread(14);
  const boundary = t.findIndex((e) => e.message?.content === 'turn 9: look at src/f9.ts');
  t.splice(boundary, 0, { type: 'user', isCompactSummary: true, sessionId: SID, message: { role: "user", content: "summary of everything before" } });
  const r = pruneEntries(t, { keepTurns: 3 });
  // after the summary: turns 9-14 (6 prompts) -> turns 9-11 are old
  assert.equal(r.report.turns, 6);
  assert.equal(r.report.stubbed, 6);
});

test('pruneText: bad lines survive, sessionId is retagged, line count is kept', () => {
  const text = thread(14).map((e) => JSON.stringify(e)).join('\n').replace('\n', '\nnot json at all\n') + '\n';
  const r = pruneText(text, { keepTurns: 10, sessionId: 'new-session-id-0001' });
  const lines = r.text.split('\n'); lines.pop();
  assert.equal(lines.length, text.split('\n').length - 1);
  assert.ok(lines.includes('not json at all'));
  for (const l of lines) { if (l === 'not json at all') continue; const j = JSON.parse(l); if (j.sessionId) assert.equal(j.sessionId, 'new-session-id-0001'); }
  assert.ok(r.text.length < text.length * 0.9);
});

function scratch(): { dir: string; home: string; cfg: string; cwd: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-prune-'));
  const cfg = path.join(dir, 'claude'); const home = path.join(dir, 'home'); const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  const pdir = path.join(cfg, 'projects', claudeSlug(cwd)); fs.mkdirSync(pdir, { recursive: true });
  const file = path.join(pdir, `${SID}.jsonl`);
  fs.writeFileSync(file, thread(14).map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { dir, home, cfg, cwd, file };
}

test('forkPrunedSync writes a NEW session file beside the original and leaves the original byte-identical', () => {
  const s = scratch();
  const before = fs.readFileSync(s.file, 'utf8');
  const r = forkPrunedSync({ src: s.file, sessionId: SID, opts: { keepTurns: 10 } });
  assert.ok(r.forked);
  if (!r.forked) return;
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
  assert.equal(path.dirname(r.file), path.dirname(s.file));
  assert.equal(path.basename(r.file), `${r.sessionId}.jsonl`);
  assert.ok(r.bytesAfter < r.bytesBefore);
  for (const l of fs.readFileSync(r.file, 'utf8').trim().split('\n')) { const j = JSON.parse(l); if (j.sessionId) assert.equal(j.sessionId, r.sessionId); }
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('forkPrunedSync: too little to trim writes nothing', () => {
  const s = scratch();
  const r = forkPrunedSync({ src: s.file, sessionId: SID, opts: { keepTurns: 50 } });
  assert.equal(r.forked, false);
  assert.equal(fs.readdirSync(path.dirname(s.file)).length, 1);
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('prepareColdResume: a warm cache is left alone; a cold one forks; the next cold resume replaces the fork (original kept)', async () => {
  const s = scratch();
  const common = { cwd: s.cwd, configDir: s.cfg, home: s.home, keepTurns: 10, inProcess: true } as const;
  const now = fs.statSync(s.file).mtimeMs;
  const warm = await prepareColdResume({ ...common, sessionId: SID, now: now + 30 * 60_000 });
  assert.deepEqual(warm, { masked: false, reason: 'cache still warm' });

  const cold = await prepareColdResume({ ...common, sessionId: SID, now: now + 90 * 60_000 });
  assert.ok(cold.masked);
  if (!cold.masked) return;
  assert.equal(cold.originalId, SID);
  assert.equal(cold.stubbed, 8);
  assert.ok(fs.existsSync(s.file), "the user's own transcript stays");
  assert.ok(locateTranscript(cold.sessionId, s.cwd, s.cfg));
  assert.match(maskNote(cold), /^Trimmed 8 old tool outputs on resume \(about \d+k of \d+k tokens\)/);

  // idle again: the fork (Kora's own) is replaced by a newer one; the original still stays
  const forkFile = locateTranscript(cold.sessionId, s.cwd, s.cfg)!;
  fs.appendFileSync(forkFile, JSON.stringify(thread(14).slice(-3)[0]) + '\n'); // not needed to prune further; new fork only if enough to trim
  const again = await prepareColdResume({ ...common, sessionId: cold.sessionId, now: Date.now() + 5 * 3600_000, keepTurns: 2 });
  assert.ok(again.masked);
  if (!again.masked) return;
  assert.equal(again.originalId, SID);
  assert.equal(fs.existsSync(forkFile), true, 'the previous fork is KEPT for a day: the thread may still point at it if the new session fails to start');
  assert.ok(fs.existsSync(s.file));
  sweepForks(s.home, Date.now() + 5 * 3600_000 + SUPERSEDED_FORK_KEEP_MS + 60_000);
  assert.equal(fs.existsSync(forkFile), false, 'and swept after that');
  assert.ok(fs.existsSync(s.file), 'the original is never swept');
  assert.equal(forgetFork(again.sessionId, s.home), true, 'a deleted thread takes its fork with it');
  assert.equal(locateTranscript(again.sessionId, s.cwd, s.cfg), null);
  assert.equal(forgetFork(SID, s.home), false, 'an original is not a Kora-made fork: untouched');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('prepareColdResume fails open: missing transcript, bad id, unreadable file', async () => {
  const s = scratch();
  assert.equal((await prepareColdResume({ sessionId: 'nope-nope-nope', cwd: s.cwd, configDir: s.cfg, home: s.home })).masked, false);
  assert.equal((await prepareColdResume({ sessionId: '../../etc/passwd', cwd: s.cwd, configDir: s.cfg, home: s.home })).masked, false);
  fs.writeFileSync(s.file, '{"type":"user", broken\n'.repeat(5));
  const r = await prepareColdResume({ sessionId: SID, cwd: s.cwd, configDir: s.cfg, home: s.home, now: Date.now() + 5 * 3600_000, inProcess: true });
  assert.equal(r.masked, false);
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('the child-process path produces the same result as the in-process one', async () => {
  const s = scratch();
  const a = forkPrunedSync({ src: s.file, sessionId: SID, opts: { keepTurns: 10 } });
  const b = await forkPrunedInChild({ src: s.file, sessionId: SID, opts: { keepTurns: 10 } });
  assert.ok(a.forked && b.forked);
  if (a.forked && b.forked) { assert.equal(a.bytesAfter, b.bytesAfter); assert.deepEqual(a.report, b.report); }
  await assert.rejects(forkPrunedInChild({ src: path.join(s.dir, 'missing.jsonl'), sessionId: SID }));
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('stubText is one short line', () => {
  const s = stubText('Read', { file_path: '/a/b.ts' }, 4210);
  assert.equal(s, '[Kora: Read of /a/b.ts, about 4,210 tokens, elided on resume to save tokens. Your earlier notes on it still stand; run it again only if you need the exact output]');
});

test('sweepStaleForkTmp removes only old fork temp files', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-ftmp-'));
  const old = path.join(d, '11111111-2222-3333-4444-555555555555.jsonl.tmp-123'); const fresh = path.join(d, '11111111-2222-3333-4444-555555555556.jsonl.tmp-124'); const real = path.join(d, '11111111-2222-3333-4444-555555555557.jsonl');
  for (const f of [old, fresh, real]) fs.writeFileSync(f, 'x');
  fs.utimesSync(old, 1, 1);
  assert.equal(sweepStaleForkTmp(d), 1);
  assert.ok(!fs.existsSync(old) && fs.existsSync(fresh) && fs.existsSync(real));
  fs.rmSync(d, { recursive: true, force: true });
});

test('S6: a tampered fork registry cannot make the daemon delete a file that is not a Kora-made fork', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-forkreg-'));
  try {
    const victim = path.join(dir, 'precious.txt'); fs.writeFileSync(victim, 'keep');
    const notUuid = path.join(dir, 'projects', 'slug', 'notes.jsonl'); fs.mkdirSync(path.dirname(notUuid), { recursive: true }); fs.writeFileSync(notUuid, 'keep');
    const sameName = path.join(dir, 'other', 'slug', '0b9c63b4-9c41-4f2a-b8a2-1f7d33a1c001.jsonl'); fs.mkdirSync(path.dirname(sameName), { recursive: true }); fs.writeFileSync(sameName, 'keep');
    const real = path.join(dir, 'projects', 'slug', '0b9c63b4-9c41-4f2a-b8a2-1f7d33a1c002.jsonl'); fs.writeFileSync(real, 'fork');
    fs.writeFileSync(path.join(dir, 'prune-forks.json'), JSON.stringify({
      a: { original: 'o', file: victim, at: 1 }, b: { original: 'o', file: notUuid, at: 1 }, c: { original: 'o', file: sameName, at: 1 }, d: { original: 'o', file: real, at: 1 },
      e: { original: 'o', file: '../../etc/hosts', at: 1 },
    }));
    for (const id of ['a', 'b', 'c', 'd', 'e']) forgetFork(id, dir);
    assert.equal(fs.existsSync(victim), true); assert.equal(fs.existsSync(notUuid), true); assert.equal(fs.existsSync(sameName), true);
    assert.equal(fs.existsSync(real), false, 'a real fork is still removed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
