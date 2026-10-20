// BlobStore: the only writer of <KORA_HOME>/blobs/<id>/profile.json + SOUL.md (docs/bots/ARCH.md 1.1). Reads happen
// once at construction and after each of our own writes, so prompt assembly (which must stay synchronous) reads the
// in-memory cache. Every write is tmp + rename. Delete moves the folder to ~/.Trash by rename, never rm.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { blobHome, blobsRoot, blobsStoreDir, ensureBlobWorkspace, slugifyBlobName } from './home';
import { CHIEF_BLOB_ID, type BlobCreateInput, type BlobDefaults, type BlobEngine, type BlobFlags, type BlobProfile, type BlobProfilePatch, type BlobToolGrants } from './types';

export const DEFAULT_TOOL_GRANTS: BlobToolGrants = { apps: { mode: 'none', allow: [] }, mcp: [], computer: { browser: false, vm: false } };
export const MAX_SOUL_CHARS = 12_000;
export const MAX_ABOUT_ME_CHARS = 24_000;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export class BlobStoreError extends Error {
  constructor(readonly code: 'name-taken' | 'unknown' | 'chief-protected' | 'bad-name' | 'not-archived' | 'bad-confirm', message: string) { super(message); this.name = 'BlobStoreError'; }
}

/** tmp + rename: a crash mid-write leaves the old file, never a torn one. */
export function writeFileAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

export function newBlobId(): string {
  const b = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += BASE32[b[i] % 32];
  return `blob_${s}`;
}

const isProfile = (p: any): p is BlobProfile => !!p && typeof p.id === 'string' && typeof p.name === 'string' && p.engine && typeof p.engine.instanceId === 'string' && typeof p.slug === 'string';

export class BlobStore extends EventEmitter {
  private profiles = new Map<string, BlobProfile>();
  private souls = new Map<string, string>();

  constructor() {
    super();
    this.load();
  }

  /** (Re)read every profile from disk. Corrupt entries are skipped, not fatal. */
  load(): void {
    this.profiles.clear(); this.souls.clear();
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(blobsStoreDir(), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('blob_')).map((d) => d.name); } catch { /* none yet */ }
    for (const id of dirs) {
      const p = readJson<unknown>(path.join(blobHome(id), 'profile.json'), null);
      if (!isProfile(p)) continue;
      this.profiles.set(id, p);
      this.souls.set(id, this.readSoulFile(id));
    }
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────────────
  list(opts: { includeArchived?: boolean } = {}): BlobProfile[] {
    const all = [...this.profiles.values()];
    const rows = opts.includeArchived ? all : all.filter((b) => b.archivedAt == null);
    return rows.sort((a, b) => (a.role === 'chief' ? -1 : 0) - (b.role === 'chief' ? -1 : 0) || a.createdAt - b.createdAt);
  }
  get(id: string): BlobProfile | null { return this.profiles.get(id) ?? null; }
  byName(name: string): BlobProfile | null {
    const n = name.trim().toLowerCase();
    return [...this.profiles.values()].find((b) => b.archivedAt == null && b.name.toLowerCase() === n) ?? null;
  }
  /** The blob whose workspace folder contains `cwd`. */
  byCwd(cwd: string): BlobProfile | null {
    let c = cwd; try { c = fs.realpathSync(cwd); } catch { c = path.resolve(cwd); }
    for (const b of this.profiles.values()) {
      let w = b.workspace; try { w = fs.realpathSync(b.workspace); } catch { /* not created yet */ }
      if (c === w || c.startsWith(w + path.sep)) return b;
    }
    return null;
  }
  soul(id: string): string { return this.souls.get(id) ?? ''; }
  private readSoulFile(id: string): string { try { return fs.readFileSync(path.join(blobHome(id), 'SOUL.md'), 'utf8').replace(/\s+$/, ''); } catch { return ''; } }

  // ── writes ───────────────────────────────────────────────────────────────────────────────────────
  private persist(p: BlobProfile): void {
    writeFileAtomic(path.join(blobHome(p.id), 'profile.json'), JSON.stringify(p, null, 2) + '\n');
    this.profiles.set(p.id, p);
  }
  private changed(id: string): void { this.emit('changed', id); }

  private assertNameFree(name: string, exceptId?: string): void {
    const n = name.trim();
    if (!n) throw new BlobStoreError('bad-name', 'A blob needs a name.');
    if (n.length > 40) throw new BlobStoreError('bad-name', 'Names are at most 40 characters.');
    const clash = [...this.profiles.values()].find((b) => b.id !== exceptId && b.archivedAt == null && b.name.toLowerCase() === n.toLowerCase());
    if (clash) throw new BlobStoreError('name-taken', `${clash.name} is already on the team. Names must be different (messages are routed by name).`);
  }

