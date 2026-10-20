// Blob browser: pure units (classifier, url policy, approvals, schemas, engine verification, sweep guard) always run;
// the live tests drive ONE real headless Chromium against a local fixture site at a time and are SKIPPED (with a
// message) when the engine is not installed (set KORA_BROWSER_DIR, or open a blob browser once in Kora).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BlobBrowserHost, type BrowserToolResult } from './host';
import { launchEngine, ensureEngine, findInstalledEngine, pidAlive, sweepOrphans, pinnedEngine, isOrphanBrowser, splitWindowsCommandLine, type EngineSource } from './engine';
import { askApproval, checkNavigableUrl, classifyOutbound, denyAfter, type ElementInfo } from './safety';
import { BROWSER_TOOLS, browserFleetSpecs, inputJsonSchema, paramShapeOf, runBrowserTool } from './tools';
import { startFixture } from './browser.fixture';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbrowser-'));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function findEngineBin(): Promise<string | null> {
  const real = process.env.KORA_TEST_REAL_HOME || os.homedir();
  const dirs = [process.env.KORA_BROWSER_DIR, path.join(real, 'Library/Application Support/Kora/browser'), path.join(real, 'Library/Application Support/Kora/browser-Dev')].filter(Boolean) as string[];
  for (const d of dirs) { const e = await findInstalledEngine(d); if (e) return e.bin; }
  return null;
}
const SKIP = 'blob browser engine not installed (set KORA_BROWSER_DIR to a dir holding chrome-headless-shell, or install it from Kora): skipping live browser tests';

const info = (o: Partial<ElementInfo>): ElementInfo => ({ tag: 'BUTTON', type: 'submit', label: '', isSubmit: true, form: null, href: null, secret: false, editable: false, ...o });
const form = (o: Partial<NonNullable<ElementInfo['form']>> = {}) => ({ action: 'http://x/y', method: 'get', nFields: 1, secretInForm: false, cardInForm: false, ...o });

// ---------------------------------------------------------------- pure units

test('outbound classifier: hard / soft / none', () => {
  assert.equal(classifyOutbound(info({ label: 'Place order', form: form({ method: 'post' }) }), 'click', 'h').level, 'hard');
  assert.equal(classifyOutbound(info({ label: 'Continue', form: form({ method: 'post' }) }), 'click', 'h').level, 'hard', 'any POST submit');
  assert.equal(classifyOutbound(info({ label: 'Go', form: form({ secretInForm: true }) }), 'click', 'h').level, 'hard', 'password in form');
  assert.equal(classifyOutbound(info({ label: 'Search', form: form() }), 'click', 'h').level, 'none', 'GET search');
  assert.equal(classifyOutbound(info({ tag: 'A', type: '', label: 'Pay now', isSubmit: false, href: 'https://s/checkout' }), 'click', 'h').level, 'hard', 'checkout link');
  assert.equal(classifyOutbound(info({ tag: 'A', type: '', label: 'Delete', isSubmit: false, href: 'https://s/x' }), 'click', 'h').level, 'none', 'plain link text is not gated');
  assert.equal(classifyOutbound(info({ tag: 'A', type: '', label: 'Book tickets', isSubmit: false, href: 'https://s/book' }), 'click', 'h').level, 'soft');
  assert.equal(classifyOutbound(info({ tag: 'BUTTON', type: 'button', label: 'Delete account', isSubmit: false }), 'click', 'h').level, 'hard');
});

test('url policy: http(s) only, no file/javascript/data/credentials', () => {
  assert.equal(checkNavigableUrl('https://example.com/a?b=1').ok, true);
  for (const u of ['file:///etc/hosts', 'javascript:alert(1)', 'chrome://settings', 'data:text/html,hi', 'ftp://x', 'not a url', 'https://u:p@example.com/']) assert.equal(checkNavigableUrl(u).ok, false, u);
});

test('approval callback: missing, throwing, silent and denying all mean deny', async () => {
  const req = { id: 'a', blobId: 'b', summary: 's', url: 'u' };
  assert.equal(await askApproval(undefined, req, 50), false);
  assert.equal(await askApproval(async () => { throw new Error('x'); }, req, 50), false);
  assert.equal(await askApproval(() => new Promise<boolean>(() => {}), req, 50), false);
  assert.equal(await askApproval(async () => false, req, 50), false);
  assert.equal(await askApproval(async () => true, req, 50), true);
});

