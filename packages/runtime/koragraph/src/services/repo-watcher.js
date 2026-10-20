'use strict';

// Watch mode: keep the graph current with the working tree as the developer edits. It reacts to
// file CHANGES (not just commits) — a save, a checkout, a commit, a rebase — and re-indexes only
// the files that moved.
//
// The mechanism is git-state polling rather than a filesystem watcher, deliberately: it needs no
// native dependency, is identical on macOS/Linux/Windows, and inherits `.gitignore` for free
// (`git status` never reports an ignored path, so node_modules and build output are excluded
// without a single ignore rule of our own). A short poll interval plus a "wait for quiet"
// debounce gives the same felt latency as an fs-event watcher without the per-directory watch
// cost on a large tree.
//
// What re-indexes is the UNION of two sets: files a commit changed since the recorded SHA
// (git diff recorded..HEAD) and files the working tree changed since HEAD (git status). One
// incremental pass over that union, with the recorded SHA advanced to HEAD, folds "you committed"
// and "you have unsaved edits" into a single re-extraction — so an uncommitted save is reflected
// and a later commit of it is a no-op.

const { execFileSync } = require('child_process');
const path = require('path');
const { EXT_TO_AST_LANG } = require('./ast-extractor');

function git(repoPath, args, { allowFail = true } = {}) {
  try {
    // core.fsmonitor=false (kora patch): `git status` runs a repo's configured fsmonitor command, and this runs
    // unprompted on every query-time freshness check.
    return execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', repoPath, ...args], // stderr piped, not inherited: git's `warning: could not open directory …` lines otherwise land in the middle of a tool's answer
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

function isSourcePath(p) {
  const ext = path.extname(p).toLowerCase();
  return Boolean(ext && EXT_TO_AST_LANG[ext]);
}

// `git status --porcelain -z` into changed/removed source paths. -z is mandatory: without it a
// path with a space or a non-ASCII byte is quoted, and a rename arrives as `old -> new` which an
// unquoted parser splits wrong. In -z, a rename/copy entry is followed by its ORIGIN as the very
// next NUL field, so the origin is consumed explicitly rather than pattern-matched.
// Not source, not ingested, but a change to one can alter CROSS-REPO edges (a dependency added, a proto or API spec
// edited): carried as `signals` so the incremental tail can decide whether the project-wide pass is worth its 6 s.
const SIGNAL_PATH_RE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|setup\.py|go\.mod|go\.sum|pom\.xml|build\.gradle(\.kts)?|Cargo\.toml|Gemfile|composer\.json|[^/]*\.proto|openapi[^/]*\.(json|ya?ml)|swagger[^/]*\.(json|ya?ml)|docker-compose[^/]*\.ya?ml|Dockerfile)$/i;
function isSignalPath(p) { return SIGNAL_PATH_RE.test(String(p)); }
function parsePorcelainZ(text) {
  const changed = [];
  const removed = [];
  const signals = [];
  if (!text) return { changed, removed, signals };
  const tokens = text.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length < 3) continue;
    const x = t[0];
    const y = t[1];
    const p = t.slice(3);
    if (x === 'R' || x === 'C') {
      const origin = tokens[++i];            // the paired ORIGIN field
      if (origin && isSourcePath(origin)) removed.push(origin);
      if (isSourcePath(p)) changed.push(p);
      if (isSignalPath(p)) signals.push(p);
    } else if (x === 'D' || y === 'D') {
      if (isSourcePath(p)) removed.push(p);
      if (isSignalPath(p)) signals.push(p);
    } else if (isSourcePath(p)) {
      changed.push(p);                       // M, A, ??, MM, AM, ...
    } else if (isSignalPath(p)) {
      signals.push(p);
    }
  }
  return { changed, removed, signals };
}

// The WORKING-TREE change set and current HEAD, from `git status`. `head` is null for a checkout
// with no commits. This is the whole signal when the recorded SHA already equals HEAD (the common
// case while editing); computeChangesAsync adds the commit-diff set when HEAD has moved.
function computeChanges(repoPath, deps = {}) {
  const _git = deps.git || git;
  const head = (_git(repoPath, ['rev-parse', 'HEAD']) || '').trim() || null;
  const status = _git(repoPath, ['status', '--porcelain', '-z', '--untracked-files=all']);
  const { changed, removed, signals } = parsePorcelainZ(status || '');
  return { head, changed, removed, signals };
}

// The live form: also folds in files a commit changed since the recorded SHA, via the async VCS
// provider (the same one ingestAll uses).
async function computeChangesAsync(repoPath, recordedSha, deps = {}) {
  const base = computeChanges(repoPath, deps);
  if (recordedSha && base.head && recordedSha !== base.head) {
    try {
      const { LocalProvider } = require('./vcs/local-provider');
      const { splitDiff } = require('../cli/ingest');
      const diff = splitDiff(await new LocalProvider().getDiff(repoPath, recordedSha, base.head));
      const changed = new Set(base.changed);
      const removed = new Set(base.removed);
      const signals = new Set(base.signals || []);
      for (const p of diff.changed) { if (isSourcePath(p)) changed.add(p); if (isSignalPath(p)) signals.add(p); }
      for (const p of diff.removed) { if (isSourcePath(p)) removed.add(p); if (isSignalPath(p)) signals.add(p); }
      return { head: base.head, changed: [...changed], removed: [...removed], signals: [...signals] };
    } catch (_) {
      // A rebase/force-push can make recorded unreachable; the working-tree set still stands, and
      // the next commit re-establishes a diffable base.
      return base;
    }
  }
  return base;
}

// A stable key for a change set, so the loop can tell "nothing new" from "there is work". HEAD is
// included because a commit that leaves the working tree clean still needs a re-index.
function signatureOf({ head, changed, removed }) {
  return `${head || '-'}|${[...changed].sort().join(',')}|${[...removed].sort().join(',')}`;
}

// The debounce state machine, kept pure so the loop is trivial and the decision is testable. A
// change is acted on only once its signature has held steady for one poll (the tree is quiet),
// and never re-acted until it changes again.
//
//   prev      — signature seen last poll
//   applied   — signature of the last set we re-indexed
//   current   — signature this poll
//
// Returns { act, prev, applied }: act=true means re-index now and adopt `current` as applied.
function debounceStep({ prev, applied }, current, clean) {
  // `clean` = nothing to do (no diff from recorded HEAD and no working-tree change). Adopt it as
  // applied so a return to clean is not mistaken for pending work.
  if (clean) return { act: false, prev: current, applied: current };
  if (current !== applied && current === prev) {
    return { act: true, prev: current, applied: current };
  }
  return { act: false, prev: current, applied };
}

module.exports = {
  isSignalPath,
  git, isSourcePath, parsePorcelainZ, computeChanges, computeChangesAsync,
  signatureOf, debounceStep,
};
