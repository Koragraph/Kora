import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  trustFolder, revokeFolderTrust, isFolderTrusted, trustStatus, resolveTrustRoot, listTrustedFolders, migrateTrustOnce,
  trustFilePath, trustMigrationMarker, onTrustChange, untrustableReason, _resetTrustCacheForTests,
} from './store';
import { autoAnswerScope, untrustedAgentEnv, claudeSettingSources } from './gate';
import { codexAdapter } from '../enforce/adapters/codex';

/** Each test: its own KORA_HOME + scratch folders (never the real home; TMPDIR is outside $HOME in the runner). */
function sandbox<T>(fn: (dir: string) => T | Promise<T>): () => Promise<void> {
  return async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-trust-')));
    const prev = process.env.KORA_HOME;
    process.env.KORA_HOME = path.join(dir, 'kora');
    fs.mkdirSync(process.env.KORA_HOME, { recursive: true });
    _resetTrustCacheForTests();
    try { await fn(dir); } finally {
      if (prev === undefined) delete process.env.KORA_HOME; else process.env.KORA_HOME = prev;
      _resetTrustCacheForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
const repo = (dir: string, name: string) => { const r = path.join(dir, name); fs.mkdirSync(path.join(r, '.git'), { recursive: true }); return r; };
/** A linked worktree laid out the way `git worktree add` does it (no git binary needed). */
function worktree(main: string, wt: string, name = 'wt1'): void {
  const gd = path.join(main, '.git', 'worktrees', name);
  fs.mkdirSync(gd, { recursive: true }); fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gd}\n`);
  fs.writeFileSync(path.join(gd, 'gitdir'), `${path.join(wt, '.git')}\n`);
  fs.writeFileSync(path.join(gd, 'commondir'), '../..\n');
}

test('a new folder is untrusted; trusting covers it, its subfolders, and is stored 0600 by realpath', sandbox((dir) => {
  const r = repo(dir, 'app');
  fs.mkdirSync(path.join(r, 'src', 'deep'), { recursive: true });
  assert.equal(isFolderTrusted(r), false);
  const s = trustFolder(path.join(r, 'src'));
  assert.equal(s.trusted, true);
  assert.equal(s.root, r, 'keyed by the repository root, not the subfolder asked about');
  assert.equal(isFolderTrusted(path.join(r, 'src', 'deep')), true);
  assert.deepEqual(listTrustedFolders().map((e) => e.path), [r]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(trustFilePath()).mode & 0o777, 0o600);
  // A symlink to the repo resolves to the same trust.
  const link = path.join(dir, 'link'); fs.symlinkSync(r, link);
  assert.equal(isFolderTrusted(link), true);
  assert.equal(isFolderTrusted(path.join(dir, 'other')), false, 'a sibling is not covered');
}));

test('a linked worktree resolves to its main checkout; a planted .git file cannot borrow trust', sandbox((dir) => {
  const main = repo(dir, 'main');
  const wt = path.join(dir, 'kora', 'worktrees', 'main-p1');
  worktree(main, wt);
  assert.equal(resolveTrustRoot(wt), main);
  assert.equal(isFolderTrusted(wt), false);
  trustFolder(main);
  assert.equal(isFolderTrusted(wt), true, 'Kora worktrees of a trusted repo are trusted');
  // An attacker folder whose .git FILE points at the trusted repo's worktree gitdir (no back-pointer to it).
  const evil = path.join(dir, 'evil'); fs.mkdirSync(evil);
  fs.writeFileSync(path.join(evil, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt1')}\n`);
  assert.equal(resolveTrustRoot(evil), evil);
  assert.equal(isFolderTrusted(evil), false);
}));

test('home, / and their ancestors can never be trusted; a stored home entry is ignored', sandbox((dir) => {
  assert.throws(() => trustFolder(os.homedir()), /home folder/);
  assert.throws(() => trustFolder('/'), /filesystem root|home folder/);
  assert.throws(() => trustFolder('relative/path'), /absolute/);
  assert.ok(untrustableReason(path.join(dir, 'missing')));
  // Hand-edited file trusting the home folder: covers nothing.
  fs.writeFileSync(trustFilePath(), JSON.stringify({ version: 1, folders: [{ path: fs.realpathSync(os.homedir()), trustedAt: 1, source: 'user' }, { path: '/', trustedAt: 1, source: 'user' }] }));
  _resetTrustCacheForTests();
  assert.equal(isFolderTrusted(repo(dir, 'x')), false);
}));

