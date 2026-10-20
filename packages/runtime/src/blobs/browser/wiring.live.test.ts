// The movie-ticket scenario through the WIRED runtime (BlobRuntimeImpl.toolSpecs -> the real browser manager -> one real
// headless Chromium) against a local cinema: a blob (driven here by a scripted agent that calls tools the way the model
// would) browses showtimes, reads the price table, fills the seat form, and the booking POST waits for the user. Deny keeps
// the order from ever reaching the site; Allow places it. A password is never typed by the agent, a local address is blocked
// until allowlisted, and the take-over gate pauses the agent. Skipped (with a message) when the engine is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-wired-live-'));
process.env.KORA_BLOBS_ROOT = path.join(root, 'Blobs');
process.env.KORA_HOME = path.join(root, 'kora-home');

import { BlobStore } from '../store';
import { BlobRuntimeImpl } from '../runtime';
import { inlineMemoryHost } from '../memory-host';
import { openMemory } from '../../memory';
import { findInstalledEngine } from './engine';
import { startFixture } from './browser.fixture';
import type { BlobToolContext, FleetToolSpec } from '../types';

async function engineDir(): Promise<string | null> {
  const real = process.env.KORA_TEST_REAL_HOME || os.homedir();
  for (const d of [process.env.KORA_BROWSER_DIR, path.join(real, 'Library/Application Support/Kora/browser'), path.join(real, 'Library/Application Support/Kora/browser-Dev')].filter(Boolean) as string[]) {
    if (await findInstalledEngine(d)) return d;
  }
  return null;
}

