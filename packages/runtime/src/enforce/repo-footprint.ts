// What Kora wrote into the user's repos, and how to take it back.
//
// The first send in a trusted repo writes a CLAUDE.md / AGENTS.md block and .claude/settings.local.json hooks there
// (enforce/*). "Remove project" used to leave all of it behind, and because the project record was the only thing
// `kora uninstall` could find the repo by, nothing could ever clean it. Two pieces fix that:
//   - a ledger (<KORA_HOME>/kora-daemon/touched-repos.json) of every repo Kora wrote into, read by `kora uninstall`
//   - removeRepoFootprint(root): remove Kora's managed entries from that repo and its folder trust, drop it from the ledger
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';

const MAX_LEDGER = 2000;
const ledgerFile = (home = koraHome()) => path.join(home, 'kora-daemon', 'touched-repos.json');

function readLedger(home = koraHome()): string[] {
  try {
    const v = JSON.parse(fs.readFileSync(ledgerFile(home), 'utf8'));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && path.isAbsolute(x)) : [];
  } catch { return []; }
}
function writeLedger(list: string[]): void {
  try {
    fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true, mode: 0o700 });
    const tmp = `${ledgerFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list.slice(-MAX_LEDGER), null, 1), { mode: 0o600 });
    fs.renameSync(tmp, ledgerFile());
  } catch { /* the ledger is a convenience for uninstall; never fail a write path over it */ }
}

/** Every repo Kora has written managed entries into (existing or not; the caller filters). */
export function touchedRepos(home = koraHome()): string[] { return readLedger(home); }

/** Note that Kora wrote into `root`. Cheap and idempotent (one read, a write only for a new repo). */
export function recordTouchedRepo(root: string): void {
  if (!root || !path.isAbsolute(root)) return;
  const list = readLedger();
  if (list.includes(root)) return;
  writeLedger([...list, root]);
}

export function forgetTouchedRepo(root: string): void {
  const list = readLedger();
  if (list.includes(root)) writeLedger(list.filter((r) => r !== root));
}

export interface FootprintResult { root: string; removed: string[]; trustRevoked: boolean }

/**
 * Take Kora's managed blocks, hooks and MCP entries out of one repo (only Kora's own entries: whatever the user wrote
 * stays), drop its folder trust and its ledger entry. The per-machine PATH shims are NOT touched (other repos use them).
 */
export async function removeRepoFootprint(cwd: string): Promise<FootprintResult> {
  const { createEnforcer } = require('./enforcer') as typeof import('./enforcer');
  const { gitTopLevel } = require('../graph/embedded') as typeof import('../graph/embedded');
  const root = (() => { try { return gitTopLevel(cwd) || path.resolve(cwd); } catch { return path.resolve(cwd); } })();
  const removed: string[] = [];
  try {
    const r = await createEnforcer().uninstall({ agent: 'all', cwd: root, keepShims: true });
    for (const x of r.results) if (x.action === 'removed') removed.push(x.file);
  } catch { /* partial cleanup is still progress */ }
  if (fs.existsSync(path.join(root, '.git'))) {
    try {
      const { kg } = require('../graph/embedded') as typeof import('../graph/embedded');
      for (const x of kg('src/services/git-hooks.js').uninstallHooks(root).results as { action: string; file?: string }[])
        if (x.action === 'removed' || x.action === 'unhooked') removed.push(x.file ?? '.git/hooks');
    } catch { /* no hooks dir */ }
  }
  let trustRevoked = false;
  try {
    const { revokeFolderTrust, trustStatus } = require('../trust/store') as typeof import('../trust/store');
    const was = trustStatus(cwd).trusted;
    revokeFolderTrust(cwd);
    trustRevoked = was && !trustStatus(cwd).trusted;
  } catch { /* trust store unreadable: leave it */ }
  forgetTouchedRepo(root);
  if (root !== cwd) forgetTouchedRepo(cwd);
  return { root, removed: [...new Set(removed)], trustRevoked };
}