test('a damaged trust.json trusts nothing (fail closed) and the next write replaces it', sandbox((dir) => {
  const r = repo(dir, 'r');
  fs.writeFileSync(trustFilePath(), '{not json');
  _resetTrustCacheForTests();
  assert.equal(isFolderTrusted(r), false);
  trustFolder(r);
  assert.equal(isFolderTrusted(r), true);
}));

test('revoke removes the folder; an ancestor that is still trusted keeps covering it and is named', sandbox((dir) => {
  const parent = path.join(dir, 'work'); fs.mkdirSync(parent);
  const r = repo(parent, 'r');
  const changes: Array<[string, boolean]> = [];
  const off = onTrustChange((root, t) => changes.push([root, t]));
  trustFolder(r);
  assert.equal(revokeFolderTrust(r).trusted, false);
  assert.equal(isFolderTrusted(r), false);
  trustFolder(parent); trustFolder(r);
  const s = revokeFolderTrust(r);
  assert.equal(s.trusted, true);
  assert.equal(s.trustedBy, parent);
  off();
  assert.deepEqual(changes.slice(0, 2), [[r, true], [r, false]], 'every grant / revoke is announced');
  assert.equal(changes.length, 5);
}));

test("a blob's workspace counts as trusted without an entry", sandbox((dir) => {
  const prev = process.env.KORA_BLOBS_ROOT;
  process.env.KORA_BLOBS_ROOT = path.join(dir, 'Blobs');
  const ws = path.join(dir, 'Blobs', 'popo');
  fs.mkdirSync(ws, { recursive: true });
  try {
    assert.equal(isFolderTrusted(ws), true);
    assert.equal(trustStatus(ws).source, 'kora');
  } finally { if (prev === undefined) delete process.env.KORA_BLOBS_ROOT; else process.env.KORA_BLOBS_ROOT = prev; }
}));

test('migration: folders already in use are trusted once; home is skipped; later folders are not', sandbox((dir) => {
  const home = process.env.KORA_HOME!;
  const a = repo(dir, 'a'), b = repo(dir, 'b'), c = repo(dir, 'c'), d = repo(dir, 'd'), wtMain = repo(dir, 'wtmain');
  const fresh = repo(dir, 'fresh');
  // chat index.json (a) + a thread meta.json (b)
  fs.mkdirSync(path.join(home, 'chat', 't_1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'chat', 'index.json'), JSON.stringify([{ id: 't_0', cwd: a }, { id: 't_h', cwd: os.homedir() }]));
  fs.writeFileSync(path.join(home, 'chat', 't_1', 'meta.json'), JSON.stringify({ id: 't_1', cwd: b }));
  // app projects (c)
  fs.mkdirSync(path.join(home, 'kora-daemon'), { recursive: true });
  fs.writeFileSync(path.join(home, 'kora-daemon', 'projects.json'), JSON.stringify([{ id: 'p', workspaceRoot: c }]));
  // pane workspaces (d) and a worker pane's main checkout
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ version: 1, workspaces: [{ id: 'w1', cwd: d, panes: [{ cwd: '/nowhere', worktree: { mainRoot: wtMain } }] }] }));
  const r = migrateTrustOnce();
  assert.equal(r.migrated, true);
  assert.deepEqual(r.trusted.sort(), [a, b, c, d, wtMain].sort());
  for (const f of [a, b, c, d, wtMain]) assert.equal(isFolderTrusted(f), true, f);
  assert.equal(isFolderTrusted(fresh), false);
  assert.ok(!listTrustedFolders().some((e) => e.path === fs.realpathSync(os.homedir())), 'home is never auto-trusted');
  assert.ok(fs.existsSync(trustMigrationMarker()));
  // Runs once: a thread created after the upgrade is not swept in, even if trust.json is deleted.
  fs.writeFileSync(path.join(home, 'chat', 'index.json'), JSON.stringify([{ id: 't_9', cwd: fresh }]));
  fs.rmSync(trustFilePath());
  _resetTrustCacheForTests();
  assert.equal(migrateTrustOnce().migrated, false);
  assert.equal(isFolderTrusted(fresh), false);
  assert.equal(isFolderTrusted(a), false, 'a deleted store is not rebuilt by a second migration');
}));

