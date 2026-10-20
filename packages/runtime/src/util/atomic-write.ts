// Atomic replace of a file other processes may read at the same moment. A plain writeFileSync truncates first and
// writes second; a reader in between sees an EMPTY file. Kora's rulebook writer is read-modify-write, so two Kora
// processes refreshing one CLAUDE.md (stable + Kora Dev on one repo, a daemon + `kora setup`) wiped the user's own text
// outside the managed block: the second saw "", appended only its block, and wrote that back (deep audit 2026-10-13
// A2-7). tmp in the same directory + rename: a reader sees the old file or the new one, never a torn one. The file's
// mode is kept (a 0600 settings file stays 0600), and a symlink stays a symlink: the write goes to the file it points at
// (CLAUDE.md -> AGENTS.md, a dotfiles-managed ~/.codex/config.toml). Callers that must not follow a link check first.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { installWindowsRenameRetry } from './win-fs-retry';

installWindowsRenameRetry();   // also for a process that never went through cli/main.ts

export function writeFileAtomic(path0: string, data: string, opts: { mode?: number } = {}): void {
  let file = path0;
  try { file = fs.realpathSync(path0); } catch { /* does not exist yet */ }
  let mode = opts.mode;
  if (mode === undefined) { try { mode = fs.statSync(file).mode & 0o7777; } catch { mode = undefined; } }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.kora-${process.pid}-${crypto.randomBytes(3).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);   // retried on Windows by util/win-fs-retry.ts
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* fine */ } throw e; }
}

