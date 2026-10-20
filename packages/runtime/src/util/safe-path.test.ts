// Security guards for computed paths and git refs (docs/qa/security-2026-10-04/02-runtime-exec-fs.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unsafeRepoWrite, isSafeGitRef, isSafePathSegment, isDangerousRmTarget } from './safe-path';

function tmp(): string { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-safe-path-'))); }

test('unsafeRepoWrite: plain files inside the repo are fine; links out of it are refused', () => {
  const repo = tmp(); const outside = tmp();
  try {
    fs.writeFileSync(path.join(outside, 'zshrc'), 'mine');
    assert.equal(unsafeRepoWrite(path.join(repo, 'CLAUDE.md'), repo), null, 'absent file in the repo');
    assert.equal(unsafeRepoWrite(path.join(repo, '.claude', 'settings.local.json'), repo), null, 'absent dir in the repo');
    // CLAUDE.md -> AGENTS.md inside the repo: a common, legitimate layout.
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# a');
    fs.symlinkSync('AGENTS.md', path.join(repo, 'CLAUDE.md'));
    assert.equal(unsafeRepoWrite(path.join(repo, 'CLAUDE.md'), repo), null, 'in-repo link target');
    assert.match(String(unsafeRepoWrite(path.join(repo, 'CLAUDE.md'))), /symbolic link/, 'no root: any link refused');
    // GEMINI.md -> ~/.zshrc (outside)
    fs.symlinkSync(path.join(outside, 'zshrc'), path.join(repo, 'GEMINI.md'));
    assert.match(String(unsafeRepoWrite(path.join(repo, 'GEMINI.md'), repo)), /outside/);
    // dangling link
    fs.symlinkSync(path.join(outside, 'nope'), path.join(repo, 'AGENT.md'));
    assert.match(String(unsafeRepoWrite(path.join(repo, 'AGENT.md'), repo)), /dangling/);
    // .claude -> outside dir: the file below it resolves outside
    fs.symlinkSync(outside, path.join(repo, '.claude'));
    assert.match(String(unsafeRepoWrite(path.join(repo, '.claude', 'settings.local.json'), repo)), /outside/);
    assert.match(String(unsafeRepoWrite(path.join(outside, 'x'), repo)), /outside/, 'lexically outside');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('isSafeGitRef: option-looking or whitespace refs are refused; revision syntax passes', () => {
  for (const ok of ['main', 'feature/x', 'HEAD~2', 'a..b', 'main^{commit}', '@{u}', 'deadbeef', 'origin/main', 'v1.2.3']) assert.ok(isSafeGitRef(ok), ok);
  for (const bad of ['', '-f', '--upload-pack=touch /tmp/x', '--orphan=x', 'a b', 'a\nb', 'a\0b', 'x'.repeat(600), 42, null]) assert.equal(isSafeGitRef(bad), false, String(bad));
});

test('isSafePathSegment: exactly one segment', () => {
  for (const ok of ['t_abc123', 'chat:x', 'a.b', '...']) assert.ok(isSafePathSegment(ok), ok);
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', '../x', '/abs', undefined]) assert.equal(isSafePathSegment(bad), false, String(bad));
});

test('isDangerousRmTarget: home, its ancestors, the root and shallow paths are never rm -rf targets', () => {
  const home = '/Users/someone';
  for (const bad of ['/', '/Users', home, `${home}/`, '/tmp', '/opt']) assert.ok(isDangerousRmTarget(bad, home), bad);
  for (const ok of [`${home}/.kora`, `${home}/.koragraph`, `${home}/Library/Application Support/kora`, '/tmp/x/y']) assert.equal(isDangerousRmTarget(ok, home), false, ok);
});

test('privateTmpDir: owner-only, not a symlink, stable per process', () => {
  const { privateTmpDir, resetPrivateTmpDirForTests } = require('./safe-path') as typeof import('./safe-path');
  resetPrivateTmpDirForTests();
  const d = privateTmpDir();
  const st = fs.lstatSync(d);
  assert.ok(st.isDirectory() && !st.isSymbolicLink());
  if (process.platform !== 'win32') assert.equal(st.mode & 0o077, 0);
  if (typeof process.getuid === 'function') assert.equal(st.uid, process.getuid());
  assert.equal(privateTmpDir(), d);
});
