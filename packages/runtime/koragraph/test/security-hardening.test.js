'use strict';
// Security hardening (2026-10-04, docs/qa/security-2026-10-04/02-runtime-exec-fs.md): hostile repository content and
// hostile refs never reach a shell, never become git options, and never redirect a write outside the repository.
// Tiny fixtures only (git init in a temp dir); no ingest, no store.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { LocalProvider, revArg } = require('../src/services/vcs/local-provider');
const gitHooks = require('../src/services/git-hooks');
const { cloneWithHistory } = require('../src/services/vcs/git-clone');

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('local-provider: file names and refs never reach a shell; option-looking refs are refused', async () => {
  const repo = tmp('kg-sec-repo-');
  const marker = path.join(repo, 'PWNED');
  try {
    git(repo, 'init', '-q', '-b', 'main');
    const evil = '$(touch PWNED)`touch PWNED`;touch PWNED.ts';
    fs.writeFileSync(path.join(repo, evil), 'x\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'c1');
    git(repo, 'branch', 'other');
    const p = new LocalProvider();
    // a non-current branch forces the `git show <rev>:<path>` route that used to be a /bin/sh string
    assert.equal(await p.getFileContent(repo, 'other', evil), 'x');
    await p.getDiff(repo, 'main', 'other', evil);
    await p.getCommits(repo, 'other', { since: '"; touch PWNED; echo "' });
    assert.equal(fs.existsSync(marker), false, 'no shell ran');
    assert.throws(() => revArg('--output=/tmp/x'), /refusing revision/);
    assert.throws(() => revArg('a b'), /refusing revision/);
    await assert.rejects(p.getFileContent(repo, '--upload-pack=touch PWNED', 'x'));
    // never reads outside the checkout
    await assert.rejects(p.getFileContent(repo, 'main', '../../../../etc/hosts'), /outside/);
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('git-hooks: a hook file that is a symlink (e.g. to ~/.zshrc via a tracked hooks dir) is never written through or removed', () => {
  const dir = tmp('kg-sec-hooks-');
  const outside = tmp('kg-sec-outside-');
  try {
    const victim = path.join(outside, 'zshrc');
    fs.writeFileSync(victim, 'export MINE=1\n');
    fs.symlinkSync(victim, path.join(dir, 'post-commit'));
    const r = gitHooks.installHook(dir, 'post-commit', { nodeBin: '/n', cliEntry: '/k', repoPath: '/r', project: 'default' });
    assert.equal(r.action, 'skipped-symlink');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'export MINE=1\n', 'victim untouched');
    assert.equal(gitHooks.uninstallHook(dir, 'post-commit').action, 'not-managed');
    assert.ok(fs.existsSync(victim));
    // a regular hook still installs
    assert.equal(gitHooks.installHook(dir, 'post-merge', { nodeBin: '/n', cliEntry: '/k', repoPath: '/r', project: 'default' }).action, 'created');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('git-clone: a URL that looks like an option is a repository argument, not --upload-pack', async () => {
  const dir = tmp('kg-sec-clone-');
  const marker = path.join(dir, 'PWNED');
  try {
    await assert.rejects(cloneWithHistory(`--upload-pack=touch ${marker}`, path.join(dir, 'dest'), { timeout: 10_000 }));
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('serve: only a loopback Host on its own port, no cross-site Origin (DNS rebinding), GET only, not frameable', async () => {
  const http = require('node:http');
  const { makeHandler } = require('../src/cli/serve');
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const handler = makeHandler('<html>graph</html>', port);
  const req = (headers, method = 'GET') => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/', method, headers }, (res) => {
      let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    r.on('error', reject); r.end();
  });
  try {
    const ok = await req({ host: `localhost:${port}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, '<html>graph</html>');
    assert.equal(ok.headers['x-frame-options'], 'DENY');
    assert.equal((await req({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })).status, 200);
    assert.equal((await req({ host: `evil.example:${port}` })).status, 403, 'rebound hostname');
    assert.equal((await req({ host: `127.0.0.1:${port + 1}` })).status, 403, 'other port');
    assert.equal((await req({ host: `127.0.0.1:${port}`, origin: 'https://evil.example' })).status, 403);
    assert.equal((await req({ host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await req({ host: `127.0.0.1:${port}` }, 'POST')).status, 405);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