test('migration on a brand-new install trusts nothing and marks itself done', sandbox(() => {
  const r = migrateTrustOnce();
  assert.deepEqual(r, { migrated: true, trusted: [] });
  assert.ok(fs.existsSync(trustMigrationMarker()));
  assert.equal(fs.existsSync(trustFilePath()), false);
}));

// ── gate ────────────────────────────────────────────────────────────────────────────

test('gate: auto-answer of trust / MCP dialogs only in a trusted folder; ~/Projects-style roots no longer imply it', sandbox((dir) => {
  const r = repo(dir, 'clone');
  const cfg = { trustedRoots: [dir], autoAnswer: { trustFolder: true, mcpFound: true, readOutsideWorktree: true } };
  const before = autoAnswerScope(cfg, r);
  assert.equal(before.policy.trustFolder, false, 'under a trusted ROOT but not trusted: the dialog is left to the human');
  assert.equal(before.policy.mcpFound, false);
  assert.equal(before.policy.readOutsideWorktree, true, 'read-outside-worktree unchanged');
  trustFolder(r);
  const after = autoAnswerScope(cfg, r);
  assert.deepEqual(after.policy, cfg.autoAnswer, 'trusted: exactly the configured policy');
  const elsewhere = repo(fs.mkdtempSync(path.join(dir, 'x-')), 'e'); trustFolder(elsewhere);
  assert.ok(autoAnswerScope({ ...cfg, trustedRoots: [] }, elsewhere).trustedRoots.includes(elsewhere), 'a trusted folder is answered wherever it lives');
}));

test('gate: OpenCode / Koragent agents get the project-config kill switches only when untrusted', sandbox((dir) => {
  const r = repo(dir, 'r');
  assert.deepEqual(untrustedAgentEnv('opencode', r), { OPENCODE_DISABLE_PROJECT_CONFIG: '1' });
  assert.deepEqual(untrustedAgentEnv('koragent', r), { KORAGENT_DISABLE_PROJECT_CONFIG: '1' });
  assert.deepEqual(untrustedAgentEnv('claude', r), {}, 'Claude panes keep their own trust dialog');
  trustFolder(r);
  assert.deepEqual(untrustedAgentEnv('opencode', r), {});
  assert.deepEqual(untrustedAgentEnv('koragent', r), { KORAGENT_TRUST_PROJECT: '1' }, "Kora decided: Koragent's own prompt does not ask again");
  assert.deepEqual(claudeSettingSources(true), ['user', 'project', 'local']);
  assert.deepEqual(claudeSettingSources(false), ['user']);
}));

test('codex pane prepare never pre-trusts an untrusted folder in ~/.codex/config.toml; a trusted one as before', sandbox((dir) => {
  const prevCodex = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(dir, 'codex'); fs.mkdirSync(process.env.CODEX_HOME);
  try {
    const r = repo(dir, 'clone');
    const ctx = { root: r, brief: null, binPath: '/k/bin/kora.js', nodeBin: process.execPath, create: true } as any;
    const input = { agent: 'codex', cwd: r, paneId: 'p1', socketPath: '/s', binPath: '/k/bin/kora.js', command: 'codex', args: [], env: {} } as any;
    const cfgFile = path.join(process.env.CODEX_HOME, 'config.toml');
    const d1 = codexAdapter.prepare(input, ctx);
    const toml = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '';
    assert.ok(!toml.includes('trust_level'), 'no trust entry for an untrusted folder');
    assert.ok(d1.notes.some((n) => /NOT granted/.test(n)));
    trustFolder(r);
    codexAdapter.prepare(input, ctx);
    assert.match(fs.readFileSync(cfgFile, 'utf8'), /trust_level = "trusted"/);
  } finally { if (prevCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodex; }
}));
