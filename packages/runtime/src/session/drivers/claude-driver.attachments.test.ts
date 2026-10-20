// Composer attachments on the Claude chat lane: content-block mapping + the additionalDirectories whitelist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_IMAGE_MIME_TYPES, CLAUDE_MAX_INLINE_IMAGE_BYTES,
  claudeAttachmentBlock,
  buildClaudeTurnContent,
  buildSessionOptions,
} from './claude-driver';
import type { PromptAttachment } from '../events';

test('claudeAttachmentBlock: image data → an image content block', () => {
  const a: PromptAttachment = { type: 'image', path: '/x/pic.png', mimeType: 'image/png', name: 'pic.png' };
  const block = claudeAttachmentBlock(a, 'QUJD');
  assert.deepEqual(block, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
});

test('claudeAttachmentBlock: PDF data → a document content block', () => {
  const a: PromptAttachment = { type: 'file', path: '/x/doc.pdf', mimeType: 'application/pdf', name: 'doc.pdf' };
  const block = claudeAttachmentBlock(a, 'JVBER');
  assert.deepEqual(block, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER' } });
});

test('claudeAttachmentBlock: anything else (or no data) → a text reference the agent can Read', () => {
  const a: PromptAttachment = { type: 'file', path: '/x/data.csv', mimeType: 'text/csv', name: 'data.csv' };
  const block = claudeAttachmentBlock(a, null);
  assert.deepEqual(block, { type: 'text', text: 'Attached file: data.csv at /x/data.csv (text/csv)' });
});

test('claudeAttachmentBlock: an image mime with no data (unreadable) also falls back to a text reference', () => {
  const a: PromptAttachment = { type: 'image', path: '/x/pic.gif', mimeType: 'image/gif', name: 'pic.gif' };
  const block = claudeAttachmentBlock(a, null);
  assert.deepEqual(block, { type: 'text', text: 'Attached file: pic.gif at /x/pic.gif (image/gif)' });
});

test('CLAUDE_IMAGE_MIME_TYPES matches the contract-advertised set', () => {
  for (const m of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) assert.ok(CLAUDE_IMAGE_MIME_TYPES.has(m));
  assert.ok(!CLAUDE_IMAGE_MIME_TYPES.has('image/svg+xml'));
});

test('buildClaudeTurnContent: text block first, then one block per attachment, images read + base64 inline', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kora-claude-attach-'));
  const imgPath = path.join(dir, 'pic.png');
  await fs.writeFile(imgPath, Buffer.from('fake-png-bytes'));
  const csvPath = path.join(dir, 'data.csv');
  await fs.writeFile(csvPath, 'a,b\n1,2\n');
  const attachments: PromptAttachment[] = [
    { type: 'image', path: imgPath, mimeType: 'image/png', name: 'pic.png' },
    { type: 'file', path: csvPath, mimeType: 'text/csv', name: 'data.csv' },
  ];
  const content = await buildClaudeTurnContent('see attached', attachments);
  assert.equal(content.length, 3);
  assert.deepEqual(content[0], { type: 'text', text: 'see attached' });
  assert.equal(content[1].type, 'image');
  assert.equal(content[1].source.media_type, 'image/png');
  assert.equal(Buffer.from(content[1].source.data, 'base64').toString(), 'fake-png-bytes');
  assert.deepEqual(content[2], { type: 'text', text: `Attached file: data.csv at ${csvPath} (text/csv)` });
  await fs.rm(dir, { recursive: true, force: true });
});

test('buildClaudeTurnContent: a missing/unreadable image file falls back to a text reference instead of throwing', async () => {
  const attachments: PromptAttachment[] = [
    { type: 'image', path: '/does/not/exist.png', mimeType: 'image/png', name: 'exist.png' },
  ];
  const content = await buildClaudeTurnContent('hi', attachments);
  assert.equal(content.length, 2);
  assert.deepEqual(content[1], { type: 'text', text: 'Attached file: exist.png at /does/not/exist.png (image/png)' });
});

test('buildSessionOptions: additionalDirectories whitelists <KORA_HOME>/attachments so Read can reach uploads', () => {
  const opts = buildSessionOptions(
    { threadId: 'T', agent: 'claude', cwd: '/repo', account: null } as any,
    null,
    undefined,
    {},
    { mcpServers: {}, canUseTool: undefined },
  );
  // B16 "on" (the default) adds <KORA_HOME>/tool-out after it, so the agent can Read a trimmed command's full output.
  assert.ok(Array.isArray(opts.additionalDirectories) && opts.additionalDirectories.length >= 1);
  assert.ok(opts.additionalDirectories[0].endsWith(path.join('attachments')));
});

test('buildClaudeTurnContent: an image over the API 5 MB inline limit goes as a path, not base64', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kora-claude-attach-big-'));
  const imgPath = path.join(dir, 'huge.png');
  await fs.writeFile(imgPath, Buffer.alloc(CLAUDE_MAX_INLINE_IMAGE_BYTES + 1));
  const content = await buildClaudeTurnContent('x', [
    { type: 'image', path: imgPath, mimeType: 'image/png', name: 'huge.png' },
  ]);
  assert.deepEqual(content[1], { type: 'text', text: `Attached file: huge.png at ${imgPath} (image/png)` });
  await fs.rm(dir, { recursive: true, force: true });
});
