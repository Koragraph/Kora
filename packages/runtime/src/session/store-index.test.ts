import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatThreadStore } from './store';

test('store: index.json rebuilds are coalesced (a streamed turn updates the head per event), flushIndex writes it now', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-store-idx-'));
  const s = new ChatThreadStore(dir);
  const a = s.create({ agent: 'claude', cwd: '/r' });
  const idx = path.join(dir, 'index.json');
  s.flushIndex();
  const before = fs.statSync(idx).mtimeMs;
  const b = s.create({ agent: 'claude', cwd: '/r' });
  for (let i = 0; i < 200; i++) { s.append(a.id, { type: 'content.delta', text: 'x' } as any); s.update(a.id, { lastSeq: i }); }
  assert.equal(fs.statSync(idx).mtimeMs, before, 'no rebuild per head update');
  assert.equal(s.get(a.id).lastSeq, 199, 'the head itself is written through');
  s.flushIndex();
  const heads = JSON.parse(fs.readFileSync(idx, 'utf8')).map((h: { id: string }) => h.id).sort();
  assert.deepEqual(heads, [a.id, b.id].sort());
  fs.rmSync(dir, { recursive: true, force: true });
});
