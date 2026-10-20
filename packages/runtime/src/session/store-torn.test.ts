// Deep audit 2026-10-13 A2-6: an events.ndjson whose last line was torn (a crash or a full disk mid-append) swallowed
// the NEXT event too: it was appended onto the torn bytes and the merged line never parsed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatThreadStore } from './store';

test('the first event after a torn log tail survives a restart, and seq stays gap-free from the last good line', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-torn-'));
  try {
    const s = new ChatThreadStore(root);
    const m = s.create({ agent: 'claude', cwd: '/x' });
    s.append(m.id, { type: 'turn.started' } as any);
    s.append(m.id, { type: 'message.delta', text: 'hi' } as any);
    fs.appendFileSync(path.join(root, m.id, 'events.ndjson'), '{"type":"message.delta","text":"tor');
    const after = new ChatThreadStore(root); // the daemon restarted
    const e = after.append(m.id, { type: 'turn.settled' } as any);
    assert.equal(e.seq, 3);
    assert.deepEqual(after.read(m.id).events.map((x: any) => `${x.seq}:${x.type}`), ['1:turn.started', '2:message.delta', '3:turn.settled']);
    after.append(m.id, { type: 'turn.started' } as any);
    assert.equal(after.read(m.id).events.length, 4, 'later appends are plain lines');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
