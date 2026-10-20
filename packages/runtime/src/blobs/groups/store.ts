// GroupStore: the only writer of <KORA_HOME>/groups/<id>/group.json. Same discipline as BlobStore: read once, cache,
// tmp + rename on every write, delete moves to ~/.Trash, never rm. Membership is validated against a MemberDirectory so a
// group can never name a blob that does not exist.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from '../store';
import { CHIEF_BLOB_ID } from '../types';
import { ensureGroupWorkspace, groupHome, groupsRoot, groupsStoreDir, slugifyGroupName } from './home';
import {
  DEFAULT_RESPONDER_RULE, GROUP_INSTRUCTIONS_MAX, GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS, GROUP_NAME_MAX, RESPONDER_RULES,
  type GroupCreateInput, type GroupPatch, type GroupProfile, type MemberDirectory, type ResponderRule,
} from './types';

export class GroupStoreError extends Error {
  constructor(readonly code: 'bad-name' | 'name-taken' | 'bad-members' | 'unknown' | 'bad-confirm', message: string) { super(message); this.name = 'GroupStoreError'; }
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function newGroupId(): string {
  const b = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += BASE32[b[i] % 32];
  return `group_${s}`;
}

const isRule = (r: unknown): r is ResponderRule => RESPONDER_RULES.includes(r as ResponderRule);
const isGroup = (p: any): p is GroupProfile => !!p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.memberIds) && typeof p.leadId === 'string' && typeof p.slug === 'string';

/** The lead a group should have: the Chief when she is a member, else the first member. */
export function defaultLead(memberIds: readonly string[]): string {
  return memberIds.includes(CHIEF_BLOB_ID) ? CHIEF_BLOB_ID : memberIds[0] ?? '';
}

export interface GroupStoreOptions { members: MemberDirectory; now?: () => number }

export class GroupStore extends EventEmitter {
  private groups = new Map<string, GroupProfile>();
  private members: MemberDirectory;
  private now: () => number;

  constructor(o: GroupStoreOptions) {
    super();
    this.members = o.members;
    this.now = o.now ?? Date.now;
    this.load();
  }

