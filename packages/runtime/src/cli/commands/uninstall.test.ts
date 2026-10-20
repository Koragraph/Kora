// `kora uninstall`: removes exactly Kora's entries (repo blocks + hooks, skills, Codex MCP section, CLI shim), keeps
// everything the user wrote, and deletes data only with --purge --yes. Runs in the isolated HOME of test-isolate.cjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run, uninstallPaths, isKoraSkillDir, isKoraShim, knownRepos } from './uninstall';

const HOME = os.homedir();
const SHIM = (name: string) => (process.platform === 'win32' ? `${name}.cmd` : name); // kora-runtime.cjs writes kora.cmd
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (file: string) => fs.readFileSync(file, 'utf8');
const capture = () => { let out = ''; let err = ''; return { io: { out: (s: string) => { out += s; }, err: (s: string) => { err += s; } }, text: () => out + err }; };

function fixture() {
  const p = uninstallPaths();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'uninst-repo-'));
  execFileSync('git', ['init', '-q', repo]);
  write(path.join(repo, 'CLAUDE.md'), '# My notes\n\n<!-- kora:begin -->\nkora rules\n<!-- kora:end -->\n');
  write(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '"${KORA_BIN:-/x/bin/kora.js}" hook prompt' }] }] } }));
  write(path.join(repo, '.git', 'hooks', 'post-commit'), '#!/bin/sh\necho mine\n');
  const { kg } = require('../../graph/embedded');
  kg('src/services/git-hooks.js').installHook(path.join(repo, '.git', 'hooks'), 'post-commit', { nodeBin: '/n', cliEntry: '/k', repoPath: repo, project: 'default' });
  write(path.join(p.koraHome, 'kora-daemon', 'projects.json'), JSON.stringify([
    { id: 'blob_kora', workspaceRoot: path.join(HOME, 'Blobs', 'Kora'), surface: 'blobs' },
    { id: 'p1', workspaceRoot: repo, surface: 'code' },
    { id: 'gone', workspaceRoot: path.join(HOME, 'deleted-repo'), surface: 'code' },
  ]));
  write(path.join(p.koraHome, 'chat', 'x.json'), '{}');
  write(path.join(HOME, '.claude', 'skills', 'koraswarm', 'SKILL.md'), '---\nname: koraswarm\ndescription: x\n---\n');
  write(path.join(HOME, '.claude', 'skills', 'korachat', 'SKILL.md'), '---\nname: korachat\n---\n');
  write(path.join(HOME, '.claude', 'skills', 'kora-orchestrator', 'SKILL.md'), '---\nname: kora-orchestrator\n---\n');
  write(path.join(HOME, '.claude', 'skills', 'kora-orchestrator', 'notes.md'), 'the user added this');
  write(path.join(HOME, '.claude', 'skills', 'tdd', 'SKILL.md'), '---\nname: tdd\n---\n');
  write(p.codexConfig, 'model = "gpt-5"\n\n[mcp_servers.kora]\ncommand = "/n"\nargs = ["mcp"]\n\n[mcp_servers.other]\ncommand = "x"\n');
  // Trust lines in Codex's config: one Kora added (in its ledger), one Codex or the user wrote themselves.
  fs.appendFileSync(p.codexConfig, '\n[projects."/work/kora-added"]\ntrust_level = "trusted"\n\n[projects."/work/users-own"]\ntrust_level = "trusted"\n');
  write(path.join(p.koraHome, 'kora-daemon', 'codex-trust-added.json'), JSON.stringify(['/work/kora-added']));
  write(path.join(p.binDir, SHIM('kora')), '#!/bin/sh\n# kora-managed-shim (written by Kora.app)\nexec /n /k "$@"\n');
  write(path.join(p.binDir, 'other-tool'), '#!/bin/sh\n');
  write(path.join(p.graphHome, 'graph.db'), '');
  return { p, repo };
}