test('approval timeout: a lost race leaves no timer behind; an unanswered one still denies', async () => {
  const active = () => (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const base = active();
  const ctl = new AbortController();
  const req = { id: 'a', blobId: 'b', summary: 's', url: 'u', signal: ctl.signal };
  let answer!: (v: boolean) => void;
  const asked = askApproval(() => new Promise<boolean>(() => {}), req, 180_000);
  const panel = new Promise<boolean>((r) => { answer = r; });
  const idle = denyAfter(180_000, ctl.signal);
  assert.equal(active(), base + 2, 'both deny timers are armed (and keep the loop alive)');
  answer(true);
  assert.equal(await Promise.race([asked, idle, panel]), true, 'the panel won');
  ctl.abort();   // what BlobBrowserHost.approve does once the race settles
  assert.equal(await asked, false); assert.equal(await idle, false);
  assert.equal(active(), base, 'no 180 s timer left behind');
  assert.equal(await denyAfter(10), false, 'unanswered: deny');
  assert.equal(await denyAfter(10_000, AbortSignal.abort()), false, 'already settled: deny at once');
});

test('tool specs: 12 tools, zod validation, fleet param shapes, JSON schemas', async () => {
  assert.equal(BROWSER_TOOLS.length, 12);
  assert.deepEqual(BROWSER_TOOLS.map((t) => t.name).sort(), ['browser_back', 'browser_click', 'browser_extract', 'browser_navigate', 'browser_press_key', 'browser_screenshot', 'browser_scroll', 'browser_select', 'browser_snapshot', 'browser_tabs', 'browser_type', 'browser_wait_for']);
  const shape = paramShapeOf(BROWSER_TOOLS.find((t) => t.name === 'browser_type')!.schema);
  assert.equal(shape.ref.type, 'string'); assert.equal(shape.clear.optional, true); assert.equal(shape.clear.type, 'boolean');
  assert.deepEqual(paramShapeOf(BROWSER_TOOLS.find((t) => t.name === 'browser_tabs')!.schema).action.enum, ['list', 'new', 'switch', 'close']);
  for (const t of BROWSER_TOOLS) { assert.ok(t.description.length > 40, t.name); assert.equal((inputJsonSchema(t) as any).type, 'object'); }
  const host = { call: async () => { throw new Error('must not be reached'); } } as unknown as BlobBrowserHost;
  const bad = await runBrowserTool(host, 'browser_click', {});
  assert.equal(bad.isError, true); assert.match(bad.text, /bad arguments/);
  assert.equal((await runBrowserTool(host, 'browser_nope', {})).isError, true);
  assert.equal(browserFleetSpecs(() => host).length, 12);
});

test('engine install: wrong hash or size is refused and leaves nothing behind', async () => {
  const body = Buffer.alloc(2048, 7);
  const srv = http.createServer((_q, r) => { r.setHeader('content-length', String(body.length)); r.end(body); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const dir = path.join(tmp, 'engine-bad');
  const mk = (over: Partial<EngineSource['build']>): EngineSource => ({ version: '0.0.0.1', build: { url: `http://127.0.0.1:${port}/e.zip`, sha256: '0'.repeat(64), size: body.length, dirName: 'x', binRel: 'x', ...over } });
  await assert.rejects(ensureEngine({ dir, source: mk({}) }), /SHA-256/);
  await assert.rejects(ensureEngine({ dir, source: mk({ size: 99 }) }), /unexpected size/);
  assert.deepEqual(fs.readdirSync(dir), [], 'no half-installed leftovers');
  assert.equal(await findInstalledEngine(dir, mk({})), null);
  srv.close();
  assert.ok(pinnedEngine() === null || pinnedEngine()!.build.sha256.length === 64);
});

test('orphan sweep never touches a pid whose command is not our browser, or whose owner is alive', async () => {
  const dir = path.join(tmp, 'reg-guard'); fs.mkdirSync(dir, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
  const sleeper = (await import('node:child_process')).spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(dir, 'pids.json'), JSON.stringify({
      [String(sleeper.pid)]: { profileDir: '/nowhere', bin: 'x', ownerPid: dead, startedAt: 1 },       // owner dead, but not a headless shell
      [String(process.pid)]: { profileDir: '/nowhere', bin: 'x', ownerPid: process.pid, startedAt: 1 },  // owner alive
    }));
    const r = await sweepOrphans({ dir });
    assert.deepEqual(r.killed, []);
    assert.ok(pidAlive(sleeper.pid!), 'unrelated process survived');
    assert.ok(r.skipped.includes(process.pid));
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'pids.json'), 'utf8'))), [String(process.pid)]);
  } finally { sleeper.kill('SIGKILL'); }
});

