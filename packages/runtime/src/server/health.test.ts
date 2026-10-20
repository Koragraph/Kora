// Health checks (`kora doctor`, Settings → Diagnostics): every row, its status and its fix line, through the seams.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runHealthChecks, formatHealthReport, agentSummary, probeLocalModelServers, type HealthDeps, type RunResult, type HealthCheckId } from './health';
import type { PaneGraphInfo, SwarmStatus } from '../protocol/types';

const posixOnly = { skip: process.platform === 'win32' ? "POSIX path fixtures (/Users/dev)" : false };

const HOME = '/Users/dev';
const GB = 1024 ** 3;

function swarmStatus(o: Partial<SwarmStatus> = {}): SwarmStatus {
  return {
    ready: true, blockers: [],
    opencode: { installed: true, path: `${HOME}/.kora/tools/opencode/current/opencode`, source: 'kora', version: '1.18.32', minVersion: '1.18.0', versionOk: true, onDaemonPath: false },
    install: { operationId: null, phase: 'idle', downloadedBytes: 0, totalBytes: null, version: null, installedVersion: null, message: null },
    consent: { requiredVersion: 1, acceptedVersion: 1, acceptedAt: 1 },
    providers: [{ provider: 'zen', enabled: true, keyRequired: false, hasKey: false, keySource: null, keyHint: null, lastTest: { ok: true, outcome: 'ok', message: null, freeModels: ['opencode/big-pickle'], latencyMs: 80, testedAt: 1, limits: null }, limits: null }],
    models: { available: [{ id: 'opencode/big-pickle', provider: 'zen', label: 'big-pickle', rank: 0, maxConcurrent: 2 }], cooling: [] },
    preferences: { providerOrder: ['zen', 'openrouter', 'cerebras'], defaultModel: null, maxWorkers: 4 },
    keyStorage: 'file', checkedAt: 1,
    ...o,
  };
}

const graphInfo = (o: Partial<PaneGraphInfo> = {}): PaneGraphInfo => ({ repoRoot: `${HOME}/code/app`, indexed: true, nodes: 1234, edges: 5000, lastIngestAt: 1, enforced: true, toolCalls: 0, ...o });

const noServers: typeof fetch = async () => { throw new Error('ECONNREFUSED'); };

function deps(o: Partial<HealthDeps> & { claude?: { version?: RunResult; auth?: RunResult } | null } = {}): HealthDeps {
  const { claude, ...rest } = o;
  return {
    version: '0.1.8', inDaemon: true, uiPort: 8797, home: HOME, env: { PATH: '/usr/bin' },
    daemon: async () => ({ running: true, version: '0.1.8', pid: 42, uptimeMs: 3 * 60_000 }),
    graphStatus: async () => graphInfo(),
    swarmStatus: async () => swarmStatus(),
    findBinary: async (name) => (name === 'claude' && claude !== null ? `${HOME}/.local/bin/claude` : name === 'git' ? '/usr/bin/git' : null),
    bundledClaude: () => null,
    developerToolsInstalled: async () => true,
    run: async (_bin, args) => (args[0] === '--version'
      ? (claude?.version ?? { code: 0, stdout: '2.1.272 (Claude Code)\n', stderr: '', error: null })
      : (claude?.auth ?? { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'dev@example.com', orgName: 'Secret Org' }), stderr: '', error: null })),
    freeDiskBytes: async () => 50 * GB,
    fetch: noServers,
    now: () => 1000,
    ...rest,
  };
}

const byId = (r: { checks: { id: HealthCheckId }[] }, id: HealthCheckId) => r.checks.find((c) => c.id === id) as any;

