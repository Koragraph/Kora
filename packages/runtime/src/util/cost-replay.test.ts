import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// scripts/cost-replay.cjs on a synthetic ~/.claude/projects: three calls in one session (a whole long-file Read, a 12k Bash,
// a 2 h idle gap with a model switch) so every lever reports a known number.
const script = path.resolve(__dirname, '..', '..', 'scripts', 'cost-replay.cjs');
const line = (o: unknown) => JSON.stringify(o);
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-replay-'));
  const dir = path.join(root, '-proj'); fs.mkdirSync(dir);
  const t0 = Date.parse('2026-10-14T10:00:00Z');
  const iso = (ms: number) => new Date(t0 + ms).toISOString();
  const big = Array.from({ length: 800 }, (_, i) => `${i + 1}\tconst x${i} = ${i};`).join('\n');
  const rows = [
    line({ type: 'user', entrypoint: 'sdk-ts', message: { content: 'go' }, timestamp: iso(0) }),
    line({ type: 'assistant', timestamp: iso(1000), message: { id: 'a1', model: 'claude-sonnet-5-5', usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 30000, output_tokens: 50 }, content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/repo/src/big.ts' } }] } }),
    line({ type: 'user', timestamp: iso(2000), message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: big }] } }),
    line({ type: 'assistant', timestamp: iso(3000), message: { id: 'a2', model: 'claude-sonnet-5-5', usage: { input_tokens: 3, cache_read_input_tokens: 30000, cache_creation_input_tokens: 6000, output_tokens: 50 }, content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } }] } }),
    line({ type: 'user', timestamp: iso(4000), message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'y'.repeat(12000) }] } }),
    line({ type: 'assistant', timestamp: iso(2 * 3600 * 1000), message: { id: 'a3', model: 'claude-haiku-5-5', usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 42000, output_tokens: 80 }, content: [{ type: 'text', text: 'done' }] } }),
  ];
  fs.writeFileSync(path.join(dir, 's.jsonl'), rows.join('\n') + '\n');
  return root;
}
test('cost-replay reports each lever\'s ceiling from transcripts, read-only', () => {
  const root = fixture();
  const before = fs.readdirSync(path.join(root, '-proj')).length;
  const out = JSON.parse(execFileSync(process.execPath, [script, '--root', root, '--days', '3650', '--json'], { encoding: 'utf8' }));
  assert.equal(out.scanned.calls, 3); assert.equal(out.scanned.sessions, 1);
  const b = out.levers.boundedRead;
  assert.equal(b.wholeCodeReads, 1); assert.equal(b.longFileReads, 1);
  assert.ok(b.ceilingSaveTokens > 0.6 * b.longFileTokens && b.ceilingSaveTokens < b.longFileTokens, `${b.ceilingSaveTokens} of ${b.longFileTokens}`);
  assert.equal(out.levers.bashSpill8k.inBand8k30k, 1);
  assert.equal(out.levers.coldResumeMasking.coldCalls, 1); assert.equal(out.levers.coldResumeMasking.rewrittenTokens, 42000);
  assert.equal(out.levers.modelSwitches.switches, 1);
  assert.equal(out.levers.fixedPrefix.medianFirstCallTokens, 30003);
  assert.equal(fs.readdirSync(path.join(root, '-proj')).length, before, 'nothing written');
  const text = execFileSync(process.execPath, [script, '--root', root, '--days', '3650'], { encoding: 'utf8' });
  assert.match(text, /bounded Read\s+1\/1 Reads were whole code files/);
  assert.match(text, /idle gaps > 1h\s+1 calls came back cold/);
  assert.match(execFileSync(process.execPath, [script, '--root', path.join(root, 'none')], { encoding: 'utf8' }), /nothing to replay/);
});
