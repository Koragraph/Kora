import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blockHashes, changedRanges, dedupeNotice, recordFor, readLogPath, BLOCK_LINES } from './read-dedupe';
import { run as hookRun, markerBase } from '../cli/commands/hook';

const lines = (n: number, tag = 'v1') => Array.from({ length: n }, (_, i) => `line ${i + 1} ${tag}`).join('\n') + '\n';

test('blockHashes / changedRanges: one sha per 40-line block, changed blocks reported as merged line ranges', () => {
  const a = blockHashes(lines(100));
  assert.equal(a.lines, 100); assert.equal(a.blocks.length, 3);
  const b = blockHashes(lines(100).replace('line 45 v1', 'line 45 v2'));
  assert.deepEqual(changedRanges(a, b), [[41, 80]]);
  const c = blockHashes(lines(100).replace('line 5 v1', 'x').replace('line 45 v1', 'y'));
  assert.deepEqual(changedRanges(a, c), [[1, 80]], 'adjacent blocks merge');
  const d = blockHashes(lines(130));
  assert.deepEqual(changedRanges(a, d), [[81, 130]], 'growth shows up as the tail range');
  assert.deepEqual(changedRanges(a, blockHashes(lines(100))), []);
  assert.equal(BLOCK_LINES, 40);
});

test('dedupeNotice: unchanged → already in context; changed → line ranges; new range of a partial read → silent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-rd-'));
  const f = path.join(dir, 'a.ts');
  fs.writeFileSync(f, lines(100));
  const log: any = {};
  assert.equal(dedupeNotice(f, {}, log), null, 'first Read: nothing');
  log[f] = recordFor(f, {}, 3)!;
  assert.match(dedupeNotice(f, {}, log)!, /a\.ts is already in context from an earlier Read \(turn 3; unchanged since\)/);
  // Change lines in the second block (41-80) and make the mtime move.
  fs.writeFileSync(f, lines(100).replace('line 50 v1', 'line 50 CHANGED'));
  const later = new Date(Date.now() + 5000); fs.utimesSync(f, later, later);
  assert.match(dedupeNotice(f, {}, log)!, /changed since your last Read \(turn 3\) at lines 41-80 — Read those ranges/);
  // A ranged previous Read and a request outside that range is a legitimate new Read.
  log[f] = recordFor(f, { offset: 1, limit: 40 }, 4)!;
  assert.equal(dedupeNotice(f, { offset: 50, limit: 20 }, log), null);
  assert.match(dedupeNotice(f, { offset: 5, limit: 10 }, log)!, /already in context/, 'sub-range of what was read → nudge');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hook flow: post-tool records the Read, pre-tool nudges the re-read and reports changed ranges after an edit', async () => {
  const sid = `rd-${process.pid}-${Date.now()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-rd-hook-')); fs.mkdirSync(path.join(dir, '.git'));
  const f = path.join(dir, 'b.ts'); fs.writeFileSync(f, lines(90));
  const base = markerBase({ session_id: sid });
  const io = () => { let out = ''; return { out: (s: string) => { out += s; }, err: () => {}, get stdout() { return out; } }; };
  const ctxOf = (o: any) => (o.stdout ? JSON.parse(o.stdout).hookSpecificOutput.additionalContext || '' : '');
  const pre = async () => { const o = io(); assert.equal(await hookRun(['pre-tool', '--stdin-json', JSON.stringify({ session_id: sid, cwd: dir, tool_name: 'Read', tool_input: { file_path: f } })], o), 0); return ctxOf(o); };
  const post = async () => { const o = io(); assert.equal(await hookRun(['post-tool', '--stdin-json', JSON.stringify({ session_id: sid, cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: f }, tool_response: { file: { filePath: f, content: fs.readFileSync(f, 'utf8') } } })], o), 0); assert.equal(o.stdout, ''); };
  // Turn 1: the prompt hook bumps the turn counter (no injection: not a code-shaped prompt).
  await hookRun(['prompt', '--stdin-json', JSON.stringify({ session_id: sid, cwd: dir, prompt: 'hi' })], io());
  assert.ok(!/already in context|changed since/.test(await pre()), 'first Read is silent');
  await post();
  assert.ok(fs.existsSync(readLogPath(base)));
  assert.match(await pre(), /b\.ts is already in context from an earlier Read \(turn 1; unchanged since\)/);
  fs.writeFileSync(f, lines(90).replace('line 3 v1', 'line 3 edited'));
  const later = new Date(Date.now() + 5000); fs.utimesSync(f, later, later);
  assert.match(await pre(), /b\.ts changed since your last Read \(turn 1\) at lines 1-40/);
  // Config off → silent.
  process.env.KORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-rd-home-'));
  fs.writeFileSync(path.join(process.env.KORA_HOME, 'config.json'), JSON.stringify({ readDedupe: false }));
  require('../config').invalidateConfig?.();
  assert.ok(!/already in context|changed since/.test(await pre()), 'readDedupe:false → silent');
  fs.rmSync(process.env.KORA_HOME, { recursive: true, force: true }); delete process.env.KORA_HOME;
  for (const s of ['-graphused', '-soft', '-redirects', '-laws', '-turn', '-reads.json']) fs.rmSync(base + s, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
