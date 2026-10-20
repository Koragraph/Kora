import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReadDedupeHooks } from './read-dedupe-hooks';
import type { ChatReadDedupeMode } from '../util/savings-settings';
import { flushCostLog, readCostLog } from '../util/cost-log';

type H = Record<string, Array<{ matcher?: string; hooks: Array<(i: any) => Promise<any>> }>>;
function setup(mode: ChatReadDedupeMode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-rdh-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-rdhh-'));
  const file = path.join(dir, 'config.json');
  const text = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n') + '\n';
  fs.writeFileSync(file, text);
  const h = createReadDedupeHooks({ threadId: 'T', mode: () => mode, home, cwd: dir }) as H;
  const pre = (ti: any) => h.PreToolUse![0]!.hooks[0]!({ tool_name: 'Read', tool_input: ti });
  const post = (ti: any, file_: any) => h.PostToolUse![0]!.hooks[0]!({ tool_name: 'Read', tool_input: ti, tool_response: { type: 'text', file: file_ } });
  const batch = () => h.PostToolBatch![0]!.hooks[0]!({ hook_event_name: 'PostToolBatch' });
  const compact = () => h.PreCompact![0]!.hooks[0]!({ hook_event_name: 'PreCompact' });
  const whole = async () => { await post({ file_path: file }, { filePath: file, content: text, numLines: 120, startLine: 1, totalLines: 120 }); await batch(); };
  return { dir, home, file, text, pre, post: async (ti: any, f: any) => { await post(ti, f); await batch(); }, compact, whole, rawPost: post, batch };
}

test('a first Read is never touched; an unchanged whole-file re-read is nudged in "nudge" mode', async () => {
  const t = setup('nudge');
  assert.deepEqual(await t.pre({ file_path: t.file }), {});
  await t.whole();
  const r = await t.pre({ file_path: t.file });
  assert.equal(r.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(r.hookSpecificOutput.permissionDecision, undefined);
  assert.match(r.hookSpecificOutput.additionalContext, /config\.json is already in context.*unchanged since/);
});

test('shadow decides and logs, and changes nothing; off is silent', async () => {
  const t = setup('shadow');
  await t.whole();
  assert.deepEqual(await t.pre({ file_path: t.file }), {});
  await flushCostLog(t.home);
  const rows = readCostLog({ home: t.home }).filter((r) => r.k === 'read-dedupe-shadow'); // the log buffer is process-wide: an earlier test's row may ride along
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as any).action, 'nudge');
  const o = setup('off');
  await o.whole();
  assert.deepEqual(await o.pre({ file_path: o.file }), {});
});

test('deny: the first unchanged re-read is refused, the second attempt always goes through', async () => {
  const t = setup('deny');
  await t.whole();
  const first = await t.pre({ file_path: t.file });
  assert.equal(first.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(first.hookSpecificOutput.permissionDecisionReason, /already in context/);
  assert.deepEqual(await t.pre({ file_path: t.file }), {}, 'the agent asked again: allowed, no noise');
  await t.whole(); // it was read again
  assert.equal((await t.pre({ file_path: t.file })).hookSpecificOutput.permissionDecision, 'deny', 'a later re-read is refused once more');
});

test('deny never fires on a changed file: it gets the changed line ranges as context instead', async () => {
  const t = setup('deny');
  await t.whole();
  fs.writeFileSync(t.file, t.text.replace('line 100', 'line 100 CHANGED'));
  const r = await t.pre({ file_path: t.file });
  assert.equal(r.hookSpecificOutput.permissionDecision, undefined);
  assert.match(r.hookSpecificOutput.additionalContext, /changed since your last Read.*lines 81-120/);
});

test('never after a compaction: the log is dropped', async () => {
  const t = setup('deny');
  await t.whole();
  await t.compact();
  assert.deepEqual(await t.pre({ file_path: t.file }), {});
});

test('a range the earlier Read did not include is a new range; a range inside a whole-file Read is a re-read', async () => {
  const t = setup('deny');
  await t.post({ file_path: t.file, offset: 1, limit: 40 }, { filePath: t.file, content: 'x', numLines: 40, startLine: 1, totalLines: 120 });
  assert.deepEqual(await t.pre({ file_path: t.file, offset: 60, limit: 20 }), {}, 'lines 60-79 were never shown');
  assert.equal((await t.pre({ file_path: t.file, offset: 5, limit: 10 })).hookSpecificOutput.permissionDecision, 'deny', 'lines 5-14 were');
  const w = setup('deny');
  await w.whole();
  assert.equal((await w.pre({ file_path: w.file, offset: 30, limit: 10 })).hookSpecificOutput.permissionDecision, 'deny');
});

test('a long file\'s whole-file Read is recorded as only the lines it showed', async () => {
  const t = setup('deny');
  await t.post({ file_path: t.file }, { filePath: t.file, content: 'x', numLines: 50, startLine: 1, totalLines: 120 });
  assert.deepEqual(await t.pre({ file_path: t.file, offset: 100, limit: 10 }), {}, 'lines past the cut were never in context');
});

test('fail open: junk input, a missing file, an image result and a PDF page range', async () => {
  const t = setup('deny');
  assert.deepEqual(await t.pre(undefined), {});
  assert.deepEqual(await t.pre({}), {});
  assert.deepEqual(await t.pre({ file_path: path.join(t.dir, 'nope.txt') }), {});
  await t.post({ file_path: t.file }, { base64: 'AAAA', type: 'image/png' });
  assert.deepEqual(await t.pre({ file_path: t.file }), {}, 'an image result is not a text read');
  await t.whole();
  assert.deepEqual(await t.pre({ file_path: t.file, pages: '1-3' }), {});
});

test('a Read issued in the same parallel batch is not a re-read: the log commits only when the batch is answered', async () => {
  const t = setup('deny');
  await t.rawPost({ file_path: t.file }, { filePath: t.file, content: t.text, numLines: 120, startLine: 1, totalLines: 120 });
  assert.deepEqual(await t.pre({ file_path: t.file }), {}, 'same batch: the model has not seen the first result yet');
  await t.batch();
  assert.equal((await t.pre({ file_path: t.file })).hookSpecificOutput.permissionDecision, 'deny', 'next turn: it has');
});
