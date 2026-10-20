// Capability cards (docs/bots/SPEC.md "Knowing the team", ARCH 6.2): a compact, deterministic summary of each blob that
// Kora carries in her prompt every turn. Built by CODE from the profile, skills, apps, status and the delegation log -
// never written by a model. ~40-80 tokens each; rebuilt when anything they depend on changes; archived blobs are left out.
//
//   Popo · Researcher · Sonnet · Auto · idle
//   does: deep web research -> sourced brief in outputs/
//   skills: web-research, citation-check · apps: none · computer: browser
//   lately: "EV charger market brief" (done 2d ago), "Lisbon neighbourhoods" (running)
//   good at (from past jobs): market scans, travel research · slow at: spreadsheets
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { blobHome } from './home';
import { DAY_MS, type BlobStats, type DelegationLog } from './delegation';
import { templateJob } from './templates';
import type { JobStore } from './jobs';
import { CHIEF_BLOB_ID, type BlobProfile } from './types';

/** Hard budget per card on a conservative chars/4 estimate (the SPEC's own example card is ~81 by it; a real tokenizer counts ~75). */
export const CARD_TOKEN_BUDGET = 84;
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

export interface LatelyItem { title: string; /** "done 2d ago" | "running" | "failed 1h ago" ... */ what: string }

export interface CapabilityCard {
  blobId: string;
  name: string;
  title: string;
  model: string;
  permission: string;
  does: string;
  skills: string[];
  apps: string;
  computer: string;
  lately: LatelyItem[];
  goodAt: string[];
  slowAt: string[];
}

export interface CardContext {
  /** Names of the skills this blob has beyond the shared document pack. */
  skills?: string[];
  stats?: Pick<BlobStats, 'goodAt' | 'slowAt'>;
  lately?: LatelyItem[];
  /** Override the "does:" line. */
  does?: string;
}

// ── formatting helpers ───────────────────────────────────────────────────────────────────────────────────

export function modelLabel(model: string): string {
  const fam = /(opus|sonnet|haiku|fable)/i.exec(model);
  if (fam) return fam[1][0].toUpperCase() + fam[1].slice(1).toLowerCase();
  return model.length > 14 ? model.slice(0, 14) : model;
}
const PERM: Record<string, string> = { ask: 'Ask', auto: 'Auto', full: 'Full access' };

