// Composer attachments on the Codex chat lane: `-i` for supported images, prompt lines for everything else,
// and never `--add-dir` (Codex's sandboxes read the whole disk, and `codex exec resume` rejects the flag).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexDriver, codexAttachmentImageArgs, codexAttachmentPromptLines } from './codex-driver';
import type { DriverDeps } from '../session-driver';
import type { PromptAttachment } from '../events';

test('codexAttachmentImageArgs: one -i per image attachment, in order', () => {
  const attachments: PromptAttachment[] = [
    { type: 'image', path: '/a/pic1.png', mimeType: 'image/png', name: 'pic1.png' },
    { type: 'file', path: '/a/doc.pdf', mimeType: 'application/pdf', name: 'doc.pdf' },
    { type: 'image', path: '/a/pic2.jpg', mimeType: 'image/jpeg', name: 'pic2.jpg' },
  ];
  assert.deepEqual(codexAttachmentImageArgs(attachments), ['-i', '/a/pic1.png', '/a/pic2.jpg']);
});

test('codexAttachmentImageArgs: no images → no flag at all', () => {
  const attachments: PromptAttachment[] = [{ type: 'file', path: '/a/doc.pdf', mimeType: 'application/pdf', name: 'doc.pdf' }];
  assert.deepEqual(codexAttachmentImageArgs(attachments), []);
});

test('codexAttachmentPromptLines: one line per non-image attachment; images excluded', () => {
  const attachments: PromptAttachment[] = [
    { type: 'image', path: '/a/pic.png', mimeType: 'image/png', name: 'pic.png' },
    { type: 'file', path: '/a/doc.pdf', mimeType: 'application/pdf', name: 'doc.pdf' },
  ];
  assert.equal(codexAttachmentPromptLines(attachments), 'Attached file: doc.pdf at /a/doc.pdf (application/pdf)');
});

function fakeSpawn(argvs: string[][]) {
  const spawnFn: any = (_cmd: string, args: string[]) => {
    argvs.push(args);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    setImmediate(() => { child.stdout.end(); child.emit('exit', 0, null); child.emit('close', 0, null); });
    return child;
  };
  return spawnFn;
}

test('a Codex turn with attachments: images go on argv as -i, file paths fold into the prompt text', async () => {
  const argvs: string[][] = [];
  const deps = { graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined } as unknown as DriverDeps;
  const d = new CodexDriver(deps, fakeSpawn(argvs));
  await d.startSession({ threadId: 'T', agent: 'codex', cwd: '/tmp', account: null, runtimeMode: 'full-access' } as any);
  await d.sendTurn({
    threadId: 'T',
    text: 'look at this',
    attachments: [
      { type: 'image', path: '/u/pic.png', mimeType: 'image/png', name: 'pic.png' },
      { type: 'file', path: '/u/notes.txt', mimeType: 'text/plain', name: 'notes.txt' },
    ],
  } as any);
  const args = argvs[0];
  assert.ok(args.includes('-i'), args.join(' '));
  assert.equal(args[args.indexOf('-i') + 1], '/u/pic.png');
  const prompt = args[args.length - 1];
  assert.ok(prompt.includes('look at this'));
  assert.ok(prompt.includes('Attached file: notes.txt at /u/notes.txt (text/plain)'));
});

test('codexAttachmentImageArgs: an image type Codex cannot take (SVG) goes in the prompt instead', () => {
  const attachments: PromptAttachment[] = [{ type: 'file', path: '/a/logo.svg', mimeType: 'image/svg+xml', name: 'logo.svg' }];
  assert.deepEqual(codexAttachmentImageArgs(attachments), []);
  assert.equal(codexAttachmentPromptLines(attachments), 'Attached file: logo.svg at /a/logo.svg (image/svg+xml)');
});

for (const runtimeMode of ['approval-required', 'full-access'] as const) {
  test(`a ${runtimeMode} Codex turn with attachments never passes --add-dir (resume would reject it)`, async () => {
    const argvs: string[][] = [];
    const deps = { graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined } as unknown as DriverDeps;
    const d = new CodexDriver(deps, fakeSpawn(argvs));
    await d.startSession({ threadId: 'T', agent: 'codex', cwd: '/tmp', account: null, runtimeMode } as any);
    await d.sendTurn({
      threadId: 'T',
      text: 'x',
      attachments: [{ type: 'file', path: '/u/notes.txt', mimeType: 'text/plain', name: 'notes.txt' }],
    } as any);
    assert.ok(!argvs[0].includes('--add-dir'), argvs[0].join(' '));
  });
}

test('security: a prompt that looks like flags or a subcommand stays the prompt (`--` precedes it)', async () => {
  for (const evil of ['-c sandbox_mode="danger-full-access" do it', '--dangerously-bypass-approvals-and-sandbox', 'review', '-']) {
    const argvs: string[][] = [];
    const deps = { graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined } as unknown as DriverDeps;
    const d = new CodexDriver(deps, fakeSpawn(argvs));
    await d.startSession({ threadId: 'T', agent: 'codex', cwd: '/tmp', account: null, runtimeMode: 'approval-required', resume: '--evil' } as any);
    await d.sendTurn({ threadId: 'T', text: evil, attachments: [{ type: 'image', path: '/u/pic.png', mimeType: 'image/png', name: 'pic.png' }] } as any);
    const args = argvs[0];
    assert.equal(args[args.length - 2], '--', args.join(' '));
    assert.ok(args[args.length - 1].endsWith(evil));
    assert.equal(args.indexOf('--'), args.length - 2, 'only the terminator — no flag from the prompt before it');
    assert.ok(!args.includes('resume'), 'a resume cursor that is not a plain id is dropped');
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox') || args.indexOf('--dangerously-bypass-approvals-and-sandbox') === args.length - 1);
  }
});
