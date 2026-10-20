// Phase 6.4 hardening: private-network guard (literals, names, DNS rebinding, redirects), the network POST backstop,
// cross-origin iframes with refs, the download policy, snapshot tuning and the doctor. Pure units always run; live tests
// drive ONE real headless Chromium at a time against local fixtures and are skipped when the engine is not installed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlobBrowserHost, safeFileName, type BlobBrowserSettings } from './host';
import { findInstalledEngine, pinnedEngine } from './engine';
import { allowlistMatches, hostPortOf, isPrivateIp, isPrivateName, makeNetGuard } from './netpolicy';
import { classifyMutation, looksSensitive } from './backstop';
import { runBrowserTool } from './tools';
import { browserDoctor } from './doctor';
import { startFixture } from './browser.fixture';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khard-'));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function findEngineBin(): Promise<string | null> {
  const real = process.env.KORA_TEST_REAL_HOME || os.homedir();
  const dirs = [process.env.KORA_BROWSER_DIR, path.join(real, 'Library/Application Support/Kora/browser'), path.join(real, 'Library/Application Support/Kora/browser-Dev')].filter(Boolean) as string[];
  for (const d of dirs) { const e = await findInstalledEngine(d); if (e) return e.bin; }
  return null;
}
const SKIP = 'blob browser engine not installed (set KORA_BROWSER_DIR): skipping live hardening tests';
const refOf = (name: string, snap: string, role = '[a-z-]+') => (snap.match(new RegExp(`\\[((?:f\\d+)?e\\d+) ${role} "${name}`)) || [])[1];

// ---------------------------------------------------------------- pure units