test('the helpers recognise only what Kora wrote', () => {
  const { p } = fixture();
  assert.equal(isKoraSkillDir(path.join(HOME, '.claude', 'skills', 'koraswarm'), 'koraswarm'), true);
  assert.equal(isKoraSkillDir(path.join(HOME, '.claude', 'skills', 'kora-orchestrator'), 'kora-orchestrator'), false, 'a folder with the user\'s files stays');
  assert.equal(isKoraSkillDir(path.join(HOME, '.claude', 'skills', 'tdd'), 'koraswarm'), false);
  assert.equal(isKoraShim(path.join(p.binDir, SHIM('kora'))), true);
  assert.equal(isKoraShim(path.join(p.binDir, 'other-tool')), false);
  const repos = knownRepos(p, () => [HOME, '/']);
  assert.equal(repos.length, 1, `only the existing code project: ${repos}`);
  assert.deepEqual(uninstallPaths({ KORA_HOME: path.join(HOME, '.kora-dev') }, HOME).cliName, 'kora-dev');
  assert.match(uninstallPaths({}, HOME).userData ?? '', process.platform === 'win32' ? /AppData[/\\]Roaming[/\\]kora$/ : /Application Support\/kora$/);
});

test('--dry-run changes nothing; a plain run removes Kora entries and keeps the user\'s and the data', async () => {
  const { p, repo } = fixture();
  const dry = capture();
  assert.equal(await run(['--dry-run'], dry.io), 0);
  assert.match(dry.text(), /would remove ~[/\\]\.claude[/\\]skills[/\\]koraswarm/);
  assert.ok(fs.existsSync(path.join(p.binDir, SHIM('kora'))));
  assert.match(read(path.join(repo, 'CLAUDE.md')), /kora:begin/);

  const real = capture();
  assert.equal(await run([], real.io), 0, real.text());
  assert.equal(read(path.join(repo, 'CLAUDE.md')).includes('kora:begin'), false);
  assert.match(read(path.join(repo, 'CLAUDE.md')), /# My notes/);
  assert.equal(fs.existsSync(path.join(repo, '.claude')), false, 'a settings file that held only Kora hooks goes, with its folder');
  const hook = read(path.join(repo, '.git', 'hooks', 'post-commit'));
  assert.match(hook, /echo mine/);
  assert.equal(hook.includes('koragraph auto-reindex'), false);
  assert.equal(fs.existsSync(path.join(HOME, '.claude', 'skills', 'koraswarm')), false);
  assert.equal(fs.existsSync(path.join(HOME, '.claude', 'skills', 'korachat')), false);
  assert.ok(fs.existsSync(path.join(HOME, '.claude', 'skills', 'kora-orchestrator', 'notes.md')));
  assert.ok(fs.existsSync(path.join(HOME, '.claude', 'skills', 'tdd', 'SKILL.md')));
  const codex = read(p.codexConfig);
  assert.equal(codex.includes('mcp_servers.kora'), false);
  assert.match(codex, /\[mcp_servers\.other\]/);
  assert.equal(codex.includes('/work/kora-added'), false, 'the trust line Kora added goes');
  assert.match(codex, /\[projects\."\/work\/users-own"\]\ntrust_level = "trusted"/, 'a trust line Kora did not add stays');
  assert.equal(fs.existsSync(path.join(p.binDir, SHIM('kora'))), false);
  assert.ok(fs.existsSync(path.join(p.binDir, 'other-tool')));
  assert.ok(fs.existsSync(path.join(p.koraHome, 'chat', 'x.json')), 'data stays without --purge');
  assert.match(real.text(), /--purge --yes/);
  assert.match(real.text(), /drag Kora\.app/);
});

test('--purge needs --yes, then deletes Kora\'s data and the graph store', async () => {
  const { p } = fixture();
  const refused = capture();
  assert.equal(await run(['--purge'], refused.io), 2);
  assert.ok(fs.existsSync(p.koraHome));
  const ok = capture();
  assert.equal(await run(['--purge', '--yes'], ok.io), 0, ok.text());
  assert.equal(fs.existsSync(p.koraHome), false);
  assert.equal(fs.existsSync(p.graphHome), false);
});

// B11 (night 2026-10-04): `kora uninstall` for any home but the stable ~/.kora removed the stable app's CLI shim and the
// shared Claude skills / Codex MCP entry (the dry run of a QA stack listed ~/.local/bin/kora and ~/.claude/skills/*).
test('a non-stable KORA_HOME removes only its own shim and keeps the shared skills + Codex entry', async () => {
  fixture(); // the stable install's shim, skills and Codex entry
  const stableShim = path.join(HOME, '.local', 'bin', 'kora');
  write(stableShim, `#!/bin/sh\n# kora-managed-shim (written by Kora.app)\nexec "${HOME}/.kora/app/bin/node" "${HOME}/.kora/app/bin/kora.js" "$@"\n`);
  const qaHome = path.join(HOME, 'qa', 'stack2', 'home');
  fs.mkdirSync(qaHome, { recursive: true });
  const saved = process.env.KORA_HOME;
  process.env.KORA_HOME = qaHome;
  try {
    const p = uninstallPaths();
    assert.equal(isKoraShim(stableShim, p.koraHome, HOME), false, 'the stable shim is not this home\'s');
    const out = capture();
    assert.equal(await run([], out.io), 0, out.text());
    assert.ok(fs.existsSync(stableShim), 'the stable CLI shim stays');
    assert.ok(fs.existsSync(path.join(HOME, '.claude', 'skills', 'koraswarm', 'SKILL.md')), 'shared skills stay');
    assert.match(read(path.join(HOME, '.codex', 'config.toml')), /mcp_servers\.kora/, 'the Codex entry stays');
    assert.match(out.text(), /kept the Claude skills/);
  } finally {
    process.env.KORA_HOME = saved;
  }
});

test('Kora Dev removes its own kora-dev shim; the shared entries stay while the stable home exists', async () => {
  fixture();
  fs.mkdirSync(path.join(HOME, '.kora'), { recursive: true });
  const devHome = path.join(HOME, '.kora-dev');
  const devShim = path.join(HOME, '.local', 'bin', SHIM('kora-dev'));
  write(devShim, `#!/bin/sh\n# kora-managed-shim (written by Kora Dev.app)\nexport KORA_HOME="${devHome}"\nexec "${devHome}/app/bin/node" "${devHome}/app/bin/kora.js" "$@"\n`);
  const saved = { home: process.env.KORA_HOME, codex: process.env.CODEX_HOME };
  process.env.KORA_HOME = devHome;
  process.env.CODEX_HOME = path.join(HOME, '.codex');
  try {
    const out = capture();
    assert.equal(await run([], out.io), 0, out.text());
    assert.equal(fs.existsSync(devShim), false, 'its own shim goes');
    assert.ok(fs.existsSync(path.join(HOME, '.local', 'bin', SHIM('kora'))), 'the stable shim stays');
    assert.ok(fs.existsSync(path.join(HOME, '.claude', 'skills', 'korachat', 'SKILL.md')), 'shared skills stay');
  } finally {
    process.env.KORA_HOME = saved.home;
    process.env.CODEX_HOME = saved.codex;
  }
});

test('knownRepos also finds a folder only a chat thread ran in (the first send wrote the rulebook there)', () => {
  const { p } = fixture();
  const chatRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'uninst-chatrepo-'));
  write(path.join(p.koraHome, 'chat', 't_abc', 'meta.json'), JSON.stringify({ id: 't_abc', cwd: chatRepo }));
  assert.ok(knownRepos(p, () => []).includes(fs.realpathSync(chatRepo)) || knownRepos(p, () => []).includes(chatRepo));
});
