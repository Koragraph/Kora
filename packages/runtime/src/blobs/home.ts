// Where blobs live (docs/bots/ARCH.md 1.3). No import from chat/home (it imports THIS file): keep it that way.
//
//   <KORA_HOME>/blobs/<blobId>/{profile.json, SOUL.md, memory.md, skills/}   profile truth (BlobStore)
//   <blobsRoot()>/<slug>/{files,outputs,scratch,downloads}                   the Finder folder, also the thread cwd
//
// blobsRoot(): KORA_BLOBS_ROOT, else ~/Blobs — except in a flavored home (Kora Dev's ~/.kora-dev, QA's ~/.kora-qa) so
// the dev app and the stable one never share folders (flavor.env's KORA_BLOBS_ROOT line is not exported by
// kora-runtime.sh, so the home name is the source of truth for the daemon).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { koraHome } from '../protocol/types';

export const BLOB_WORKSPACE_SUBDIRS = ['files', 'outputs', 'scratch', 'downloads'] as const;

export function blobsRoot(): string {
  const env = process.env.KORA_BLOBS_ROOT?.trim();
  if (env) return path.resolve(env.replace(/^~(?=$|\/)/, os.homedir()));
  const home = path.basename(koraHome());
  if (home === '.kora-dev') return path.join(os.homedir(), 'Blobs-Dev');
  if (home === '.kora-qa') return path.join(os.homedir(), 'Blobs-QA');
  return path.join(os.homedir(), 'Blobs');
}

/** <KORA_HOME>/blobs — profile store, memory.db, jobs. */
export function blobsStoreDir(): string { return path.join(koraHome(), 'blobs'); }
export function blobHome(blobId: string): string { return path.join(blobsStoreDir(), blobId); }

/** realpath of the nearest existing ancestor + the missing tail (a not-yet-created subfolder still resolves symlinked parents). */
function real(p: string): string {
  let cur = path.resolve(p); const tail: string[] = [];
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) { tail.unshift(path.basename(cur)); cur = path.dirname(cur); }
  try { return path.join(fs.realpathSync(cur), ...tail); } catch { return path.resolve(p); }
}

/** True when `cwd` is a blob's workspace or anything inside it. */
export function isBlobsCwd(cwd: string | null | undefined): boolean {
  return !!cwd && blobWorkspaceRootOf(cwd) !== null;
}

/** The blob workspace (`<blobsRoot>/<slug>`) containing `cwd`, or null. */
export function blobWorkspaceRootOf(cwd: string): string | null {
  const root = real(blobsRoot());
  const c = real(cwd);
  if (!c.startsWith(root + path.sep)) return null;
  const slug = c.slice(root.length + 1).split(path.sep)[0];
  return slug ? path.join(root, slug) : null;
}

/** The folder name (slug) of the blob owning `cwd`, or null. */
export function blobSlugOfCwd(cwd: string): string | null {
  const r = blobWorkspaceRootOf(cwd);
  return r ? path.basename(r) : null;
}

export function ensureBlobWorkspace(root: string): void {
  for (const d of BLOB_WORKSPACE_SUBDIRS) fs.mkdirSync(path.join(root, d), { recursive: true });
}

/** A folder name from a blob name: letters/digits/dash, never empty, never a dot-name. */
export function slugifyBlobName(name: string): string {
  const s = name.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return s || 'blob';
}