test('private addresses: every loopback / private / link-local / mapped form is private, public ones are not', () => {
  for (const ip of ['127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1',
    '::1', '::', '[::1]', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::1', '::127.0.0.1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.63.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2001:4860:4860::8888']) assert.equal(isPrivateIp(ip), false, ip);
  assert.equal(isPrivateIp('example.com'), false, 'a name is not an IP');
});

test('private names: localhost, *.local, single-label hosts; public names pass', () => {
  for (const n of ['localhost', 'LOCALHOST', 'foo.localhost', 'printer.local', 'nas', 'router.lan', 'x.internal', 'host.home.arpa', 'localhost.']) assert.equal(isPrivateName(n), true, n);
  for (const n of ['example.com', 'api.cinema.co.uk', 'a.b.c']) assert.equal(isPrivateName(n), false, n);
});

test('URL host forms that smuggle an address are normalised by the URL parser, then caught', () => {
  for (const u of ['http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[::ffff:127.0.0.1]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://LOCALHOST./']) {
    const hp = hostPortOf(u)!; assert.ok(isPrivateIp(hp.host) || isPrivateName(hp.host), `${u} -> ${hp.host}`);
  }
});

test('allowlist entries: exact, port, wildcard; a port-less entry covers every port', () => {
  const hp = (u: string) => hostPortOf(u)!;
  assert.equal(allowlistMatches(['localhost'], hp('http://localhost:5173/')), true);
  assert.equal(allowlistMatches(['localhost:5173'], hp('http://localhost:5173/')), true);
  assert.equal(allowlistMatches(['localhost:5173'], hp('http://localhost:3000/')), false);
  assert.equal(allowlistMatches(['*.test'], hp('http://app.test/')), true);
  assert.equal(allowlistMatches(['*.test'], hp('http://evil.com/')), false);
  assert.equal(allowlistMatches(['[::1]:8080'], hp('http://[::1]:8080/')), true);
  assert.equal(allowlistMatches(['127.0.0.1'], hp('http://127.0.0.2/')), false);
  assert.equal(allowlistMatches([], hp('http://localhost/')), false);
});

test('net guard: literals, names, DNS answers, redirect targets, public-to-local, and DNS rebinding after the check', async () => {
  const dnsTable: Record<string, string[]> = { 'good.example': ['93.184.216.34'], 'evil.example': ['127.0.0.1'], 'meta.example': ['169.254.169.254'], 'dual.example': ['93.184.216.34', '10.0.0.5'], 'v6.example': ['::1'] };
  let allow: string[] = [];
  const g = makeNetGuard({ allowlist: () => allow, resolve: async (h) => { if (!dnsTable[h]) throw new Error('NXDOMAIN'); return dnsTable[h]; } });
  assert.equal((await g.check('https://good.example/x')).ok, true);
  for (const u of ['http://127.0.0.1:8080/', 'http://localhost/', 'http://[::1]/', 'http://10.0.0.1/', 'http://192.168.0.1/admin', 'http://169.254.169.254/latest/meta-data', 'http://printer.local/', 'http://evil.example/', 'http://meta.example/', 'http://dual.example/', 'http://v6.example/', 'http://2130706433/'])
    assert.equal((await g.check(u)).ok, false, u);
  assert.match((await g.check('http://evil.example/') as any).reason, /resolves to the private address 127\.0\.0\.1/);
  assert.equal((await g.check('http://nxdomain.example/')).ok, true, 'a name that does not resolve just fails to load; it is not a private address');
  assert.equal((await g.check('file:///etc/hosts')).ok, false);
  assert.equal((await g.check('ftp://x.example/')).ok, false);
  assert.equal((await g.check('data:text/plain,hi')).ok, true);
  // allowlist opens named local hosts only
  allow = ['localhost:5173', 'evil.example'];
  assert.equal((await g.check('http://localhost:5173/')).ok, true);
  assert.equal((await g.check('http://localhost:3000/')).ok, false);
  assert.equal((await g.check('http://127.0.0.1:5173/')).ok, false, 'a different host spelling is not allowed');
  assert.equal((await g.check('http://evil.example/')).ok, true);
  // a PUBLIC page cannot script its way into an allowlisted dev server; an agent navigation can
  const sub = await g.check('http://localhost:5173/api', { fromUrl: 'https://good.example/page' });
  assert.equal(sub.ok, false); assert.equal((sub as any).code, 'public-to-local');
  assert.equal((await g.check('http://localhost:5173/api', { fromUrl: 'http://localhost:5173/' })).ok, true);
  assert.equal((await g.check('http://localhost:5173/', { fromUrl: 'https://good.example/', document: true })).ok, true);
  // DNS rebinding: public at check time, private at connect time -> the response tripwire catches it
  allow = [];
  assert.equal((await g.check('https://good.example/')).ok, true);
  assert.equal(g.checkRemoteIp('https://good.example/', '93.184.216.34').ok, true);
  const trip = g.checkRemoteIp('https://good.example/', '127.0.0.1');
  assert.equal(trip.ok, false); assert.match((trip as any).reason, /DNS changed/);
  assert.equal(g.checkRemoteIp('https://good.example/', '::ffff:10.0.0.1').ok, false);
  assert.equal(g.checkRemoteIp('https://good.example/', undefined).ok, true);
  // the DNS answer cache: a name that flips to private is re-checked once the short TTL passes
  const flip: { ips: string[] } = { ips: ['93.184.216.34'] };
  const g2 = makeNetGuard({ resolve: async () => flip.ips, dnsTtlMs: 30 });
  assert.equal((await g2.check('http://flip.example/')).ok, true);
  flip.ips = ['10.0.0.9'];
  assert.equal((await g2.check('http://flip.example/')).ok, true, 'cached answer inside the TTL');
  await sleep(50);
  assert.equal((await g2.check('http://flip.example/')).ok, false, 'rebound answer is caught after the TTL');
});

test('POST backstop classifier: flagged action or checkout-looking request is held; GET, telemetry, user-driven and approved are not', () => {
  const now = 1_000_000;
  const ctx = (level: 'none' | 'soft' | 'hard', approved = false, at = now - 500) => ({ at, tool: 'browser_click', level, approved });
  const req = (url: string, method = 'POST', postData?: string) => ({ method, url, pageUrl: 'https://cinema.example/seats', postData });
  const g = (r: ReturnType<typeof req>, c: ReturnType<typeof ctx> | null, extra: { userDriving?: boolean } = {}) => classifyMutation(r, c, { now, ...extra });
  // launch QA 2026-10-10: only a request that follows a FLAGGED action is held. An unflagged click (a showtime, a seat, a filter) never is.
  assert.equal(g(req('https://cinema.example/api/book'), ctx('none')).gate, false, 'unflagged click -> POST /api/book (seat / showtime selection)');
  assert.equal(g(req('https://cinema.example/graphql', 'POST', '{"query":"...","amount":2}'), ctx('none')).gate, false, 'first-party GraphQL with an "amount" field after a plain click');
  assert.equal(g(req('https://cinema.example/graphql', 'POST', '{"amount":2}'), ctx('soft')).gate, false, 'soft click, innocuous path, body mentions amount');
  assert.equal(g(req('https://cinema.example/api/book'), ctx('soft')).gate, true, 'soft click then a booking endpoint');
  assert.equal(g(req('https://pay.stripe.com/v1/charges'), ctx('soft')).gate, true, 'third-party payment after a flagged click');
  assert.equal(g(req('https://cinema.example/api/hold', 'POST', '{"cardNumber":"4111"}'), ctx('hard')).gate, true, 'hard action: any mutating request');
  assert.equal(g(req('https://cinema.example/api/prefs'), ctx('hard')).gate, true, 'hard-flagged action: any mutating request');
  assert.equal(g(req('https://cinema.example/api/prefs'), ctx('none')).gate, false, 'harmless same-origin POST after a plain click');
  assert.equal(g(req('https://cinema.example/api/book', 'GET'), ctx('none')).gate, false, 'GET is never blocked');
  assert.equal(g(req('https://cinema.example/api/book', 'PUT'), ctx('hard')).gate, true);
  assert.equal(g(req('https://cinema.example/api/book', 'DELETE'), ctx('soft')).gate, true);
  assert.equal(g(req('https://www.google-analytics.com/collect'), ctx('soft')).gate, false, 'telemetry');
  assert.equal(g(req('https://cinema.example/api/book'), null).gate, false, 'no agent action: the page doing its own thing');
  assert.equal(g(req('https://cinema.example/api/book'), ctx('none', false, now - 20_000)).gate, false, 'outside the window');
  assert.equal(g(req('https://cinema.example/api/book'), ctx('none'), { userDriving: true }).gate, false, 'the user clicked: their consent');
  assert.equal(g(req('https://cinema.example/api/book'), ctx('hard', true)).gate, false, 'the user approved this action');
  assert.equal(g(req('https://cinema.example/api/book'), ctx('hard', false)).gate, true);
  // launch QA: an ad-exchange POST carrying "amount"/"expir" fields aborted the answer. Third-party beacons never gate.
  assert.equal(g(req('https://pixel-us-east.rubiconproject.com/exchange/sync', 'POST', 'amount=3&expires=1'), ctx('soft')).gate, false, 'ad beacon');
  assert.equal(g(req('https://ads.example-cdn.com/v2/x', 'POST', '{"amount":5}'), ctx('hard', false)).gate, false, 'any third-party non-payment host');
  assert.equal(g({ ...req('https://cinema.example/t'), resourceType: 'Ping' } as ReturnType<typeof req>, ctx('soft')).gate, false, 'sendBeacon / ping');
  assert.ok(looksSensitive('https://x.example/account/password'));
  assert.equal(looksSensitive('https://x.example/api/search'), null);
});

test('download file names are made safe', () => {
  assert.equal(safeFileName('../../evil name.pdf'), 'evil name.pdf');
  assert.equal(safeFileName('..\\..\\x.exe'), 'x.exe');
  assert.equal(safeFileName('.hidden'), '_hidden');
  assert.equal(safeFileName(''), 'download');
  assert.ok(safeFileName('a'.repeat(500)).length <= 120);
  assert.equal(safeFileName('bad\u0000name?.txt'), 'bad_name_.txt');
});

test('doctor: reports a missing engine without throwing or downloading', async () => {
  const r = await browserDoctor({ dir: path.join(tmp, 'no-engine') });
  assert.equal(r.installed, false); assert.equal(r.ok, false);
  if (!pinnedEngine()) assert.match(r.checks.find((c) => c.name === 'platform')!.detail, /not available/); // no pinned build yet (Windows)
  else assert.match(r.checks.find((c) => c.name === 'engine installed')!.detail, /not installed/);
  assert.deepEqual(fs.existsSync(path.join(tmp, 'no-engine')), false, 'nothing was created or downloaded');
});

// ---------------------------------------------------------------- live

async function mkHost(bin: string, name: string, o: { settings?: () => Partial<BlobBrowserSettings>; approve?: (summary: string) => boolean | Promise<boolean>; resolve?: (h: string) => Promise<string[]>; extraArgs?: string[]; downloadsDir?: string; backstopWindowMs?: number } = {}) {
  const approvals: string[] = [];
  const host = new BlobBrowserHost({
    blobId: `blob_${name}`, profileDir: path.join(tmp, `profile-${name}`), bin, browserDir: path.join(tmp, `reg-${name}`), idleCloseMs: 0, idleReleaseMs: 1500, takeoverWaitMs: 1500,
    settings: o.settings, resolve: o.resolve, extraArgs: o.extraArgs, downloadsDir: o.downloadsDir, backstopWindowMs: o.backstopWindowMs,
    requestApproval: async (r) => { approvals.push(r.summary); return o.approve ? o.approve(r.summary) : false; },
  });
  return { host, approvals, call: (tool: string, args: Record<string, unknown> = {}) => runBrowserTool(host, tool, args) };
}

test('live: private network is blocked by default, allowlisted per host, and redirects, DNS names and rebinding cannot get around it', async (t) => {
  const bin = await findEngineBin(); if (!bin) return t.skip(SKIP);
  const A = await startFixture(); const B = await startFixture();
  const PUB = '93.184.216.34';
  let rebindCalls = 0;
  const resolve = async (h: string) => {
    if (h === 'evil.example') return ['127.0.0.1'];
    if (h === 'rebind.example') return rebindCalls++ === 0 ? [PUB] : ['127.0.0.1'];
    throw new Error('NXDOMAIN ' + h);
  };
  let allow: string[] = [];
  const { host, call } = await mkHost(bin, 'net', { settings: () => ({ allowLocalHosts: allow }), resolve, extraArgs: ['--host-resolver-rules=MAP evil.example 127.0.0.1, MAP rebind.example 127.0.0.1'] });
  try {
    // 1. default: nothing local opens, and nothing reaches the server
    let r = await call('browser_navigate', { url: A.base + '/cinema' });
    assert.equal(r.isError, true); assert.match(r.text, /BLOCKED: .*loopback\/private-network address/); assert.match(r.text, /allow that host/);
    assert.equal(A.hits.length, 0, 'the request never left the browser');
    for (const u of ['http://localhost:' + A.port + '/cinema', 'http://[::1]:' + A.port + '/', 'http://2130706433:' + A.port + '/', 'http://printer.local/', 'http://169.254.169.254/latest/meta-data/']) {
      r = await call('browser_navigate', { url: u }); assert.equal(r.isError, true, u); assert.match(r.text, /BLOCKED/, u);
    }
    // 2. a public-looking name that resolves to loopback
    r = await call('browser_navigate', { url: `http://evil.example:${A.port}/cinema` });
    assert.equal(r.isError, true); assert.match(r.text, /resolves to the private address 127\.0\.0\.1/);
    assert.equal(A.hits.length, 0);
    // 3. allowlisted host opens; a redirect hop to another local port is judged on its own and blocked
    allow = ['127.0.0.1:' + A.port];
    r = await call('browser_navigate', { url: A.base + '/cinema' });
    assert.notEqual(r.isError, true); assert.match(r.text, /Showtimes/);
    r = await call('browser_navigate', { url: `${A.base}/redirect?to=${encodeURIComponent(B.base + '/cinema')}` });
    assert.equal(r.isError, true); assert.match(r.text, /BLOCKED/);
    assert.equal(B.hits.length, 0, 'the redirect target never saw a request');
    r = await call('browser_navigate', { url: `${A.base}/redirect?to=${encodeURIComponent('http://evil.example:' + A.port + '/cinema')}` });
    assert.equal(r.isError, true); assert.match(r.text, /BLOCKED/);
    // 4. subresources: a page on the allowed host that pulls from a non-allowed local port is cut
    allow = ['127.0.0.1:' + A.port];
    // 5. DNS rebinding: the name is public when we check it, loopback when Chrome connects -> tripwire
    allow = [];
    r = await call('browser_navigate', { url: `http://rebind.example:${A.port}/cinema` });
    assert.equal(r.isError, true, r.text); assert.match(r.text, /BLOCKED/); assert.match(r.text, /DNS changed|private address/);
    const tabs = await call('browser_tabs'); assert.match(tabs.text, /about:blank/, 'the page was torn down');
    r = await call('browser_snapshot'); assert.doesNotMatch(r.text, /Showtimes/, 'rebound content never reaches the agent');
    // 6. editing the allowlist applies without restarting the browser
    allow = ['127.0.0.1']; await host.settingsChanged();
    r = await call('browser_navigate', { url: B.base + '/cinema' });
    assert.notEqual(r.isError, true); assert.match(r.text, /Showtimes/);
  } finally { await host.stop().catch(() => {}); await A.close(); await B.close(); }
});

test('live: network POST backstop holds a fetch() POST from a flagged div button until approved; selection, GET and telemetry pass', async (t) => {
  const bin = await findEngineBin(); if (!bin) return t.skip(SKIP);
  const fx = await startFixture(); let decision = false;
  const { host, approvals, call } = await mkHost(bin, 'post', { settings: () => ({ allowLocalHosts: ['127.0.0.1'] }), approve: () => decision, backstopWindowMs: 1500 });
  try {
    // booking flow (launch QA 2026-10-10): picking seats posts to the server but is not a commit -> no approval
    let r = await call('browser_navigate', { url: fx.base + '/seatmap' });
    for (const seat of ['Seat A1', 'Seat A2']) { r = await call('browser_click', { ref: refOf(seat, (await call('browser_snapshot')).text) }); await sleep(300); }
    r = await call('browser_click', { ref: refOf('View cart', (await call('browser_snapshot')).text) }); await sleep(200);
    assert.equal(approvals.length, 0, 'seat selection and cart view are not gated');
    assert.ok(fx.hits.some((h) => h.startsWith('POST /api/hold')), 'the seat POSTs went through');
    // Place order is the commit: the click classifier flags it and its POST waits
    r = await call('browser_navigate', { url: fx.base + '/seatmap' });
    r = await call('browser_click', { ref: refOf('Place order', r.text) });
    await sleep(400);
    assert.equal(approvals.length, 1, 'Place order asks'); assert.match(approvals[0], /Place order|POST 127\.0\.0\.1\/api\/book/);
    assert.ok(!fx.hits.some((h) => h.startsWith('POST /api/book')), 'denied: the POST never reached the server');
    assert.match(r.text, /DENIED/);
    // a plain "Continue" div that POSTs after no flagged action is not held
    const n0 = approvals.length;
    r = await call('browser_navigate', { url: fx.base + '/divbook' });
    r = await call('browser_click', { ref: refOf('Continue', r.text) }); await sleep(400);
    assert.equal(approvals.length, n0, 'unflagged click: not gated');
    // approved: Place order goes through
    decision = true;
    r = await call('browser_navigate', { url: fx.base + '/seatmap' });
    r = await call('browser_click', { ref: refOf('Place order', r.text) });
    await sleep(800);
    assert.ok(fx.hits.some((h) => h.startsWith('POST /api/book')), 'approved: the POST was sent');
    assert.ok(approvals.length > n0);
    decision = false;
    // telemetry-looking POST and a plain GET navigation never ask
    const n = approvals.length;
    await call('browser_navigate', { url: fx.base + '/divbook' });
    await call('browser_click', { ref: refOf('Track', (await call('browser_snapshot')).text) }); await sleep(400);
    assert.equal(approvals.length, n, 'telemetry POST is not gated');
    assert.ok(fx.hits.some((h) => h.startsWith('POST /api/track')));
    await call('browser_navigate', { url: fx.base + '/cinema' });
    assert.equal(approvals.length, n, 'GET never asks');
    // a POST the PAGE makes by itself (no agent action in the window) is not the agent's doing
    await call('browser_navigate', { url: fx.base + '/divbook' });
    await sleep(1800);
    const before = approvals.length;
    await host.rawCdp.send('Runtime.evaluate', { expression: "fetch('/api/book',{method:'POST'})" }, host.tab.sessionId);
    await sleep(500);
    assert.equal(approvals.length, before, 'no recent agent action: not gated');
  } finally { await host.stop().catch(() => {}); await fx.close(); }
});

test('live: cross-origin iframes (same-process and out-of-process) appear in the snapshot with usable refs; secrets stay hidden', async (t) => {
  const bin = await findEngineBin(); if (!bin) return t.skip(SKIP);
  const P = await startFixture(); const F = await startFixture();
  const { host, approvals, call } = await mkHost(bin, 'frames', { settings: () => ({ allowLocalHosts: ['127.0.0.1', 'localhost'] }) });
  try {
    const frames = `http://localhost:${F.port},http://127.0.0.1:${F.port}`;
    let r = await call('browser_navigate', { url: `${P.base}/frames?f=${encodeURIComponent(frames)}` });
    assert.notEqual(r.isError, true, r.text);
    assert.match(r.text, /\[e\d+ button "Parent button"/);
    assert.match(r.text, /\[iframe localhost:\d+/); assert.match(r.text, /\[iframe 127\.0\.0\.1:\d+/);
    const fb = [...r.text.matchAll(/\[(f\d+e\d+) button "Frame button"/g)].map((m) => m[1]);
    assert.equal(fb.length, 2, 'both frames expose their button\n' + r.text);
    assert.match(r.text, /f\d+e\d+ secret-field|\(secret/, 'password inside the frame is redacted');
    assert.equal(new Set(fb).size, 2, 'refs are unique across frames');
    // click in each frame: coordinates are translated by the iframe's box
    for (const ref of fb) {
      const before = F.hits.filter((h) => h.startsWith('GET /clicked')).length;
      const c = await call('browser_click', { ref }); assert.notEqual(c.isError, true, c.text);
      await sleep(300);
      assert.equal(F.hits.filter((h) => h.startsWith('GET /clicked')).length, before + 1, `click in frame ${ref} reached the page inside`);
      r = await call('browser_snapshot');
    }
    // typing into a frame textbox
    const note = [...r.text.matchAll(/\[(f\d+e\d+) textbox "Note"/g)][0]?.[1]; assert.ok(note, r.text);
    r = await call('browser_type', { ref: note, text: 'hello frame' }); assert.notEqual(r.isError, true, r.text);
    assert.match(r.text, /="hello frame"/);
    // a secret field in a frame is refused, and focusing it blocks screenshots
    const pw = r.text.match(/\[(f\d+e\d+) secret-field/)?.[1]; assert.ok(pw, r.text);
    assert.match((await call('browser_type', { ref: pw, text: 'x' })).text, /DENIED/);
    await call('browser_click', { ref: pw });
    assert.match((await call('browser_screenshot')).text, /DENIED/, 'screenshot refused while a secret field in an iframe is focused');
    assert.equal(approvals.length, 0);
    // after navigation the old frame refs are gone
    await call('browser_navigate', { url: P.base + '/cinema' });
    assert.equal((await call('browser_click', { ref: fb[0] })).isError, true);
  } finally { await host.stop().catch(() => {}); await P.close(); await F.close(); }
});

test('live: downloads are denied by default and saved into downloads/ only when the blob opted in', async (t) => {
  const bin = await findEngineBin(); if (!bin) return t.skip(SKIP);
  const fx = await startFixture();
  const dir = path.join(tmp, 'blob-ws', 'downloads');
  let allowDownloads = false;
  const { host, call } = await mkHost(bin, 'dl', { settings: () => ({ allowLocalHosts: ['127.0.0.1'], allowDownloads }), downloadsDir: dir });
  try {
    let r = await call('browser_navigate', { url: fx.base + '/dlpage' });
    r = await call('browser_click', { ref: refOf('Get PDF', r.text) }); await sleep(500);
    assert.match(r.text, /download denied/); assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'nothing saved by default');
    allowDownloads = true; await host.settingsChanged();
    r = await call('browser_navigate', { url: fx.base + '/dlpage' });
    r = await call('browser_click', { ref: refOf('Get PDF', r.text) }); let clickText = r.text;
    for (let i = 0; i < 30 && !(fs.existsSync(dir) && fs.readdirSync(dir).length); i++) await sleep(100);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.equal(files.length, 1, 'one file: ' + files.join(','));
    const saved = path.join(dir, files[0]);
    assert.match(files[0], /evil name\.pdf$/); assert.ok(!files[0].includes('/'), 'a traversal in the suggested name did nothing');
    if (process.platform !== 'win32') assert.equal(fs.statSync(saved).size, 1000); assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
    assert.match(clickText + (await call('browser_snapshot')).text, /downloaded .*evil name\.pdf \(1000 bytes\)/);
    // installers are refused even when downloads are on
    r = await call('browser_navigate', { url: fx.base + '/dlpage' });
    clickText = (await call('browser_click', { ref: refOf('Get installer', r.text) })).text; await sleep(600);
    assert.ok(!fs.existsSync(path.join(dir, 'setup.pkg')));
    assert.match(clickText + (await call('browser_snapshot')).text, /download refused: setup\.pkg/);
    // switching it off again denies again
    allowDownloads = false; await host.settingsChanged();
    r = await call('browser_navigate', { url: fx.base + '/dlpage' });
    r = await call('browser_click', { ref: refOf('Get brochure', r.text) }); await sleep(500);
    assert.match(r.text, /download denied/); assert.ok(!fs.existsSync(path.join(dir, 'brochure.bin')));
  } finally { await host.stop().catch(() => {}); await fx.close(); }
});

test('live: snapshot collapses long repetitive lists, keeps refs stable, and full_lists shows everything', async (t) => {
  const bin = await findEngineBin(); if (!bin) return t.skip(SKIP);
  const fx = await startFixture();
  const { host, call } = await mkHost(bin, 'snap', { settings: () => ({ allowLocalHosts: ['127.0.0.1'] }) });
  try {
    const small = await call('browser_navigate', { url: fx.base + '/list' });
    assert.match(small.text, /Result item number 0/); assert.match(small.text, /Result item number 7/);
    assert.doesNotMatch(small.text, /Result item number 20/); assert.match(small.text, /more similar rows omitted/);
    assert.match(small.text, /\[e\d+ button "After the list"/);
    const ref0 = refOf('Result item number 0', small.text); assert.ok(ref0);
    const full = await call('browser_snapshot', { full_lists: true });
    assert.match(full.text, /Result item number 39/); assert.doesNotMatch(full.text, /more similar rows omitted/);
    assert.equal(refOf('Result item number 0', full.text), ref0, 'refs are stable across snapshots');
    assert.ok(full.text.length > small.text.length * 2, `collapsed ${small.text.length} vs full ${full.text.length}`);
    // links print only where they leave the site
    assert.doesNotMatch(small.text, /→\/item/);
    assert.match((await call('browser_snapshot', { links: true, full_lists: true })).text, /→\/item\/0/);
    // the cap
    const capped = await call('browser_snapshot', { full_lists: true, max_chars: 600 });
    assert.match(capped.text, /truncated at 600 chars \(~\d+ tokens\)/);
  } finally { await host.stop().catch(() => {}); await fx.close(); }
});

test('live: doctor launches the engine and reports its version', async (t) => {
  const bin = await findEngineBin(); if (!bin) return t.skip(SKIP);
  const r = await browserDoctor({ bin });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.match(r.checks.find((c) => c.name === 'launch smoke')!.detail, /started in \d+ ms/);
});

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('Clear browser data: closes the blob\'s browser and deletes only its browser-profile folder (pl8 S2-2)', async () => {
  const { BlobBrowserManager } = await import('./manager');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclear-'));
  const prof = path.join(root, 'blob_x', 'browser-profile');
  fs.mkdirSync(path.join(prof, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(prof, 'Default', 'Cookies'), 'session=1');
  fs.writeFileSync(path.join(root, 'blob_x', 'SOUL.md'), 'keep me');
  const m = new BlobBrowserManager({ profileDirFor: (id) => path.join(root, id, 'browser-profile') });
  assert.deepEqual(await m.clearData('blob_x'), { cleared: true });
  assert.equal(fs.existsSync(prof), false);
  assert.equal(fs.readFileSync(path.join(root, 'blob_x', 'SOUL.md'), 'utf8'), 'keep me');
  assert.deepEqual(await m.clearData('blob_x'), { cleared: false });
  const bad = new BlobBrowserManager({ profileDirFor: (id) => path.join(root, id) });
  await assert.rejects(() => bad.clearData('blob_x'), /refusing/);
  assert.equal(fs.existsSync(path.join(root, 'blob_x', 'SOUL.md')), true);
});
