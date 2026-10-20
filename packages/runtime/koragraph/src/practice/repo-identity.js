'use strict';

const fs = require('fs');
const path = require('path');

// `repo_id`: a durable coordinate, resolved late. `git remote get-url origin` produces it — but the
// recorder runs inside a hook on a 5 s budget, several times per assistant turn, and spawning git
// each time to learn something that changes once a year is the wrong trade. `.git/config` is a text
// file; this reads it.
//
// This is NOT source-url.js#normalizeRepoWebUrl. That one returns null for a local path and for
// any host outside an allow-list, because it feeds a clickable web URL. An identity that can be
// null is not an identity, so this one always answers.

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// `.git` is a directory in a normal checkout and a file (`gitdir: ...`) in a worktree or submodule.
// A worktree's own gitdir has no `config`; the shared one named by `commondir` does.
function gitConfigPath(repoRoot) {
  const dotGit = path.join(repoRoot, '.git');
  let stat;
  try { stat = fs.statSync(dotGit); } catch { return null; }
  if (stat.isDirectory()) return path.join(dotGit, 'config');

  let gitdir;
  try { gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim(); } catch { return null; }
  if (!gitdir) return null;
  if (!path.isAbsolute(gitdir)) gitdir = path.resolve(repoRoot, gitdir);

  const direct = path.join(gitdir, 'config');
  if (fs.existsSync(direct)) return direct;
  try {
    const common = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
    return path.join(path.resolve(gitdir, common), 'config');
  } catch { return null; }
}

function readOriginUrl(repoRoot) {
  const cfg = gitConfigPath(repoRoot);
  if (!cfg) return null;
  let text;
  try { text = fs.readFileSync(cfg, 'utf8'); } catch { return null; }
  // Section-scoped: a `url =` under [remote "fork"] must not be mistaken for origin's.
  let inOrigin = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) { inOrigin = /^\[remote\s+"origin"\]/.test(line); continue; }
    if (!inOrigin) continue;
    const m = /^url\s*=\s*(.+)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

// Collapses every spelling of the same remote onto one string:
//   git@github.com:spf13/viper.git       -> github.com/spf13/viper
//   https://github.com/spf13/viper.git   -> github.com/spf13/viper
//   ssh://git@github.com:22/spf13/viper  -> github.com/spf13/viper
function normaliseRemote(url) {
  if (!url || typeof url !== 'string') return null;
  let s = url.trim();
  if (!s) return null;
  s = s.replace(/^[a-z+]+:\/\//i, '');            // scheme
  s = s.replace(/^[^@/]+@/, '');                  // user@
  s = s.replace(/^([^/:]+):(?!\d)/, '$1/');       // scp-style host:path (not host:port)
  s = s.replace(/^([^/]+):\d+\//, '$1/');         // host:port/
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');  // trailing slash first: `.../c.git/`
  // A filesystem-path remote (`url = /srv/git/foo`) is a real remote and a fine identity, but
  // paths are case-sensitive on the platforms that matter, so only host-shaped remotes fold case.
  if (!s.startsWith('/')) s = s.toLowerCase();
  return s || null;
}

// `repo_name` is not stored — it is derived, so the schema keeps one identity column. It is what
// the graph's `repositories.name` holds (the checkout directory name at ingest), which is how a
// practice anchor finds its branch when `web_url` is null. On this machine that is the normal
// case: the live graph's only repository row has web_url = NULL and full_path = /tmp/commons-cli.
function repoNameOf(repoId) {
  if (!repoId) return null;
  return String(repoId).replace(/^local:/, '').split('/').filter(Boolean).pop() || null;
}

// A LINKED WORKTREE (`git worktree add`) is not the checkout the graph was built from: the index is
// keyed to the MAIN checkout, and a worktree resolves to the main branch row BY NAME (resolve.js).
// The freshness write path must refuse to run in one — catching up there would write the worktree's
// own branch into the shared main index and advance the main branch's recorded SHA to the worktree's
// HEAD (see live-freshness.js#branchRowFor). Detection is dependency-free and mirrors gitConfigPath's
// own `.git`-is-a-file test: a linked worktree's `.git` file names a gitdir under `.../worktrees/`.
// Deliberately NOT true for a submodule (gitdir under `.../modules/`) — that is a separate checkout
// with its own identity, out of scope for this guard.
function isLinkedWorktree(repoRoot) {
  if (!repoRoot) return false;
  const dotGit = path.join(repoRoot, '.git');
  let stat;
  try { stat = fs.statSync(dotGit); } catch { return false; }
  if (stat.isDirectory()) return false; // a normal main checkout
  let gitdir;
  try { gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim(); } catch { return false; }
  return !!gitdir && /[/\\]worktrees[/\\]/.test(gitdir);
}

// A LINKED WORKTREE's identity is its MAIN checkout's. Its own `.git` is a file naming a gitdir under
// `<main>/.git/worktrees/<name>`; `commondir` there points back at the main `.git`. Keying the identity by the
// worktree's basename (`local:codex-quiet-fox`) matched no repository row, so lookups fell through to a same-named
// file in whatever repo had one — a stale row of a different repo answered file_symbols/neighbours for the branch.
function mainCheckoutOf(repoRoot) {
  const dotGit = path.join(repoRoot, '.git');
  let stat;
  try { stat = fs.statSync(dotGit); } catch { return null; }
  if (stat.isDirectory()) return null;
  let gitdir;
  try { gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim(); } catch { return null; }
  if (!gitdir) return null;
  if (!path.isAbsolute(gitdir)) gitdir = path.resolve(repoRoot, gitdir);
  if (!/[/\\]worktrees[/\\]/.test(gitdir)) return null; // a submodule, not a worktree
  try {
    const common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
    return path.dirname(common); // <main>/.git → <main>
  } catch { return null; }
}

function repoIdentity(startDir) {
  const repoRoot = findRepoRoot(startDir);
  if (!repoRoot) return { repoRoot: null, repoId: null, repoName: null };
  const identityRoot = mainCheckoutOf(repoRoot) || repoRoot;
  const remote = normaliseRemote(readOriginUrl(identityRoot));
  const repoId = remote || `local:${path.basename(identityRoot)}`;
  return { repoRoot, repoId, repoName: repoNameOf(repoId) };
}

// Repo-relative, forward-slashed — the form `files.path` carries in the graph.
function relativise(repoRoot, filePath) {
  if (!repoRoot || !filePath) return filePath || null;
  const abs = path.resolve(filePath);
  const rel = path.relative(repoRoot, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return abs;
  return rel.split(path.sep).join('/');
}

module.exports = {
  repoIdentity, findRepoRoot, readOriginUrl, normaliseRemote, relativise, repoNameOf, gitConfigPath, isLinkedWorktree, mainCheckoutOf,
};