test('a healthy machine: every check ok or skipped, in a stable order, with no fix lines', posixOnly, async () => {
  const r = await runHealthChecks({ cwd: `${HOME}/code/app` }, deps());
  assert.deepEqual(r.checks.map((c) => c.id), ['daemon', 'claude-cli', 'claude-auth', 'codex', 'antigravity', 'git', 'opencode', 'graph', 'disk', 'ports', 'swarm', 'local-models', 'prompt-cache', 'cli-path']);
  for (const c of r.checks) assert.ok(c.status === 'ok' || ((c.id === 'local-models' || c.id === 'codex' || c.id === 'antigravity' || c.id === 'prompt-cache') && c.status === 'skip') || (c.id === 'cli-path' && c.status === 'warn'), `${c.id}: ${c.status} ${c.detail}`);
  assert.match(byId(r, 'claude-cli').detail, /v2\.1\.272 at ~\/\.local\/bin\/claude/);
  assert.match(byId(r, 'claude-auth').detail, /Signed in via claude\.ai, max plan/);
  assert.match(byId(r, 'graph').detail, /1,234 symbols, up to date/);
  assert.ok(byId(r, 'cli-path'));
  assert.equal(r.generatedAt, 1000);
});

test('the login check never carries the account email or org', async () => {
  const r = await runHealthChecks({}, deps());
  const text = JSON.stringify(r);
  assert.ok(!text.includes('dev@example.com') && !text.includes('Secret Org'));
});

test('no Claude Code: fail with an install fix; the login row waits for it', async () => {
  const r = await runHealthChecks({}, deps({ claude: null }));
  assert.equal(byId(r, 'claude-cli').status, 'fail');
  assert.match(byId(r, 'claude-cli').fix, /install\.sh/);
  assert.equal(byId(r, 'claude-auth').status, 'skip');
});

test('no Claude Code CLI: Kora\'s bundled copy answers the login question', async () => {
  const calls: string[] = [];
  const base = deps({ claude: null });
  const bundled = { ...base, bundledClaude: () => '/App/runtime/claude', run: async (bin: string, args: string[]) => { calls.push(`${bin} ${args.join(' ')}`); return base.run!(bin, args, 1000); } };
  const r = await runHealthChecks({ only: ['claude-cli', 'claude-auth'] }, bundled);
  assert.deepEqual(calls, ['/App/runtime/claude auth status --json']);
  // Logged in: chat works on the bundled copy, the missing CLI is only a warning.
  assert.equal(byId(r, 'claude-auth').status, 'ok');
  assert.equal(byId(r, 'claude-cli').status, 'warn');
  const out = await runHealthChecks({ only: ['claude-cli', 'claude-auth'] }, { ...bundled, run: async () => ({ code: 1, stdout: '{"loggedIn": false}', stderr: '', error: null }) });
  // Logged out: the bundled copy can run the login itself, so the app offers "Log in to Claude" — no install first.
  assert.equal(byId(out, 'claude-cli').status, 'warn');
  assert.match(byId(out, 'claude-cli').fix, /install\.sh/);
  assert.equal(byId(out, 'claude-auth').status, 'fail');
  assert.match(byId(out, 'claude-auth').fix, /Log in to Claude/);
  assert.deepEqual(byId(out, 'claude-auth').data, { login: 'bundled' });
  // Neither a CLI nor a bundled copy: installing is the only way, and the fix is printed once.
  const none = await runHealthChecks({ only: ['claude-cli', 'claude-auth'] }, { ...base, bundledClaude: () => null });
  assert.equal(byId(none, 'claude-cli').status, 'fail');
  assert.equal(byId(none, 'claude-auth').fix, null, 'the install fix is printed once, on the Claude Code row');
});

test('agentSummary: agent rows count nothing while one works, and as one problem when none does', () => {
  const row = (id: HealthCheckId, status: 'ok' | 'warn' | 'fail' | 'skip') => ({ id, label: id, status, detail: '', fix: null });
  const withCodex = agentSummary([row('daemon', 'ok'), row('claude-cli', 'fail'), row('claude-auth', 'fail'), row('codex', 'ok'), row('antigravity', 'warn')]);
  assert.deepEqual(withCodex, { usable: true, bad: 0, warn: 0 });
  const none = agentSummary([row('daemon', 'fail'), row('claude-cli', 'fail'), row('claude-auth', 'skip'), row('codex', 'skip'), row('disk', 'warn')]);
  assert.deepEqual(none, { usable: false, bad: 2, warn: 1 });
  assert.equal(agentSummary([row('disk', 'ok')]).usable, null);
  assert.match(formatHealthReport({ koraVersion: '1', platform: '', node: '', cwd: null, generatedAt: 0, checks: [row('claude-cli', 'fail'), row('codex', 'skip')] }), /✗ Coding agent +None of Claude Code/);
});