export function agoLabel(ms: number): string {
  if (ms < 60_000) return 'just now';
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < DAY_MS) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / DAY_MS)}d ago`;
}

const humanKind = (k: string) => k.replace(/-/g, ' ');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** "does:" for a blob: its template's job, else the first sentence of its SOUL (headings and bullets skipped). */
export function doesLine(profile: BlobProfile, soul: string): string {
  const t = templateJob(profile.templateId);
  if (t) return t;
  for (const raw of soul.split('\n')) {
    const l = raw.trim().replace(/^[#>*\-\s]+/, '');
    if (l.length < 12) continue;
    const m = /^(.+?[.!?])(\s|$)/.exec(l);
    const s = (m ? m[1] : l).replace(/^You are [^,.]+,?\s*(the |an? )?/i, '').trim();
    return clip(s || l, 90);
  }
  return profile.title.toLowerCase();
}

function appsLabel(p: BlobProfile): string {
  const a = p.toolGrants.apps;
  if (a.mode === 'all') return 'all connected';
  if (a.mode === 'list' && a.allow.length) return a.allow.slice(0, 3).join('/') + (a.allow.length > 3 ? `+${a.allow.length - 3}` : '');
  return 'none';
}
function computerLabel(p: BlobProfile): string {
  const c = p.toolGrants.computer;
  // every member blob has its own browser (Phase 6); Kora, the Chief, delegates instead of browsing
  const browser = p.role !== 'chief' || c.browser;
  return browser && c.vm ? 'browser+vm' : c.vm ? 'vm' : browser ? 'browser' : 'none';
}

export function buildCard(profile: BlobProfile, ctx: CardContext & { soul?: string } = {}): CapabilityCard {
  return {
    blobId: profile.id, name: profile.name, title: profile.title, model: modelLabel(profile.engine.model), permission: PERM[profile.permission] ?? profile.permission,
    does: ctx.does ?? doesLine(profile, ctx.soul ?? ''), skills: [...(ctx.skills ?? [])], apps: appsLabel(profile), computer: computerLabel(profile),
    lately: [...(ctx.lately ?? [])], goodAt: [...(ctx.stats?.goodAt ?? [])], slowAt: [...(ctx.stats?.slowAt ?? [])],
  };
}

/** One card as text. `status` is the live word (idle / working / busy / waiting on you); omitted for hashing. */
export function renderCard(c: CapabilityCard, status?: string | null): string {
  let does = c.does, lately = c.lately.slice(0, 3), skills = c.skills.slice(0, 4), good = c.goodAt.slice(0, 2), slow = c.slowAt.slice(0, 2), apps = c.apps;
  const build = (): string => {
    const head = [c.name, c.title, c.model, c.permission, ...(status ? [status] : [])].join(' \u00b7 ');
    const lines = [head, `does: ${does}`, `skills: ${skills.length ? skills.join(', ') : 'documents only'} \u00b7 apps: ${apps} \u00b7 computer: ${c.computer}`];
    if (lately.length) lines.push('lately: ' + lately.map((l) => `"${clip(l.title, 36)}" (${l.what})`).join(', '));
    const g = good.length ? `good at (from past jobs): ${good.map(humanKind).join(', ')}` : '';
    const sl = slow.length ? `slow at: ${slow.map(humanKind).join(', ')}` : '';
    if (g || sl) lines.push([g, sl].filter(Boolean).join(' \u00b7 '));
    return lines.join('\n');
  };
  // shrink until it fits the budget: fewer lately items, fewer skills, a shorter does line, fewer good/slow kinds
  let text = build();
  for (let guard = 0; estimateTokens(text) > CARD_TOKEN_BUDGET && guard < 16; guard++) {
    if (lately.length > 1) lately = lately.slice(0, lately.length - 1);
    else if (skills.length > 2) skills = skills.slice(0, skills.length - 1);
    else if (does.length > 50) does = clip(does, Math.max(50, does.length - 20));
    else if (lately.length) lately = [];
    else if (slow.length > 1) slow = slow.slice(0, 1);
    else if (good.length > 1) good = good.slice(0, 1);
    else if (skills.length) skills = skills.slice(0, 1);
    else if (apps.length > 14) apps = clip(apps, 14);
    else if (does.length > 30) does = clip(does, 30);
    else break;
    text = build();
  }
  return text;
}

export function renderCards(cards: readonly CapabilityCard[], statusOf?: (blobId: string) => string | null): string {
  return cards.map((c) => renderCard(c, statusOf?.(c.blobId) ?? null)).join('\n\n');
}

/** Hash of the cards WITHOUT live status: it changes only when the team or its record changes. */
export function cardsHash(cards: readonly CapabilityCard[]): string {
  return crypto.createHash('sha1').update(cards.map((c) => renderCard(c)).join('\u0001')).digest('hex').slice(0, 12);
}

/** The live status word. */
export function statusWord(s: { running: number; needsYou: boolean; max?: number }): string {
  if (s.needsYou) return 'waiting on you';
  if (s.running >= (s.max ?? 3)) return 'busy';
  return s.running > 0 ? `working (${s.running})` : 'idle';
}

// ── the live index ───────────────────────────────────────────────────────────────────────────────────────

export interface TeamStoreLike {
  list(opts?: { includeArchived?: boolean }): BlobProfile[];
  soul(id: string): string;
  on?(event: 'changed', fn: (id: string | null) => void): unknown;
  off?(event: 'changed', fn: (id: string | null) => void): unknown;
}

export interface TeamCardsOptions {
  store: TeamStoreLike;
  log: DelegationLog;
  jobs: JobStore;
  /** Names of a blob's own skills; default: the sub-folders of <blobHome>/skills. */
  skillsOf?: (blobId: string) => string[];
  /** Live status word; default: derived from active job steps. The wiring passes the bridge's running count. */
  statusOf?: (blobId: string) => string;
  now?: () => number;
  /** Include the Chief's own card (default false: she is the reader). */
  includeChief?: boolean;
}

function defaultSkillsOf(blobId: string): string[] {
  try { return fs.readdirSync(path.join(blobHome(blobId), 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort(); } catch { return []; }
}

/** Cached cards, rebuilt lazily after any store / log / job change. Emits "changed" when the hash differs. */
export class TeamCards extends EventEmitter {
  private o: TeamCardsOptions;
  private cache: CapabilityCard[] | null = null;
  private lastHash = '';
  private unsubs: Array<() => void> = [];

  constructor(o: TeamCardsOptions) {
    super();
    this.o = o;
    const dirty = () => this.invalidate();
    o.store.on?.('changed', dirty); this.unsubs.push(() => o.store.off?.('changed', dirty));
    o.log.on('appended', dirty); this.unsubs.push(() => o.log.off('appended', dirty));
    o.jobs.on('changed', dirty); this.unsubs.push(() => o.jobs.off('changed', dirty));
  }

  dispose(): void { for (const f of this.unsubs) f(); this.unsubs = []; }

  invalidate(): void {
    this.cache = null;
    if (this.lastHash) queueMicrotask(() => { const h = this.hash(); if (h !== this.lastHash) { this.lastHash = h; this.emit('changed', h); } });
  }

  cards(): CapabilityCard[] {
    if (this.cache) return this.cache;
    const now = (this.o.now ?? Date.now)();
    const out: CapabilityCard[] = [];
    for (const p of this.o.store.list()) {
      if (p.archivedAt != null) continue;
      if (p.id === CHIEF_BLOB_ID && !this.o.includeChief) continue;
      const lately: LatelyItem[] = [];
      for (const a of this.o.jobs.activeStepsOf(p.id)) lately.push({ title: a.step.title, what: a.step.state === 'queued' ? 'queued' : a.step.state === 'waiting' ? 'needs the user' : 'running' });
      for (const r of this.o.log.lately(p.id, 3)) lately.push({ title: r.title, what: `${r.outcome} ${agoLabel(now - r.ts)}` });
      out.push(buildCard(p, { soul: this.o.store.soul(p.id), skills: (this.o.skillsOf ?? defaultSkillsOf)(p.id), stats: this.o.log.stats(p.id, now), lately: lately.slice(0, 3) }));
    }
    this.cache = out;
    return out;
  }

  hash(): string { return cardsHash(this.cards()); }
  /** Mark the current hash as the one the prompt carries (so `changed` fires only on a real difference). */
  markSeen(): string { this.lastHash = this.hash(); return this.lastHash; }

  render(withStatus = true): string { return renderCards(this.cards(), withStatus ? this.o.statusOf ?? ((id) => this.defaultStatus(id)) : undefined); }

  private defaultStatus(blobId: string): string {
    const act = this.o.jobs.activeStepsOf(blobId);
    return statusWord({ running: act.filter((a) => a.step.state === 'running').length, needsYou: act.some((a) => a.step.state === 'waiting') });
  }

  /** The block Kora's prompt carries. */
  teamBlock(): string {
    const body = this.render(true);
    return body ? `# Your team (capability cards, kept up to date by the app)\n${body}` : '# Your team\nNo other blobs yet. Offer to hire starters (list_templates) or build one.';
  }
}
