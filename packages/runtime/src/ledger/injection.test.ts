import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTranscript } from './transcript';

function mk(dir: string, opts: { read?: boolean; turns?: number }): string {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'big.js'), 'x'.repeat(20000)); // ~5000 tok, capped to 4000
  const inject = 'Graph, for this prompt (file:line, already resolved — no need to grep):\n■ METHOD foo @ src/big.js:10 — foo()\ncallers:\n■ METHOD bar @ src/other.js:3 — bar()\n(these came from the graph already)';
  const L: string[] = [];
  L.push(JSON.stringify({ type: 'user', cwd: dir, sessionId: 's', message: { role: 'user', content: 'what does foo do?' } }));
  L.push(JSON.stringify({ type: 'attachment', cwd: dir, sessionId: 's', attachment: { type: 'hook_additional_context', content: [inject] } }));
  const turns = opts.turns ?? 1;
  for (let i = 0; i < turns; i++) {
    const content: any[] = [{ type: 'text', text: 'answer' }];
    if (opts.read && i === 0) content.push({ type: 'tool_use', id: 't0', name: 'Read', input: { file_path: path.join(dir, 'src', 'big.js') } });
    L.push(JSON.stringify({ type: 'assistant', cwd: dir, sessionId: 's', requestId: `r${i}`, message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000, output_tokens: 50 }, content } }));
    if (opts.read && i === 0) L.push(JSON.stringify({ type: 'user', cwd: dir, sessionId: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'file body' }] } }));
  }
  const f = path.join(dir, 'sess.jsonl'); fs.writeFileSync(f, L.join('\n') + '\n'); return f;
}

test('a prompt-time injection attachment is parsed from the transcript', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-inj-'));
  const s = parseTranscript(mk(d, { read: false }));
  assert.equal(s.injections.length, 1);
  assert.match(s.injections[0].text, /src\/big\.js:10/);
});