test('codex: optional when missing, ok when logged in, a warning with `codex login` when not', posixOnly, async () => {
  const withCodex = (status: RunResult) => deps({
    findBinary: async (name) => (name === 'codex' ? `${HOME}/.local/bin/codex` : null),
    run: async (_bin, args) => (args[0] === '--version' ? { code: 0, stdout: 'codex-cli 0.155.1\n', stderr: '', error: null } : status),
  });
  const missing = byId(await runHealthChecks({ only: ['codex'] }, deps()), 'codex');
  assert.equal(missing.status, 'skip');
  assert.match(missing.fix, /@openai\/codex/);
  const ok = byId(await runHealthChecks({ only: ['codex'] }, withCodex({ code: 0, stdout: 'Logged in using ChatGPT\n', stderr: '', error: null })), 'codex');
  assert.equal(ok.status, 'ok');
  assert.match(ok.detail, /v0\.155\.1 at ~\/\.local\/bin\/codex; logged in using ChatGPT/);
  const out = byId(await runHealthChecks({ only: ['codex'] }, withCodex({ code: 1, stdout: 'Not logged in\n', stderr: '', error: 'exit 1' })), 'codex');
  assert.equal(out.status, 'warn');
  assert.match(out.fix, /codex login/);
});

test('git: the macOS stub without developer tools is never run, and says how to install them', async () => {
  const ran: string[] = [];
  const d = deps({ developerToolsInstalled: async () => false, run: async (bin, args) => { ran.push(bin); return { code: 0, stdout: `${args}`, stderr: '', error: null }; } });
  const r = byId(await runHealthChecks({ only: ['git'] }, d), 'git');
  assert.equal(r.status, 'warn');
  assert.match(r.fix, process.platform === 'win32' ? /winget install --id Git\.Git/ : process.platform === 'darwin' ? /xcode-select --install/ : /package manager/);
  assert.ok(!ran.includes('/usr/bin/git'));
  assert.equal(byId(await runHealthChecks({ only: ['git'] }, deps()), 'git').status, 'ok');
});

test('not logged in: fail with `claude auth login`', async () => {
  const r = await runHealthChecks({}, deps({ claude: { auth: { code: 1, stdout: '{"loggedIn": false}', stderr: '', error: null } } }));
  assert.equal(byId(r, 'claude-auth').status, 'fail');
  assert.match(byId(r, 'claude-auth').fix, /claude auth login/);
});

