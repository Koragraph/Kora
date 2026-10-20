// Where groups live. Profile truth: <KORA_HOME>/groups/<groupId>/group.json (SPEC data layout). The shared Finder
// folder: <blobsRoot()>/_groups/<slug>/{files,outputs,scratch}. The leading underscore keeps it from ever colliding with a
// blob slug (slugifyBlobName turns "_groups" into "groups"), and sorts it away from the blobs in Finder.
import fs from 'node:fs';
import path from 'node:path';
import { blobsRoot } from '../home';
import { koraHome } from '../../protocol/types';

export const GROUP_WORKSPACE_SUBDIRS = ['files', 'outputs', 'scratch'] as const;
export const GROUPS_FOLDER = '_groups';

export function groupsStoreDir(): string { return path.join(koraHome(), 'groups'); }
export function groupHome(groupId: string): string { return path.join(groupsStoreDir(), groupId); }
export function groupsRoot(): string { return path.join(blobsRoot(), GROUPS_FOLDER); }

export function ensureGroupWorkspace(root: string): void {
  for (const d of GROUP_WORKSPACE_SUBDIRS) fs.mkdirSync(path.join(root, d), { recursive: true });
}

/** A folder name from a group name: letters, digits, dash; never empty. */
export function slugifyGroupName(name: string): string {
  const s = name.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return s || 'group';
}