  private uniqueSlug(name: string): string {
    const base = slugifyBlobName(name);
    const taken = new Set([...this.profiles.values()].map((b) => b.slug.toLowerCase()));
    let slug = base;
    // also never adopt a folder that already exists on disk (a deleted-then-recreated name, or the user's own folder)
    for (let i = 2; taken.has(slug.toLowerCase()) || fs.existsSync(path.join(blobsRoot(), slug)); i++) slug = `${base}-${i}`;
    return slug;
  }

  create(input: BlobCreateInput): BlobProfile {
    this.assertNameFree(input.name);
    const id = input.id ?? newBlobId();
    if (this.profiles.has(id)) throw new BlobStoreError('unknown', `blob ${id} already exists`);
    const now = Date.now();
    const slug = this.uniqueSlug(input.name);
    const workspace = path.join(blobsRoot(), slug);
    const p: BlobProfile = {
      id, version: 1, name: input.name.trim(), title: input.title.trim(), role: input.role ?? 'member', teamId: 'default',
      engine: input.engine, permission: input.permission ?? 'auto', outfit: input.outfit ?? null,
      toolGrants: input.toolGrants ?? DEFAULT_TOOL_GRANTS, slug, workspace, templateId: input.templateId ?? null,
      ...(input.templateVersion != null ? { templateVersion: input.templateVersion } : {}),
      pinned: input.pinned ?? false, hidden: false, archivedAt: null, createdAt: now, updatedAt: now,
    };
    ensureBlobWorkspace(workspace);
    fs.mkdirSync(path.join(blobHome(id), 'skills'), { recursive: true });
    this.persist(p);
    this.writeSoul(id, input.soul, { silent: true });
    this.changed(id);
    return p;
  }

  update(id: string, patch: BlobProfilePatch, opts: { promptNeutral?: boolean } = {}): BlobProfile {
    const cur = this.need(id);
    if (patch.name !== undefined && patch.name.trim() !== cur.name) this.assertNameFree(patch.name, id);
    const next: BlobProfile = { ...cur, updatedAt: Date.now() };
    for (const k of Object.keys(patch) as Array<keyof BlobProfilePatch>) {
      const v = patch[k];
      if (v === undefined) continue;
      (next as any)[k] = k === 'name' || k === 'title' ? String(v).trim() : v;
    }
    this.persist(next);
    // `promptNeutral`: the change is not an input of the system prompt (a standing approval), so live sessions are not restarted for it.
    this.emit('changed', id, opts.promptNeutral ? { prompt: false } : undefined);
    return next;
  }

  /** Record which starter-template version the SOUL is at (no change event: nothing the model sees moved). */
  setTemplateVersion(id: string, v: number): void { const p = this.need(id); if (p.templateVersion !== v) this.persist({ ...p, templateVersion: v }); }

  writeSoul(id: string, text: string, opts: { silent?: boolean } = {}): void {
    this.need(id);
    const t = text.length > MAX_SOUL_CHARS ? text.slice(0, MAX_SOUL_CHARS) : text;
    writeFileAtomic(path.join(blobHome(id), 'SOUL.md'), t.endsWith('\n') || !t ? t : t + '\n');
    this.souls.set(id, t.replace(/\s+$/, ''));
    if (!opts.silent) { this.touch(id); this.changed(id); }
  }
  private touch(id: string): void { const p = this.need(id); this.persist({ ...p, updatedAt: Date.now() }); }

  archive(id: string): BlobProfile {
    const cur = this.need(id);
    if (cur.role === 'chief') throw new BlobStoreError('chief-protected', 'Kora is the Chief and cannot be retired.');
    const next = { ...cur, archivedAt: Date.now(), updatedAt: Date.now() };
    this.persist(next); this.changed(id);
    return next;
  }
  rehire(id: string): BlobProfile {
    const cur = this.need(id);
    if (cur.archivedAt == null) return cur;
    this.assertNameFree(cur.name, id);
    const next = { ...cur, archivedAt: null, updatedAt: Date.now() };
    this.persist(next); this.changed(id);
    return next;
  }