test('an old CLI without `auth status` is a warning, and ANTHROPIC_API_KEY counts as logged in', async () => {
  const old = { claude: { auth: { code: 1, stdout: '', stderr: "error: unknown command 'auth'\n", error: 'exit 1' } } };
  assert.equal(byId(await runHealthChecks({}, deps(old)), 'claude-auth').status, 'warn');
  const withKey = await runHealthChecks({}, deps({ ...old, env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-xxx' } }));
  assert.equal(byId(withKey, 'claude-auth').status, 'ok');
  assert.match(byId(withKey, 'claude-auth').detail, /API key/);
});

test('graph: no project, a non-git folder, not indexed, indexing', posixOnly, async () => {
  assert.equal(byId(await runHealthChecks({}, deps()), 'graph').status, 'skip');
  const notGit = await runHealthChecks({ cwd: `${HOME}/notes` }, deps({ graphStatus: async () => graphInfo({ repoRoot: null, indexed: false }) }));
  assert.equal(byId(notGit, 'graph').status, 'warn');
  assert.match(byId(notGit, 'graph').fix, /git init/);
  const fresh = await runHealthChecks({ cwd: `${HOME}/code/app` }, deps({ graphStatus: async () => graphInfo({ indexed: false, nodes: 0 }) }));
  assert.match(byId(fresh, 'graph').fix, /kora ingest \/Users\/dev\/code\/app/);
  const busy = await runHealthChecks({ cwd: `${HOME}/code/app` }, deps({ graphStatus: async () => graphInfo({ indexed: false, indexing: { phase: 'parse', pct: 41.6, files: 10, filesTotal: 90_000, elapsedMs: 1, etaMs: 1 } }) }));
  assert.equal(byId(busy, 'graph').status, 'ok');
  assert.match(byId(busy, 'graph').detail, /Indexing ~\/code\/app: 42% of 90000 files/);
});

test('disk thresholds', async () => {
  assert.equal(byId(await runHealthChecks({}, deps({ freeDiskBytes: async () => 1 * GB })), 'disk').status, 'fail');
  assert.equal(byId(await runHealthChecks({}, deps({ freeDiskBytes: async () => 3 * GB })), 'disk').status, 'warn');
  assert.equal(byId(await runHealthChecks({}, deps({ freeDiskBytes: async () => null })), 'disk').status, 'skip');
});

test('CLI view: daemon down, version mismatch, a foreign program on the UI port', async () => {
  const down = await runHealthChecks({}, deps({ inDaemon: false, daemon: async () => ({ running: false, version: null, pid: null, uptimeMs: null }) }));
  assert.equal(byId(down, 'daemon').status, 'fail');
  assert.match(byId(down, 'daemon').fix, /kora server start/);
  assert.equal(byId(down, 'ports').status, 'ok'); // nothing listens: free for the daemon
  const old = await runHealthChecks({ only: ['daemon'] }, deps({ inDaemon: false, daemon: async () => ({ running: true, version: '0.1.7', pid: 1, uptimeMs: 1 }) }));
  assert.equal(byId(old, 'daemon').status, 'warn');
  const foreign: typeof fetch = async () => new Response('<html>hi</html>', { status: 200 });
  const taken = await runHealthChecks({ only: ['ports'] }, deps({ inDaemon: false, fetch: foreign }));
  assert.equal(byId(taken, 'ports').status, 'fail');
  assert.match(byId(taken, 'ports').fix, process.platform === 'win32' ? /netstat -ano \| findstr :8797/ : /lsof -i :8797/);
});

test('swarm: not set up is optional; offline says so; cooling is a warning; unknown providers still show', async () => {
  const unset = await runHealthChecks({ only: ['swarm'] }, deps({ swarmStatus: async () => swarmStatus({ consent: { requiredVersion: 1, acceptedVersion: null, acceptedAt: null } }) }));
  assert.equal(byId(unset, 'swarm').status, 'skip');
  const offlineZen = swarmStatus().providers[0];
  const offline = await runHealthChecks({ only: ['swarm'] }, deps({ swarmStatus: async () => swarmStatus({ providers: [{ ...offlineZen, lastTest: { ...offlineZen.lastTest!, ok: false, outcome: 'unreachable', message: 'fetch failed', freeModels: [] } }] }) }));
  assert.equal(byId(offline, 'swarm').status, 'fail');
  assert.match(byId(offline, 'swarm').fix, /offline/);
  const cooling = await runHealthChecks({ only: ['swarm'] }, deps({ swarmStatus: async () => swarmStatus({ models: { available: [], cooling: [] } }) }));
  assert.equal(byId(cooling, 'swarm').status, 'warn');
  const local = { ...offlineZen, provider: 'ollama' as any };
  const withLocal = await runHealthChecks({ only: ['swarm'] }, deps({ swarmStatus: async () => swarmStatus({ providers: [offlineZen, local] }) }));
  assert.match(byId(withLocal, 'swarm').detail, /ollama: reachable/);
  // `kora doctor --quick` in a fresh process: nothing tested yet is unknown, not a failure.
  // OpenRouter is enabled by default without a key: never tested, it is "not set up", not a failing provider.
  const keyless = { ...offlineZen, provider: 'openrouter' as const, hasKey: false, lastTest: null };
  const fresh = await runHealthChecks({ only: ['swarm'] }, deps({ swarmStatus: async () => swarmStatus({ providers: [offlineZen, keyless] }) }));
  assert.equal(byId(fresh, 'swarm').status, 'ok');
  assert.doesNotMatch(byId(fresh, 'swarm').detail, /openrouter/);
  const untested = await runHealthChecks({ only: ['swarm'] }, deps({ swarmStatus: async () => swarmStatus({ providers: [{ ...offlineZen, lastTest: null }] }) }));
  assert.equal(byId(untested, 'swarm').status, 'skip');
  assert.match(byId(untested, 'swarm').detail, /zen: not tested/);
});

test('a hanging or throwing check becomes a warning row, never a broken report', async () => {
  const r = await runHealthChecks({ cwd: '/x' }, deps({ timeoutMs: 50, graphStatus: () => new Promise(() => {}), freeDiskBytes: async () => { throw new Error('boom'); } }));
  assert.equal(byId(r, 'graph').status, 'warn');
  assert.match(byId(r, 'graph').detail, /Timed out/);
  assert.equal(byId(r, 'disk').status, 'warn');
  assert.match(byId(r, 'disk').detail, /boom/);
});

test('local model servers: Ollama with models, LM Studio empty', async () => {
  const f: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes(':11434/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen3-coder:30b' }, { name: 'llama3.3' }] }));
    if (u.includes(':1234/v1/models')) return new Response(JSON.stringify({ data: [] }));
    throw new Error('refused');
  };
  const servers = await probeLocalModelServers(f);
  assert.deepEqual(servers.map((s) => [s.kind, s.reachable, s.models.length]), [['ollama', true, 2], ['lmstudio', true, 0]]);
  const r = await runHealthChecks({ only: ['local-models'] }, deps({ fetch: f }));
  assert.equal(byId(r, 'local-models').status, 'warn');
  assert.match(byId(r, 'local-models').detail, /Ollama: 2 models \(qwen3-coder:30b, llama3\.3\)/);
  assert.deepEqual(byId(r, 'local-models').data.servers[0].models, ['qwen3-coder:30b', 'llama3.3']);
});

