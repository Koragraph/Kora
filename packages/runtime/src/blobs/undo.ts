// The self-change journal (<KORA_HOME>/blobs/undo.jsonl): a blob editing its own SOUL or model leaves a receipt card
// with Undo; the prior value is journaled here. `profile` = Kora editing another blob (name/title/permission + SOUL as one). Append-only; an undo appends a `done` row.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { blobsStoreDir } from './home';

export interface UndoEntry { token: string; blobId: string; kind: 'soul' | 'model' | 'profile'; what: string; before: unknown; at: number }
const file = () => path.join(blobsStoreDir(), 'undo.jsonl');

export function journalChange(e: Omit<UndoEntry, 'token' | 'at'>): UndoEntry {
  const entry: UndoEntry = { ...e, token: `undo_${crypto.randomBytes(6).toString('hex')}`, at: Date.now() };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.appendFileSync(file(), JSON.stringify(entry) + '\n');
  return entry;
}

function rows(): any[] {
  try { return fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

/** The journaled change for a token that has not been undone yet. */
export function pendingUndo(token: string): UndoEntry | null {
  const all = rows();
  if (all.some((r) => r.done === token)) return null;
  return (all.find((r) => r.token === token) as UndoEntry | undefined) ?? null;
}
export function markUndone(token: string): void { fs.appendFileSync(file(), JSON.stringify({ done: token, at: Date.now() }) + '\n'); }
export function isUndone(token: string): boolean { return rows().some((r) => r.done === token); }

/** What a `profile` entry journals: everything an edit_blob can change, so one Undo restores all of it. */
export interface ProfileSnapshot { name: string; title: string; permission: 'ask' | 'auto' | 'full'; soul: string }