  load(): void {
    this.groups.clear();
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(groupsStoreDir(), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('group_')).map((d) => d.name); } catch { /* none yet */ }
    for (const id of dirs) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(groupHome(id), 'group.json'), 'utf8'));
        if (isGroup(p)) this.groups.set(id, { ...p, rule: isRule(p.rule) ? p.rule : DEFAULT_RESPONDER_RULE, instructions: typeof p.instructions === 'string' ? p.instructions : '', pinned: p.pinned === true, archivedAt: p.archivedAt ?? null });
      } catch { /* corrupt entries are skipped, not fatal */ }
    }
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────────────
  list(opts: { includeArchived?: boolean } = {}): GroupProfile[] {
    const all = [...this.groups.values()];
    const rows = opts.includeArchived ? all : all.filter((g) => g.archivedAt == null);
    return rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.createdAt - b.createdAt);
  }
  get(id: string): GroupProfile | null { return this.groups.get(id) ?? null; }
  byName(name: string): GroupProfile | null {
    const n = name.trim().toLowerCase();
    return [...this.groups.values()].find((g) => g.archivedAt == null && g.name.toLowerCase() === n) ?? null;
  }
  /** Groups a blob belongs to. */
  forBlob(blobId: string): GroupProfile[] { return this.list().filter((g) => g.memberIds.includes(blobId)); }
  /** The group whose shared folder contains `cwd`. */
  byCwd(cwd: string): GroupProfile | null {
    const c = path.resolve(cwd);
    for (const g of this.groups.values()) if (c === g.workspace || c.startsWith(g.workspace + path.sep)) return g;
    return null;
  }

  // ── validation ───────────────────────────────────────────────────────────────────────────────────
  private checkName(name: string, exceptId?: string): string {
    const n = name.trim().replace(/\s+/g, ' ');
    if (!n) throw new GroupStoreError('bad-name', 'A group needs a name.');
    if (n.length > GROUP_NAME_MAX) throw new GroupStoreError('bad-name', `Group names are at most ${GROUP_NAME_MAX} characters.`);
    const clash = [...this.groups.values()].find((g) => g.id !== exceptId && g.archivedAt == null && g.name.toLowerCase() === n.toLowerCase());
    if (clash) throw new GroupStoreError('name-taken', `A group called ${clash.name} already exists.`);
    return n;
  }
  private checkMembers(ids: readonly string[]): string[] {
    const uniq = [...new Set(ids)];
    const unknown = uniq.filter((id) => !this.members.has(id) || !this.members.active(id));
    if (unknown.length) throw new GroupStoreError('bad-members', `Not on the team: ${unknown.join(', ')}.`);
    if (uniq.length < GROUP_MIN_MEMBERS) throw new GroupStoreError('bad-members', `A group needs at least ${GROUP_MIN_MEMBERS} members.`);
    if (uniq.length > GROUP_MAX_MEMBERS) throw new GroupStoreError('bad-members', `A group holds at most ${GROUP_MAX_MEMBERS} members.`);
    return uniq;
  }
  private uniqueSlug(name: string): string {
    const base = slugifyGroupName(name);
    const taken = new Set([...this.groups.values()].map((g) => g.slug.toLowerCase()));
    let slug = base;
    for (let i = 2; taken.has(slug) || fs.existsSync(path.join(groupsRoot(), slug)); i++) slug = `${base}-${i}`;
    return slug;
  }

  // ── writes ───────────────────────────────────────────────────────────────────────────────────────
  private persist(g: GroupProfile): void {
    writeFileAtomic(path.join(groupHome(g.id), 'group.json'), JSON.stringify(g, null, 2) + '\n');
    this.groups.set(g.id, g);
  }
  private changed(id: string | null): void { this.emit('changed', id); }

  create(input: GroupCreateInput): GroupProfile {
    const name = this.checkName(input.name);
    const memberIds = this.checkMembers(input.memberIds);
    const leadId = input.leadId ?? defaultLead(memberIds);
    if (!memberIds.includes(leadId)) throw new GroupStoreError('bad-members', 'The lead must be one of the members.');
    const id = input.id ?? newGroupId();
    if (this.groups.has(id)) throw new GroupStoreError('unknown', `group ${id} already exists`);
    const slug = this.uniqueSlug(name);
    const now = this.now();
    const g: GroupProfile = {
      id, version: 1, name, slug, memberIds, leadId, rule: isRule(input.rule) ? input.rule : DEFAULT_RESPONDER_RULE,
      instructions: (input.instructions ?? '').trim().slice(0, GROUP_INSTRUCTIONS_MAX), workspace: path.join(groupsRoot(), slug),
      pinned: false, archivedAt: null, createdAt: now, updatedAt: now,
    };
    ensureGroupWorkspace(g.workspace);
    this.persist(g);
    this.changed(id);
    return g;
  }

  update(id: string, patch: GroupPatch): GroupProfile {
    const cur = this.need(id);
    const next: GroupProfile = { ...cur, updatedAt: this.now() };
    if (patch.name !== undefined && patch.name.trim() !== cur.name) next.name = this.checkName(patch.name, id);
    if (patch.memberIds !== undefined) next.memberIds = this.checkMembers(patch.memberIds);
    if (patch.rule !== undefined) { if (!isRule(patch.rule)) throw new GroupStoreError('unknown', `Unknown responder rule ${String(patch.rule)}.`); next.rule = patch.rule; }
    if (patch.instructions !== undefined) next.instructions = patch.instructions.trim().slice(0, GROUP_INSTRUCTIONS_MAX);
    if (patch.pinned !== undefined) next.pinned = patch.pinned;
    // the lead must always be a member: a removed lead falls back to the default
    const wantLead = patch.leadId ?? next.leadId;
    next.leadId = next.memberIds.includes(wantLead) ? wantLead : defaultLead(next.memberIds);
    if (patch.leadId !== undefined && !next.memberIds.includes(patch.leadId)) throw new GroupStoreError('bad-members', 'The lead must be one of the members.');
    this.persist(next); this.changed(id);
    return next;
  }

  archive(id: string): GroupProfile { const cur = this.need(id); const next = { ...cur, archivedAt: this.now(), updatedAt: this.now() }; this.persist(next); this.changed(id); return next; }
  rehire(id: string): GroupProfile {
    const cur = this.need(id);
    if (cur.archivedAt == null) return cur;
    this.checkName(cur.name, id);
    const next = { ...cur, archivedAt: null, updatedAt: this.now() };
    this.persist(next); this.changed(id);
    return next;
  }

  /** Real delete: the profile folder AND the shared folder move to ~/.Trash. `confirmName` must equal the name. */
  delete(id: string, confirmName: string, trashDir = process.env.KORA_TRASH_DIR || path.join(os.homedir(), '.Trash')): { trashed: string[] } {
    const cur = this.need(id);
    if (confirmName.trim() !== cur.name) throw new GroupStoreError('bad-confirm', "Type the group's name to confirm.");
    const trashed: string[] = [];
    fs.mkdirSync(trashDir, { recursive: true });
    for (const src of [groupHome(id), cur.workspace]) {
      if (!fs.existsSync(src)) continue;
      let dest = path.join(trashDir, path.basename(src));
      for (let i = 2; fs.existsSync(dest); i++) dest = path.join(trashDir, `${path.basename(src)} ${i}`);
      try { fs.renameSync(src, dest); } catch { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
      trashed.push(dest);
    }
    this.groups.delete(id);
    this.changed(id);
    return { trashed };
  }

  /**
   * Drop members that left the team (retired or deleted). A group that falls below two members is archived instead of
   * silently becoming a one-person chat. Call when the blob store changes. Returns the ids touched.
   */
  prune(): string[] {
    const touched: string[] = [];
    for (const g of this.list()) {
      const keep = g.memberIds.filter((m) => this.members.has(m) && this.members.active(m));
      if (keep.length === g.memberIds.length) continue;
      touched.push(g.id);
      if (keep.length < GROUP_MIN_MEMBERS) { this.persist({ ...g, memberIds: keep, leadId: defaultLead(keep), archivedAt: this.now(), updatedAt: this.now() }); continue; }
      this.persist({ ...g, memberIds: keep, leadId: keep.includes(g.leadId) ? g.leadId : defaultLead(keep), updatedAt: this.now() });
    }
    if (touched.length) this.changed(null);
    return touched;
  }

  private need(id: string): GroupProfile {
    const g = this.groups.get(id);
    if (!g) throw new GroupStoreError('unknown', `No group ${id}.`);
    return g;
  }
}

/** Adapt a BlobStore-shaped object to the MemberDirectory the groups code needs. */
export function blobDirectoryOf(store: { get(id: string): { name: string; role: string; archivedAt: number | null } | null }): MemberDirectory {
  return {
    has: (id) => store.get(id) != null,
    active: (id) => store.get(id)?.archivedAt == null && store.get(id) != null,
    name: (id) => store.get(id)?.name ?? null,
    isChief: (id) => store.get(id)?.role === 'chief',
  };
}