test('Windows command lines split like CommandLineToArgvW', () => {
  assert.deepEqual(splitWindowsCommandLine('a "b c" d'), ['a', 'b c', 'd']);
  assert.deepEqual(splitWindowsCommandLine('"C:\\Program Files\\x.exe"  "--user-data-dir=C:\\Users\\First Last\\p"'), ['C:\\Program Files\\x.exe', '--user-data-dir=C:\\Users\\First Last\\p']);
  assert.deepEqual(splitWindowsCommandLine('a\\\\"b c" \\"q\\" x\\y ""'), ['a\\b c', '"q"', 'x\\y', '']);
});

test('isOrphanBrowser: Windows wants the exact --user-data-dir argument; macOS keeps its text match', () => {
  const p = 'C:\\Users\\First Last\\AppData\\Local\\Kora\\browser\\profiles\\b1';
  const exe = '"C:\\Users\\First Last\\AppData\\Local\\Kora\\browser\\chrome-headless-shell.exe"';
  assert.equal(isOrphanBrowser(`${exe} --headless "--user-data-dir=${p}" --remote-debugging-pipe`, p, 'win32'), true);
  const q = p.replace('First Last', 'FirstLast');
  assert.equal(isOrphanBrowser(`${exe} --user-data-dir=${q.toUpperCase()}`, q, 'win32'), true, 'unquoted, case-folded');
  assert.equal(isOrphanBrowser(`${exe} "--user-data-dir=${p}-2"`, p, 'win32'), false, 'another profile with the same prefix');
  assert.equal(isOrphanBrowser(`${exe} "--user-data-dir=${p}\\sub"`, p, 'win32'), false);
  assert.equal(isOrphanBrowser(`"C:\\x\\chrome.exe" "--user-data-dir=${p}"`, p, 'win32'), false, 'not the headless shell');
  assert.equal(isOrphanBrowser('/x/chrome-headless-shell --user-data-dir=/p/b1 --headless', '/p/b1', 'darwin'), true);
  assert.equal(isOrphanBrowser('/x/node --user-data-dir=/p/b1', '/p/b1', 'darwin'), false);
});

test('orphan sweep finds a leftover headless shell by its exact profile dir (ps on macOS, CIM on Windows)', async () => {
  const dir = path.join(tmp, 'reg-fake'); const bin = path.join(dir, `chrome-headless-shell${process.platform === 'win32' ? '.exe' : ''}`);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.linkSync(process.execPath, bin); } catch { fs.copyFileSync(process.execPath, bin); fs.chmodSync(bin, 0o755); }
  const profile = path.join(dir, 'profiles', 'b 1');
  const { spawn } = await import('node:child_process');
  const start = (p: string) => spawn(bin, ['-e', 'setTimeout(()=>{},30000)', '--', `--user-data-dir=${p}`], { stdio: 'ignore' });
  const ours = start(profile);
  const near = process.platform === 'win32' ? start(`${profile}-2`) : null;   // macOS keeps its looser text match
  const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
  try {
    await sleep(300);
    const reg: Record<string, unknown> = { [String(ours.pid)]: { profileDir: profile, bin, ownerPid: dead, startedAt: 1 } };
    if (near) reg[String(near.pid)] = { profileDir: profile, bin, ownerPid: dead, startedAt: 1 };
    fs.writeFileSync(path.join(dir, 'pids.json'), JSON.stringify(reg));
    const r = await sweepOrphans({ dir });
    assert.deepEqual(r.killed, [ours.pid]);
    assert.equal(pidAlive(ours.pid!), false, 'the leftover was stopped');
    if (near) assert.ok(pidAlive(near.pid!), 'a profile dir that only shares the prefix is not ours');
  } finally { try { ours.kill('SIGKILL'); } catch { /* gone */ } try { near?.kill('SIGKILL'); } catch { /* gone */ } }
});

