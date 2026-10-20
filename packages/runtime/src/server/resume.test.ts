import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { briefFacts, renderBrief, writeResumeBrief, BRIEF_TOKEN_CAP, resumeBriefPath } from './resume';
import { approxTokens } from '../ledger/transcript';

function transcript(lines: any[]): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nh-tr-')), 's.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); return f;
}
const usage = (ctx: number) => ({ input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: ctx, output_tokens: 50 });
const user = (text: string) => ({ type: 'user', sessionId: 'sess-1234-abcd', cwd: '/repo', message: { role: 'user', content: text }, timestamp: '2026-01-01T00:00:00Z' });
const asst = (content: any[], ctx: number, rid: string) => ({ type: 'assistant', requestId: rid, message: { model: 'claude-sonnet-5', usage: usage(ctx), content }, timestamp: '2026-01-01T00:00:01Z' });
const result = (id: string, text: string, extra: any = {}) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }, ...extra });

test('briefFacts: first/last prompt, last assistant text, files deduped with edit flag, cost', () => {
  const f = transcript([
    user('Fix the flaky test in src/a.test.ts'),
    asst([{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/src/a.ts' } }], 1000, 'r1'),
    result('t1', 'function a(){}', { toolUseResult: { file: { filePath: '/repo/src/a.ts' } } }),
    asst([{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' } }], 2000, 'r2'),
    result('t2', 'ok'),
    user('also update the docs'),
    asst([{ type: 'text', text: 'Done: changed a.ts:3 and docs.' }], 3000, 'r3'),
  ]);
  const b = briefFacts(f);
  assert.equal(b.firstPrompt, 'Fix the flaky test in src/a.test.ts'); assert.equal(b.lastPrompt, 'also update the docs');
  assert.equal(b.lastAssistant, 'Done: changed a.ts:3 and docs.');
  assert.deepEqual(b.files, [{ file: 'src/a.ts', edited: true }]);
  assert.equal(b.apiCalls, 3); assert.equal(b.lastContext, 3010); assert.ok(b.costUsd > 0);
  const text = renderBrief(b);
  assert.match(text, /## First prompt\nFix the flaky/); assert.match(text, /- src\/a.ts \(edited\)/); assert.match(text, /fresh session/);
});
test('renderBrief: capped at ~700 tokens, the assistant text absorbs the cut', () => {
  const long = 'word '.repeat(3000);
  const text = renderBrief({ sessionId: null, firstPrompt: 'p', lastPrompt: 'q', lastAssistant: long, files: Array.from({ length: 30 }, (_, i) => ({ file: `f${i}.ts`, edited: false })), costUsd: 1, apiCalls: 9, lastContext: 5, model: null });
  assert.ok(approxTokens(text) <= BRIEF_TOKEN_CAP + 20, `too long: ${approxTokens(text)}`);
  assert.match(text, /last 12 of 30/);
});
test('writeResumeBrief: writes ~/.kora/panes/<id>/resume-brief.md; null for a missing transcript', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-home-')); const prev = process.env.KORA_HOME; process.env.KORA_HOME = home;
  try {
    assert.equal(writeResumeBrief('p9', '/nope/none.jsonl'), null);
    const f = transcript([user('hello there'), asst([{ type: 'text', text: 'hi' }], 100, 'r1')]);
    const r = writeResumeBrief('p9', f)!;
    assert.equal(r.path, resumeBriefPath('p9')); assert.ok(fs.existsSync(r.path)); assert.ok(r.tokens > 10);
  } finally { if (prev === undefined) delete process.env.KORA_HOME; else process.env.KORA_HOME = prev; }
});
