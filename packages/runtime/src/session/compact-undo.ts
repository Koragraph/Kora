// Undo for a compaction Kora's chip started (overnight B5). `/compact` rewrites the context into a summary; if the summary
// lost something the user needed, there is no way back inside Claude Code. Before the chip's `/compact` goes out, the thread's
// transcript is copied to <KORA_HOME>/compact-undo/<thread>.jsonl; "Undo" turns that copy into a NEW session beside the
// current one and points the thread at it (the compacted session stays on disk). One snapshot per thread, the latest.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { koraHome } from '../protocol/types';
import os from 'node:os';
import { claudeSlug, locateTranscript, pruneText } from './prune';

const SAFE = /^[A-Za-z0-9._-]{1,120}$/;
const dirOf = (home: string): string => path.join(home, 'compact-undo');

export const MAX_SNAPSHOT_BYTES = 150 * 1024 * 1024;

export interface Snapshot { sessionId: string; cwd: string; at: number; bytes: number }

/** Copy the transcript aside. Async file copy (no event-loop work); false when there is nothing to copy. */
export async function snapshotBeforeCompact(a: { threadId: string; sessionId: string; cwd: string; configDir?: string | null; home?: string }): Promise<boolean> {
  try {
    if (!SAFE.test(a.threadId)) return false;
    const src = locateTranscript(a.sessionId, a.cwd, a.configDir);
    if (!src) return false;
    // A transcript this big is not copied for an undo (disk, and the copy would outlast the 3 s the compaction waits for it).
    if ((await fs.promises.stat(src)).size > MAX_SNAPSHOT_BYTES) return false;
    const dir = dirOf(a.home ?? koraHome());
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const dest = path.join(dir, `${a.threadId}.jsonl`);
    await fs.promises.copyFile(src, `${dest}.tmp`);
    await fs.promises.rename(`${dest}.tmp`, dest);
    const meta: Snapshot = { sessionId: a.sessionId, cwd: a.cwd, at: Date.now(), bytes: (await fs.promises.stat(dest)).size };
    await fs.promises.writeFile(path.join(dir, `${a.threadId}.json`), JSON.stringify(meta), { mode: 0o600 });
    return true;
  } catch { try { fs.unlinkSync(path.join(dirOf(a.home ?? koraHome()), `${a.threadId}.jsonl.tmp`)); } catch { /* none */ } return false; }
}

/** A deleted thread's undo copy goes with it. */
export function dropSnapshot(threadId: string, home: string = koraHome()): void {
  if (!SAFE.test(threadId)) return;
  for (const ext of ['jsonl', 'json', 'jsonl.tmp']) { try { fs.unlinkSync(path.join(dirOf(home), `${threadId}.${ext}`)); } catch { /* none */ } }
}

export function readSnapshot(threadId: string, home: string = koraHome()): Snapshot | null {
  try {
    if (!SAFE.test(threadId)) return null;
    const m = JSON.parse(fs.readFileSync(path.join(dirOf(home), `${threadId}.json`), 'utf8')) as Snapshot;
    return m && typeof m.sessionId === 'string' && fs.existsSync(path.join(dirOf(home), `${threadId}.jsonl`)) ? m : null;
  } catch { return null; }
}

/**
 * Make the pre-compaction transcript a live session again: a new session id, written beside the thread's current
 * transcript. The caller points the thread at `sessionId` and restarts its session. Null when nothing can be restored.
 */
export function restoreSnapshot(a: { threadId: string; configDir?: string | null; home?: string }): { sessionId: string; file: string } | null {
  try {
    const home = a.home ?? koraHome();
    const snap = readSnapshot(a.threadId, home);
    if (!snap) return null;
    // The compacted session's own file may be gone (a later cold resume replaced a Kora-made fork of it): the snapshot is a full
    // copy, so it only needs the right folder to be written into.
    const live = locateTranscript(snap.sessionId, snap.cwd, a.configDir)
      ?? path.join(path.join(a.configDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'), 'projects'), claudeSlug(snap.cwd), `${snap.sessionId}.jsonl`);
    if (!fs.existsSync(path.dirname(live))) return null;
    const id = randomUUID();
    const text = fs.readFileSync(path.join(dirOf(home), `${a.threadId}.jsonl`), 'utf8');
    const out = pruneText(text, { keepTurns: Number.MAX_SAFE_INTEGER, sessionId: id }).text;
    const file = path.join(path.dirname(live), `${id}.jsonl`);
    fs.writeFileSync(`${file}.tmp`, out, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    for (const ext of ['jsonl', 'json']) { try { fs.unlinkSync(path.join(dirOf(home), `${a.threadId}.${ext}`)); } catch { /* gone */ } }
    return { sessionId: id, file };
  } catch { return null; }
}