// ---------------------------------------------------------------- live browser (one at a time)

const T = (r: BrowserToolResult) => r.text;
const refOf = (name: string, snap: string, role = '[a-z-]+') => (snap.match(new RegExp(`\\[(e\\d+) ${role} "${name}`)) || [])[1];

test('live: every tool, take-over gate, secrets, approvals, downloads, file://, stale refs, screencast', async (t) => {
  const bin = await findEngineBin();
  if (!bin) return t.skip(SKIP);
  const fx = await startFixture(); const B = fx.base;
  const profile = path.join(tmp, 'profile-a');
  const approvals: string[] = []; let decision = false;
  const host = new BlobBrowserHost({
    blobId: 'blob_test', profileDir: profile, bin, browserDir: path.join(tmp, 'reg-a'), idleReleaseMs: 1500, takeoverWaitMs: 2500, idleCloseMs: 0, settings: () => ({ allowLocalHosts: ['127.0.0.1'] }),
    requestApproval: async (r) => { approvals.push(r.summary); return decision; },
  });
  const call = (tool: string, args: Record<string, unknown> = {}) => runBrowserTool(host, tool, args);
  try {
    // launch + first navigate
    const t0 = performance.now();
    let r = await call('browser_navigate', { url: B + '/cinema' });
    const firstMs = Math.round(performance.now() - t0);
    const rss = await host.memoryMb();
    console.log(`[browser] engineStart=${host.stats.engineStartMs}ms cdpReady=${host.stats.cdpReadyMs}ms firstNavigate=${firstMs}ms rss=${rss}MB`);
    assert.match(T(r), /\[e\d+ link "7:00 PM"/);
    assert.match(T(r), /untrusted/, 'snapshot is labelled untrusted');

    // click link -> seats page; select; type; card is secret
    r = await call('browser_click', { ref: refOf('7:00 PM', T(r)) });
    assert.match(T(r), /Seats/); assert.match(T(r), /seats\?m=1/);
    let seats = T(r);
    r = await call('browser_select', { ref: refOf('Seats', seats), value: '2' }); assert.match(T(r), /selected "2"/);
    r = await call('browser_type', { ref: refOf('Email', seats), text: 'me@example.com' }); assert.match(T(r), /="me@example.com"/);
    const cc = seats.match(/\[(e\d+) secret-field/)?.[1] ?? seats.match(/\[(e\d+) textbox "Card/)?.[1];
    r = await call('browser_type', { ref: cc, text: '4111111111111111' }); assert.match(T(r), /DENIED/); assert.equal(r.isError, true);

    // outbound: denied -> nothing posted; model has no way to self-approve
    seats = T(await call('browser_snapshot'));
    r = await call('browser_click', { ref: refOf('Place order', seats) });
    assert.match(T(r), /DENIED/); assert.ok(!fx.hits.some((h) => h.startsWith('POST /order')), 'POST not sent');
    assert.equal(approvals.length, 1); assert.match(approvals[0], /Place order/);
    // Enter in a POST form field is gated too
    await call('browser_click', { ref: refOf('Email', T(await call('browser_snapshot'))) });
    r = await call('browser_press_key', { key: 'Enter' });
    assert.match(T(r), /DENIED/); assert.ok(!fx.hits.some((h) => h.startsWith('POST /order')));
    assert.equal(approvals.length, 2);
    // allowed approval -> the action really happens
    decision = true;
    r = await call('browser_click', { ref: refOf('Place order', T(await call('browser_snapshot'))) });
    assert.match(T(r), /ORDER PLACED/); assert.ok(fx.hits.some((h) => h.startsWith('POST /order')));
    assert.equal(approvals.length, 3); decision = false;

    // prompt injection text on a page cannot bypass the gate
    r = await call('browser_navigate', { url: B + '/inject' });
    assert.match(T(r), /untrusted/);
    r = await call('browser_click', { ref: refOf('Delete account', T(r)) });
    assert.match(T(r), /DENIED/); assert.equal(approvals.length, 4);

    // GET search form: no approval
    r = await call('browser_navigate', { url: B + '/cinema' });
    const n = approvals.length;
    r = await call('browser_type', { ref: refOf('Search movies', T(r), 'textbox'), text: 'dune', submit: true });
    assert.equal(approvals.length, n); assert.match(T(r), /Results for dune/);

    // stale ref after navigation is rejected, not misapplied
    r = await call('browser_navigate', { url: B + '/cinema' }); const oldRef = refOf('10:00 PM', T(r));
    await call('browser_navigate', { url: B + '/login' });
    r = await call('browser_click', { ref: oldRef }); assert.match(T(r), /older page|not found/); assert.equal(r.isError, true);

    // SPA hydration: refs from the navigate snapshot are valid (DOM-quiet settle)
    r = await call('browser_navigate', { url: B + '/spa' }); assert.match(T(r), /Ready/); assert.match(T(r), /Hydrated/);

    // extract + scroll + wait_for + back
    await call('browser_navigate', { url: B + '/cinema' });
    assert.match(T(await call('browser_extract', { kind: 'table' })), /Dune \| \$14/);
    assert.match(T(await call('browser_extract', { kind: 'links' })), /seats\?m=1/);
    assert.match(T(await call('browser_extract', { kind: 'text', selector: 'h1' })), /Showtimes/);
    assert.match(T(await call('browser_scroll', { direction: 'down', amount: 200 })), /url:/);
    assert.match(T(await call('browser_wait_for', { text: 'Rialto', timeout_ms: 2000 })), /found/);
    assert.equal((await call('browser_wait_for', { text: 'never-appears', timeout_ms: 400 })).isError, true);
    await call('browser_navigate', { url: B + '/login' });
    assert.match(T(await call('browser_back')), /Showtimes/);

    // file:// blocked (navigate + link), downloads denied and reported
    r = await call('browser_navigate', { url: 'file:///etc/hosts' }); assert.equal(r.isError, true);
    r = await call('browser_navigate', { url: B + '/cinema' });
    r = await call('browser_click', { ref: refOf('local file', T(r)) });
    assert.doesNotMatch(T(r), /localhost|127\.0\.0\.1\s+localhost/);
    r = await call('browser_navigate', { url: B + '/cinema' });
    r = await call('browser_click', { ref: refOf('Get brochure', T(r)) }); assert.match(T(r), /download denied/);

    // secrets: password field redacted; screenshot allowed while empty
    r = await call('browser_navigate', { url: B + '/login' }); assert.match(T(r), /secret-field/);
    const pw = T(r).match(/\[(e\d+) secret-field/)![1];
    r = await call('browser_screenshot'); assert.equal(r.image?.mimeType, 'image/jpeg'); assert.ok(r.image!.data.length > 500);

    // live view: frames only while a viewer is attached
    const frames: number[] = []; host.on('frame', (b) => frames.push(b.length));
    const detach = host.addViewer();
    await call('browser_click', { ref: pw });
    // user takes over and types a password with real key events
    for (const ch of 'hunter2') {
      await host.userInput({ t: 'key', type: 'keyDown', key: ch, code: 'Key', text: ch, vk: ch.toUpperCase().charCodeAt(0) });
      await host.userInput({ t: 'key', type: 'keyUp', key: ch, code: 'Key', vk: ch.toUpperCase().charCodeAt(0) });
    }
    assert.equal(host.controlState().controller, 'user');
    const w0 = Date.now(); r = await call('browser_snapshot');
    const waited = Date.now() - w0;
    assert.ok(waited > 800, `call waited for the user (${waited}ms)`);
    assert.match(T(r), /NOTE: The user controlled/); assert.equal(host.controlState().controller, 'agent');
    assert.doesNotMatch(T(r), /hunter2/);
    r = await call('browser_screenshot'); assert.match(T(r), /DENIED/); assert.equal(r.image, undefined);
    assert.doesNotMatch(T(await call('browser_extract', { kind: 'text' })), /hunter2/);
    await sleep(400); detach();
    assert.ok(frames.length >= 1, `screencast delivered frames (${frames.length})`);
    const before = frames.length; await call('browser_navigate', { url: B + '/cinema' }); await sleep(300);
    assert.equal(frames.length, before, 'no frames after the last viewer left');

    // USER_HAS_CONTROL when the user keeps driving
    host.idleReleaseMs = 60_000;
    await host.userInput({ t: 'mouse', type: 'mousePressed', x: 5, y: 5, button: 'left', buttons: 1, clickCount: 1 });
    const g0 = Date.now(); r = await call('browser_snapshot');
    assert.match(T(r), /USER_HAS_CONTROL/); assert.equal(r.isError, true); assert.ok(Date.now() - g0 >= 2400);
    host.handBack(); host.idleReleaseMs = 1500;
    assert.match(T(await call('browser_snapshot')), /NOTE: The user controlled/);

    // tabs
    r = await call('browser_tabs', { action: 'new', url: B + '/cookie' }); assert.match(T(r), /1\*/); assert.match(T(r), /cookie/);
    assert.match(T(await call('browser_tabs', { action: 'switch', index: 0 })), /0\*/);
    r = await call('browser_tabs', { action: 'close', index: 1 }); assert.doesNotMatch(T(r), /\n1/);
    assert.equal((await call('browser_tabs', { action: 'close' })).isError, true, 'last tab cannot be closed');

    // graceful close waits for exit
    const pid = host.pid!; assert.ok(pidAlive(pid));
    await call('browser_navigate', { url: B + '/setcookie' });
    await call('browser_navigate', { url: B + '/setsession' });
    await host.stop();
    assert.equal(pidAlive(pid), false, 'browser process exited before stop() resolved');
    assert.equal(host.isRunning, false);
  } finally { await host.stop().catch(() => {}); await fx.close(); }

  // cookie persistence: persistent AND session cookies survive close/reopen; the file is 0600
  const cookieFile = path.join(profile, 'kora-session-cookies.json');
  if (process.platform !== 'win32') assert.equal(fs.statSync(cookieFile).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(cookieFile, 'utf8'), /sess_only/);
  const fx2 = await startFixture();
  const h2 = new BlobBrowserHost({ blobId: 'blob_test', profileDir: profile, bin, browserDir: path.join(tmp, 'reg-a'), idleCloseMs: 900, settings: () => ({ allowLocalHosts: ['127.0.0.1'] }) });
  try {
    // (cookies are per-origin: the fixture port changed, so re-set them on the new origin via the old file only if same host.)
    // Chromium host cookies ignore the port, so 127.0.0.1 cookies apply to the new port too.
    const closed: string[] = []; h2.on('closed', (why) => closed.push(why));
    const t1 = performance.now();
    const r = await runBrowserTool(h2, 'browser_navigate', { url: fx2.base + '/cookie' });
    console.log(`[browser] restart+navigate=${Math.round(performance.now() - t1)}ms engineStart=${h2.stats.engineStartMs}ms cdpReady=${h2.stats.cdpReadyMs}ms`);
    assert.match(T(r), /blobsess=abc123/, 'persistent cookie survived');
    assert.match(T(r), /sess_only=xyz/, 'session cookie survived');
    // idle close, then lazy restart on the next call
    for (let i = 0; i < 40 && h2.isRunning; i++) await sleep(100);
    assert.equal(h2.isRunning, false, 'idle browser closed itself'); assert.deepEqual(closed, ['idle']);
    const again = await runBrowserTool(h2, 'browser_navigate', { url: fx2.base + '/cinema' });
    assert.match(T(again), /Showtimes/); assert.equal(h2.isRunning, true);
  } finally { await h2.stop().catch(() => {}); await fx2.close(); }
});

test('live: orphan sweep kills a browser left behind by a dead daemon, by recorded pid only', async (t) => {
  const bin = await findEngineBin();
  if (!bin) return t.skip(SKIP);
  const reg = path.join(tmp, 'reg-orphan'); const profile = path.join(tmp, 'profile-orphan');
  const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
  const eng = await launchEngine({ bin, profileDir: profile, registryDir: reg, ownerPid: dead });
  assert.ok(pidAlive(eng.pid));
  const res = await sweepOrphans({ dir: reg });
  assert.deepEqual(res.killed, [eng.pid]);
  await eng.exited;
  assert.equal(pidAlive(eng.pid), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(reg, 'pids.json'), 'utf8')), {});
  assert.equal(fs.existsSync(path.join(profile, 'SingletonLock')), false, 'stale profile lock cleared');
});

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