test('formatHealthReport prints a fix line only under problems', () => {
  const text = formatHealthReport({ koraVersion: '1', platform: 'p', node: 'n', cwd: null, generatedAt: 0, checks: [
    { id: 'disk', label: 'Free disk space', status: 'ok', detail: '50 GB free', fix: null },
    { id: 'daemon', label: 'Kora daemon', status: 'fail', detail: 'Not running', fix: 'kora server start' },
  ] });
  assert.match(text, /✓ Free disk space {2}50 GB free/);
  assert.match(text, /✗ Kora daemon {6}Not running\n\s+fix: kora server start/);
});

test('prompt cache row: empty = skipped; a healthy week reads in plain words; a cold one warns with a fix', async () => {
  const none = await runHealthChecks({ only: ['prompt-cache'] }, deps({ costLines: () => [] }));
  assert.equal(byId(none, 'prompt-cache').status, 'skip');
  const call = (cr: number, cc: number, miss = false, cause?: string): any => ({ k: 'call', ts: 1, thread: miss ? 'b' : 'a', model: 'm', ctx: cr + cc, in: 1, cr, cc, out: 10, miss, ...(cause ? { cause } : {}) });
  const good = await runHealthChecks({ only: ['prompt-cache'] }, deps({ costLines: () => [call(0, 30000), ...Array.from({ length: 30 }, () => call(30000, 500)), { k: 'read-bound', ts: 1, thread: 'a', file: 'x', offset: 1, limit: 250, total: 700, source: 'head', avoided: 6000 }, { k: 'read-expand', ts: 1, thread: 'a', file: 'x' }] }));
  const g = byId(good, 'prompt-cache');
  assert.equal(g.status, 'ok'); assert.match(g.detail, /9\d% of prompt tokens came from the cache over 31 calls/); assert.match(g.detail, /Bounded reads: 1, about 6k tokens.*100% needed the rest/);
  const cold = await runHealthChecks({ only: ['prompt-cache'] }, deps({ costLines: () => Array.from({ length: 25 }, () => call(1000, 30000, true, 'idle')) }));
  const c = byId(cold, 'prompt-cache');
  assert.equal(c.status, 'warn'); assert.match(c.detail, /25 cache misses \(25 idle over an hour\)/); assert.ok(c.fix);
});
