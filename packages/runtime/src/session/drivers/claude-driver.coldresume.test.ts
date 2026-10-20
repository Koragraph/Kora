// B6 wired into ClaudeDriver.startSession: a thread resumed after its cache's hour continues from a masked COPY of its
// transcript (new session id, "context.trimmed" event); a warm one, a switch that is off, and any failure resume as before.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeDriver, type QueryFn } from './claude-driver';
import type { DriverDeps } from '../session-driver';
import type { ChatEvent } from '../events';
import { claudeSlug } from '../prune';
import { SID, thread } from '../prune.fixture';
import { resetLifecycleSettingsCache } from '../../util/lifecycle-settings';

process.env.KORA_INJECT_LOG = '0';
process.env.KORA_CACHE_WARM = 'off'; // keep-warm is on by default; these cases are about the trim, the last one turns it on
function setup(ageMs: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-cold-'));
  const cfg = path.join(dir, 'claude'); const cwd = path.join(dir, 'repo'); fs.mkdirSync(cwd, { recursive: true });
  const pdir = path.join(cfg, 'projects', claudeSlug(cwd)); fs.mkdirSync(pdir, { recursive: true });
  const file = path.join(pdir, `${SID}.jsonl`);
  fs.writeFileSync(file, thread(14).map((e) => JSON.stringify(e)).join('\n') + '\n');
  const t = new Date(Date.now() - ageMs); fs.utimesSync(file, t, t);
  let options: any;
  const iterator: any = { next: () => new Promise(() => {}), return: async () => ({ value: undefined, done: true }), [Symbol.asyncIterator]() { return this; } };
  const queryFn: QueryFn = (p: any) => { options = p.options; return iterator; };
  const deps: DriverDeps = {
    graphCall: async () => ({ text: '', data: null, ms: 1 }), graphStatus: async () => ({ indexed: false }),
    spawnWorker: async () => ({ id: 'p', agent: 'claude', account: null }), spawnEnv: () => ({ CLAUDE_CONFIG_DIR: cfg }), appendSystemPrompt: () => undefined,
    isFolderTrusted: () => true,
  };
  const driver = new ClaudeDriver(deps, queryFn);
  const events: ChatEvent[] = []; driver.streamEvents((e) => events.push(e));
  return { dir, cwd, file, driver, events, options: () => options };
}
let n = 0; const tid = () => `CR-${process.pid}-${Date.now()}-${++n}`;

test('cold resume: continues from a masked copy and says so; the original stays', async () => {
  const s = setup(3 * 3600_000);
  const before = fs.readFileSync(s.file, 'utf8');
  const threadId = tid();
  await s.driver.startSession({ threadId, agent: 'claude', cwd: s.cwd, account: null, resume: SID });
  assert.notEqual(s.options().resume, SID);
  assert.match(s.options().resume, /^[0-9a-f-]{36}$/);
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
  assert.ok(fs.existsSync(path.join(path.dirname(s.file), `${s.options().resume}.jsonl`)));
  const ev = s.events.find((e) => e.type === 'context.trimmed') as any;
  assert.ok(ev && ev.stubbed === 8 && ev.tokensSaved > 5000, JSON.stringify(ev));
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('a warm cache (transcript written 10 minutes ago) resumes the original, silently', async () => {
  const s = setup(10 * 60_000);
  await s.driver.startSession({ threadId: tid(), agent: 'claude', cwd: s.cwd, account: null, resume: SID });
  assert.equal(s.options().resume, SID);
  assert.equal(s.events.some((e) => e.type === 'context.trimmed'), false);
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('the switch off, or a missing transcript, resumes the original', async () => {
  const s = setup(3 * 3600_000);
  process.env.KORA_COLD_RESUME_MASK = '0'; resetLifecycleSettingsCache();
  await s.driver.startSession({ threadId: tid(), agent: 'claude', cwd: s.cwd, account: null, resume: SID });
  assert.equal(s.options().resume, SID);
  delete process.env.KORA_COLD_RESUME_MASK; resetLifecycleSettingsCache();
  const s2 = setup(3 * 3600_000);
  await s2.driver.startSession({ threadId: tid(), agent: 'claude', cwd: s2.cwd, account: null, resume: 'no-such-session-id-0' });
  assert.equal(s2.options().resume, 'no-such-session-id-0');
  fs.rmSync(s.dir, { recursive: true, force: true }); fs.rmSync(s2.dir, { recursive: true, force: true });
});

test('a new (not resumed) thread is never touched', async () => {
  const s = setup(3 * 3600_000);
  await s.driver.startSession({ threadId: tid(), agent: 'claude', cwd: s.cwd, account: null });
  assert.equal(s.options().resume, undefined);
  fs.rmSync(s.dir, { recursive: true, force: true });
});

// Keep-warm on yields the trim only to a session the proxy actually warms: with no warm URL (own gateway, proxy down)
// nothing keeps the cache alive, so a cold resume is trimmed as with warming off.
test('keep-warm on: a warmed session resumes the original inside the warm horizon; past it, or unwarmed, it is trimmed', async () => {
  const { cacheWarm } = await import('../../cachewarm/manager');
  const cw = cacheWarm(); const orig = cw.baseUrl;
  process.env.KORA_CACHE_WARM = 'on';
  try {
    cw.baseUrl = async () => 'http://127.0.0.1:9/warm';
    const warm = setup(2 * 3600_000);
    await warm.driver.startSession({ threadId: tid(), agent: 'claude', cwd: warm.cwd, account: null, resume: SID });
    assert.equal(warm.options().resume, SID);
    assert.equal(warm.events.some((e) => e.type === 'context.trimmed'), false);

    // The last warm goes out ~2 h after the last request and lives an hour: a 4-hour-old session is cold even when warmed.
    const pastHorizon = setup(4 * 3600_000);
    await pastHorizon.driver.startSession({ threadId: tid(), agent: 'claude', cwd: pastHorizon.cwd, account: null, resume: SID });
    assert.notEqual(pastHorizon.options().resume, SID);
    assert.ok(pastHorizon.events.some((e) => e.type === 'context.trimmed'));

    cw.baseUrl = async () => null;
    const unwarmed = setup(2 * 3600_000);
    await unwarmed.driver.startSession({ threadId: tid(), agent: 'claude', cwd: unwarmed.cwd, account: null, resume: SID });
    assert.notEqual(unwarmed.options().resume, SID);
    assert.ok(unwarmed.events.some((e) => e.type === 'context.trimmed'));
    for (const s of [warm, pastHorizon, unwarmed]) fs.rmSync(s.dir, { recursive: true, force: true });
  } finally { cw.baseUrl = orig; process.env.KORA_CACHE_WARM = 'off'; }
});
