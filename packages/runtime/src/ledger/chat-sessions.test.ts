import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatSessionRows } from './chat-sessions';
import { ChatThreadStore } from '../session/store';

test('savings sees the desktop-chat lane: a thread that resumed a Claude session shows its measured usage', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-chatled-')));
  const cwd = path.join(root, 'proj'); fs.mkdirSync(cwd);
  const store = new ChatThreadStore(path.join(root, 'chat'));
  const t = store.create({ agent: 'claude', cwd, title: 'my chat' } as any);
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  store.update(t.id, { resume: sid } as any);
  const cfg = path.join(root, 'claude');
  const dir = path.join(cfg, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')); fs.mkdirSync(dir, { recursive: true });
  const l = (o: any) => JSON.stringify(o) + '\n';
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`),
    l({ type: 'user', cwd, sessionId: sid, message: { role: 'user', content: 'hi' } }) +
    l({ type: 'assistant', cwd, sessionId: sid, requestId: 'r1', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 20 }, content: [{ type: 'text', text: 'pong' }] } }));
  const rows = chatSessionRows({ store, configDir: cfg });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, 'my chat');
  assert.equal(rows[0]!.summary.apiCalls, 1);
  assert.ok(rows[0]!.summary.costUsd > 0);
});