  /** Real delete: profile folder AND workspace move to ~/.Trash (dedupe suffix). `confirmName` must equal the name. */
  delete(id: string, confirmName: string, trashDir = path.join(os.homedir(), '.Trash')): { trashed: string[] } {
    const cur = this.need(id);
    if (cur.role === 'chief') throw new BlobStoreError('chief-protected', 'Kora is the Chief and cannot be deleted.');
    if (confirmName.trim() !== cur.name) throw new BlobStoreError('bad-confirm', 'Type the blob\'s name to confirm.');
    const trashed: string[] = [];
    fs.mkdirSync(trashDir, { recursive: true });
    for (const src of [blobHome(id), cur.workspace]) {
      if (!fs.existsSync(src)) continue;
      let dest = path.join(trashDir, path.basename(src));
      for (let i = 2; fs.existsSync(dest); i++) dest = path.join(trashDir, `${path.basename(src)} ${i}`);
      try { fs.renameSync(src, dest); } catch { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
      trashed.push(dest);
    }
    this.profiles.delete(id); this.souls.delete(id);
    this.changed(id);
    return { trashed };
  }

  /** A copy with a free name ("Popo copy"), the same SOUL, outfit and engine. Memory is NOT copied. */
  duplicate(id: string): BlobProfile {
    const src = this.need(id);
    let name = `${src.name} copy`;
    for (let i = 2; this.byName(name); i++) name = `${src.name} copy ${i}`;
    return this.create({ name, title: src.title, soul: this.soul(id), engine: src.engine, permission: src.permission, outfit: src.outfit, toolGrants: src.toolGrants, templateId: src.templateId });
  }

  private need(id: string): BlobProfile {
    const p = this.profiles.get(id);
    if (!p) throw new BlobStoreError('unknown', `No blob ${id}.`);
    return p;
  }

  // ── workspace-wide settings ──────────────────────────────────────────────────────────────────────
  private settingsFile() { return path.join(blobsStoreDir(), '_settings.json'); }
  flags(): BlobFlags {
    const j = readJson<Partial<BlobFlags>>(this.settingsFile(), {});
    return { concurrencyWarningDismissed: j.concurrencyWarningDismissed === true, galleryDismissed: j.galleryDismissed === true, claudeMemoryFallback: j.claudeMemoryFallback === true };
  }
  setFlag(key: keyof BlobFlags, value: boolean): BlobFlags {
    const f = { ...this.flags(), [key]: value };
    writeFileAtomic(this.settingsFile(), JSON.stringify(f, null, 2) + '\n');
    this.emit('changed', null);
    return f;
  }

  /** "Use Claude for memory when no free model" (the `claudeMemoryFallback` flag; Settings > Blobs). Off by default; capped at 150 calls a day (extractor.ts). */
  memorySettings(): { claudeFallback: boolean } { return { claudeFallback: this.flags().claudeMemoryFallback }; }
  setMemorySettings(v: { claudeFallback: boolean }): void { this.setFlag('claudeMemoryFallback', v.claudeFallback === true); }

  private defaultsFile() { return path.join(path.dirname(blobsStoreDir()), 'blob-defaults.json'); }
  defaults(): BlobDefaults {
    const j = readJson<Partial<BlobDefaults>>(this.defaultsFile(), {});
    const e = j.engine as BlobEngine | null | undefined;
    return {
      engine: e && typeof e.instanceId === 'string' && typeof e.model === 'string' ? { instanceId: e.instanceId, model: e.model, effort: e.effort ?? null } : null,
      permission: j.permission === 'ask' || j.permission === 'full' ? j.permission : 'auto',
      soulTemplate: typeof j.soulTemplate === 'string' ? j.soulTemplate : '',
    };
  }
  setDefaults(d: BlobDefaults): BlobDefaults {
    writeFileAtomic(this.defaultsFile(), JSON.stringify(d, null, 2) + '\n');
    this.emit('changed', null);
    return this.defaults();
  }

  private aboutMeFile() { return path.join(path.dirname(blobsStoreDir()), 'profile', 'about-me.md'); }
  aboutMe(): string { try { return fs.readFileSync(this.aboutMeFile(), 'utf8'); } catch { return ''; } }
  setAboutMe(text: string): string {
    const t = text.slice(0, MAX_ABOUT_ME_CHARS);
    writeFileAtomic(this.aboutMeFile(), t);
    this.emit('aboutMe');
    return t;
  }

  // ── the Chief ────────────────────────────────────────────────────────────────────────────────────
  /** Create Kora (the fixed id) if absent. Idempotent; never overwrites an edited Kora. */
  ensureKora(engine: BlobEngine, soul: string): BlobProfile {
    const cur = this.profiles.get(CHIEF_BLOB_ID);
    if (cur) { if (!fs.existsSync(cur.workspace)) ensureBlobWorkspace(cur.workspace); return cur; }
    return this.create({
      id: CHIEF_BLOB_ID, name: 'Kora', title: 'Chief', role: 'chief', soul, engine, permission: 'auto', pinned: true,
      outfit: { head: 'crown', face: null, neck: 'bow-tie' },
    });
  }
}