test('live, wired: browse showtimes, fill the booking form, the order waits for the user (Deny keeps it from the site, Allow places it)', async (t) => {
  const dir = await engineDir();
  if (!dir) { t.skip('blob browser engine not installed: skipping the wired live test'); return; }
  process.env.KORA_BROWSER_DIR = dir;
  const fx = await startFixture();
  const store = new BlobStore();
  const mem = openMemory({ dbPath: ':memory:', extractor: async () => '{}' });
  const rt = new BlobRuntimeImpl({ store, memory: inlineMemoryHost(mem), oneShot: async () => null, userSkillDirs: [], webhookPort: 0 });
  const popo = store.create({ name: 'Popo', title: 'Researcher', soul: 'x', engine: { instanceId: 'claude', model: 'sonnet', effort: null } });
  const cards: any[] = [];
  let decision = false;
  const ctx: BlobToolContext = { blobId: popo.id, threadId: 'T1', agent: 'claude', cwd: popo.workspace, askApproval: async (p) => { cards.push(p); return decision; } };
  const tools = new Map<string, FleetToolSpec>(rt.toolSpecs(ctx).filter((s) => s.name.startsWith('browser_')).map((s) => [s.name, s]));
  const call = async (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.handler(args);
  const ref = (text: string, re: RegExp): string => { const m = re.exec(text); assert.ok(m, `no ${re} in:\n${text.slice(0, 600)}`); return m![1]!; };
  try {
    // 1. local addresses are blocked until the user allows them for this blob
    const blocked = await call('browser_navigate', { url: `${fx.base}/cinema` });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /BLOCKED|local|private/i);
    assert.equal(fx.hits.length, 0, 'the site never saw the request');
    store.update(popo.id, { toolGrants: { ...popo.toolGrants, computer: { ...popo.toolGrants.computer, allowLocalHosts: [`127.0.0.1:${fx.port}`] } } });

    // 2. showtimes, the price table
    const cinema = await call('browser_navigate', { url: `${fx.base}/cinema` });
    assert.equal(cinema.isError, undefined);
    assert.match(cinema.text, /Showtimes - Rialto Cinema/);
    const table = await call('browser_extract', { kind: 'table' });
    assert.match(table.text, /Dune \| \$14/);
    assert.match(table.text, /Ocean \| \$12/);

    // 3. pick the 7:00 PM show, fill the form
    const seven = ref(cinema.text, /\[(e\d+) link "7:00 PM"/);
    const seats = await call('browser_click', { ref: seven });
    assert.match(seats.text, /Seats/);
    const email = ref(seats.text, /\[(e\d+) textbox "Email"/);
    const typed = await call('browser_type', { ref: email, text: 'sam@example.com' });
    assert.equal(typed.isError, undefined);
    const shot = await call('browser_screenshot');
    assert.ok(shot.image && shot.image.mimeType === 'image/jpeg' && shot.image.data.length > 1000, 'a screenshot is a real jpeg for the model');
    const place = ref(seats.text, /\[(e\d+) button "Place order"/);

    // 4. DENY: the card names the blob and the action; the order never reaches the site
    decision = false;
    const denied = await call('browser_click', { ref: place });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /DENIED/);
    assert.equal(cards.length, 1);
    assert.match(cards[0].title, /^Popo wants to:/);
    assert.match(cards[0].title, /order/i);
    assert.equal(cards[0].args.kind, 'app-action');
    assert.ok(!fx.hits.some((h) => h.startsWith('POST /order')), 'the order was not sent');

    // 5. ALLOW: now it goes through
    decision = true;
    const done = await call('browser_click', { ref: place });
    assert.equal(done.isError, undefined);
    assert.match(done.text, /ORDER PLACED/);
    assert.equal(cards.length, 2);
    assert.ok(fx.hits.some((h) => h.startsWith('POST /order')));

    // 6. a password field is never typed by the agent; the tool says to ask the user to take over
    const login = await call('browser_navigate', { url: `${fx.base}/login` });
    const pw = ref(login.text, /\[(e\d+) secret-field "Password"/);
    const refused = await call('browser_type', { ref: pw, text: 'hunter2' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /secret|password|take over/i);

    // 7. the user takes over from the panel: the agent is paused until Hand back
    const host = rt.browsers.get(popo.id);
    (host as any).o.takeoverWaitMs = 400; (host as any).idleReleaseMs = 60_000; // a quick test: wait 0.4 s for the user, who does not let go
    await host.userInput({ t: 'mouse', type: 'mousePressed', x: 5, y: 5, button: 'left', buttons: 1, clickCount: 1 });
    assert.equal(host.controlState().controller, 'user');
    const paused = await call('browser_snapshot');
    assert.equal(paused.isError, true);
    assert.match(paused.text, /USER_HAS_CONTROL/);
    host.handBack();
    assert.equal((await call('browser_snapshot')).isError, undefined);

    // 8. the live source the ui-server route talks to sees this very host; closing it leaves the profile (sign-ins) on disk
    const live = rt.browserLive;
    assert.equal(live.get(popo.id), host);
    await live.close(popo.id);
    assert.ok(fs.existsSync(host.status().profileDir), 'the profile stays for the next time');
  } finally {
    await rt.browsers.shutdown();
    await fx.close();
  }
});

test('live, over the daemon socket: a screenshot reaches a Codex / OpenCode / ACP blob as an image through `kora mcp --blobs`\' own RPCs', async (t) => {
  const dir = await engineDir();
  if (!dir) { t.skip('blob browser engine not installed: skipping the socket screenshot test'); return; }
  process.env.KORA_BROWSER_DIR = dir;
  const { createServer } = await import('../../server/daemon');
  const { socketCaller } = await import('../../cli/commands/mcp-blobs');
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbs-'));
  const sock = path.join(sockDir, 'd.sock');
  const handle = await createServer({ socketPath: sock, restore: false, sweep: false });
  const fx = await startFixture();
  const caller = socketCaller(sock);
  try {
    const blob = handle.blobs.store.create({ name: 'Shotty', title: 'Browser', soul: 'x', engine: { instanceId: 'codex', model: 'gpt-5', effort: null } });
    handle.blobs.store.update(blob.id, { toolGrants: { ...blob.toolGrants, computer: { ...blob.toolGrants.computer, allowLocalHosts: [`127.0.0.1:${fx.port}`] } } });
    const token = handle.blobs.mcpIssue({ blobId: blob.id, threadId: 'S1', agent: 'codex', cwd: blob.workspace });
    const hello = await caller.call('blobs.mcp.hello', { blobId: blob.id, token });
    assert.ok(hello.ok && hello.tools.some((x: { name: string }) => x.name === 'browser_screenshot'));
    const nav = await caller.call('blobs.mcp.call', { blobId: blob.id, token, name: 'browser_navigate', args: { url: `${fx.base}/cinema` } }, 60_000);
    assert.match(nav.text, /Showtimes - Rialto Cinema/);
    const shot = await caller.call('blobs.mcp.call', { blobId: blob.id, token, name: 'browser_screenshot', args: {} }, 60_000);
    assert.equal(shot.image?.mimeType, 'image/jpeg');
    assert.ok(Buffer.from(shot.image.data, 'base64').subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), 'a real jpeg crossed the socket intact');
  } finally {
    caller.close();
    await fx.close();
    await handle.close();
    fs.rmSync(sockDir, { recursive: true, force: true });
  }
});
