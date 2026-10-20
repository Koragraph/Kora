// BlobRuntime: what the daemon, the SessionManager and the ui-server (through `KoraBlobsLike`) call
// (docs/bots/ARCH.md section 3). It owns the BlobStore, the memory worker handle, the extractor chain and the per-thread
// prompt state; it never touches a driver. All memory work is a message to the memory worker.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { FleetToolSpec } from '../session/fleet-tools';
import { agentOfInstance, resolveBlobRuntimeMode } from './permissions';
import { KORA_SOUL, getTemplate, hireFromDraft, listTemplates, type BlobDraft } from './templates';
import { BlobToolHub, TeamService, allBlobToolSpecs, type McpSession, type TeamToolContext } from './tools-team';
import { blobHome, blobsStoreDir } from './home';
import { blobSystemPromptText, turnContextText } from './prompt';
import { installBlobSkills, pluginDir, skillIndexText, PLUGIN_NAME, type InstalledSkill } from './skills/install';
import { selfToolSpecs, teamReadDirs } from './tools';
import { RetryBook, type RetryEntry } from './ingest-retry';
import { renderFact } from '../memory/subject';
import { scrubSecrets } from '../memory/text';
import { RoutineService, routineToolSpecs, type AttentionKind, type RoutineBridge } from './routines';
import { appToolSpecs, approvalCopy, createAppsService, normalizeGrants, type AppsService } from './apps';
import { BlobBrowserManager, browserFleetSpecs, type BlobBrowserSettings, type BrowserApprovalRequest, type LiveBrowserSource } from './browser';
import { BlobUsageLedger } from './usage';
import { GroupsService, groupToolSpecs, type GroupBridge } from './groups';
import { TeamFileService } from './teamfile/service';
import { OutsideService } from './outside/service';
import { makeOutsideHost, type OutsideEngine } from './outside/host';
import { describeCadence } from './routines/schedule';
import { addRule, appRule, matchesAppRule, matchesRule, readRules, ruleFor, type ApprovalRule } from './approval-rules';
import { isUndone, markUndone, pendingUndo } from './undo';
import type { MemoryHost } from './memory-host';
import type { BlobStore } from './store';
import { writeFileAtomic } from './store';
import { isKoraSurfaceOn } from '../edition';
import { CHIEF_BLOB_ID, type BlobEngine, type BlobFactWire, type BlobProfile, type BlobToolContext, type MemoryReceiptWire, type OneShot, type ThreadOrigin, type TokenTotals } from './types';

export const RECALL_BUDGET_TOKENS = 1000;
export const RECALL_TIMEOUT_MS = 400;
/** Facts injected in the last N turns of a thread are skipped. */
export const DEDUPE_TURNS = 6;
const MAX_INGEST_QUEUE = 20;
const MAX_PENDING_TURNS = 200;
const IDLE_SUMMARY_MS = 10 * 60_000;

interface ThreadState { turns: number; injected: Map<string, number>; coreHash: string | null; aboutHash?: string | null }
interface DirtyThread { blobId: string; lastAt: number; lines: Array<{ role: string; text: string }> }
interface PendingTurn { blobId: string; threadId: string; userMessageId: string; assistantMessageId: string; userText: string; assistantText: string; at: number }

export interface BlobRuntimeOptions {
  store: BlobStore;
  memory: MemoryHost;
  oneShot: OneShot;
  /** Connected apps (tests pass one built on a fake backend). Default: the daemon-wide service (BYO key > Kora broker). */
  apps?: AppsService;
  /** The routine service (tests). Default: one over this store. */
  routines?: RoutineService;
  /** Phase 6: the per-blob browsers (tests pass one with a fake engine dir). Default: the real manager. */
  browsers?: BlobBrowserManager;
  /** Pin the webhook receiver's port (the daemon passes UI port + 3 from its config; KORA_WEBHOOK_PORT still wins). */
  webhookPort?: number;
  /** The command that runs this install's CLI (`kora`, or `'<node>' '<kora.js>'`). */
  koraCmd?: string;
  /** Whether the engine can reach kora_spawn (the driver knows; the manager passes it through systemPrompt's agent). */
  userSkillDirs?: string[];
  log?: (msg: string) => void;
  now?: () => number;
  /** Whether the Kora surface is on (edition.ts). Off = coming soon: no warm Haiku, no memory maintenance, no routines or
   *  job timers. Default: the daemon's switch. */
  surfaceOn?: () => boolean;
}

const normalizeLine = (s: string): string => s.toLowerCase().replace(/^[\s\-*>#\d.)]+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

export class BlobRuntimeImpl extends EventEmitter {
  readonly store: BlobStore;
  readonly memory: MemoryHost;
  readonly oneShot: OneShot;
  readonly usage = new BlobUsageLedger();
  /** Phase 2: Kora's team (delegation log, job engine, cards, proposals, confirm cards). */
  readonly team: TeamService;
  /** Phase 4: routines + webhooks (engine, store, receiver). Started when the chat engine attaches. */
  readonly routines: RoutineService;
  /** Phase 5: connected apps (Composio through the Kora broker or the user's own key). */
  readonly apps: AppsService;
  /** Phase 6: each blob's own browser (lazy, idle-closed, <= 3 running). Its live view is `browsers.liveSource(...)`. */
  readonly browsers: BlobBrowserManager;
  /** The newest ask-the-user hook per blob: a browser approval lands as an inline card on the thread of the call that raised it. */
  private browserAsks = new Map<string, NonNullable<BlobToolContext['askApproval']>>();
  /** Bearer-token sessions for `kora mcp --blobs` (Codex / OpenCode blobs); served by the daemon's blobs.mcp.* socket methods. */
  readonly hub: BlobToolHub;
  /** Phase 3: group chats (profiles, the responder router, per-member turns) and team files (export / import plans). */
  readonly groups: GroupsService;
  readonly teamfile: TeamFileService;
  private outsideSvc: OutsideService | null = null;
  private outsideEngine: OutsideEngine | null = null;
  private koraCmd: string;
  private log: (msg: string) => void;
  private now: () => number;
  private threads = new Map<string, ThreadState>();
  private core = new Map<string, { you: string; blob: string; hash: string }>();
  private mirrorWrittenAt = new Map<string, number>();
  private promptCoreHash = new Map<string, string>();
  private dirty = new Map<string, DirtyThread>();
  private ingestTail: Promise<unknown> = Promise.resolve();
  private ingestQueued = 0;
  private extractorMissed = false;
  private userSkillDirs?: string[];
  private lastTidyDay = '';
  private bridge: unknown = null;
  private bestEngineFn: (() => BlobEngine | null) | null = null;
  private routineBridge: RoutineBridge | null = null;
  private offStore: () => void;
  private surfaceOn: () => boolean;

  constructor(o: BlobRuntimeOptions) {
    super();
    this.surfaceOn = o.surfaceOn ?? isKoraSurfaceOn;
    this.store = o.store; this.memory = o.memory; this.oneShot = o.oneShot;
    this.koraCmd = o.koraCmd ?? 'kora';
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
    this.userSkillDirs = o.userSkillDirs;
    this.hub = new BlobToolHub({ getBlob: (id) => this.store.get(id), specsFor: (ctx) => this.toolSpecs(ctx) });
    // Skill names for the capability cards: installBlobSkills walks the disk, so remember each answer for a minute
    // (the cards rebuild on every roster / job change and must not stall the daemon's event loop).
    const skillNames = new Map<string, { at: number; names: string[] }>();
    this.team = new TeamService({
      store: this.store, log: this.log,
      // "Best available" for a hire/proposal: the user's blob default, else the host's pick (Sonnet 5.5 when Claude is signed in, never Opus by default), else Kora's own.
      defaultEngine: () => this.store.defaults().engine ?? this.bestEngineFn?.() ?? this.store.get(CHIEF_BLOB_ID)?.engine ?? { instanceId: 'claude', model: 'sonnet', effort: null },
      skillsOf: (id) => {
        const hit = skillNames.get(id);
        if (hit && this.now() - hit.at < 60_000) return hit.names;
        const names = this.skills(id).skills.map((s) => s.name);
        skillNames.set(id, { at: this.now(), names });
        return names;
      },
    });
    this.routines = o.routines ?? new RoutineService({
      blobs: this.store, bridge: () => this.routineBridge, log: this.log, now: this.now, ...(o.webhookPort ? { webhookPort: o.webhookPort } : {}),
      notify: (blobId, kind, title) => this.emit('routineAttention', { blobId, kind, title }),
    });
    this.apps = o.apps ?? createAppsService();
    this.browsers = o.browsers ?? new BlobBrowserManager({
      // outside every agent's cwd: the profile holds cookies and sign-ins (never exported, undone, remembered or indexed)
      profileDirFor: (id) => path.join(blobHome(id), 'browser-profile'),
      requestApproval: (req) => this.raiseBrowserApproval(req),
      settingsFor: (id) => this.browserSettings(id),
      downloadsDirFor: (id) => { const b = this.store.get(id); return b ? path.join(b.workspace, 'downloads') : undefined; },
      // tools fail fast with ENGINE_NOT_INSTALLED; the Computer tab installs the 98 MB engine, never an agent turn
      hostDefaults: { log: this.log, autoInstall: false },
      maxConcurrent: 3,
    });
    // The store is listened to by the runtime, the team cards, the groups, the ui-server's project mirror and one subscription per open
    // client: more than Node's default ten is normal, not a leak.
    this.store.setMaxListeners(100);
    // Phase 3: groups (pruned when a member retires) and team files over the same stores
    this.groups = new GroupsService({ store: this.store, oneShot: () => this.oneShot, cardsOf: () => this.team.cards.cards(), log: this.log });
    this.teamfile = new TeamFileService({
      store: this.store, groups: this.groups.groups, log: this.log,
      skillsOf: (id) => this.skills(id).skills.filter((s) => s.source === 'blob').map((s) => ({ name: s.name, description: s.description })),
      routinesOf: (id) => this.routines.list(id).map((r) => ({ title: r.title, cadence: r.suggestedCadence ?? describeCadence(r.cadence), prompt: r.prompt })),
    });
    // the memory worker's extractor calls come back here; a missing model is remembered so the turn is queued
    this.memory.setExtractor(async (req) => {
      const r = await this.oneShot(`${req.system}\n\n${req.prompt}`, { json: true });
      if (!r) { this.extractorMissed = true; throw new Error('no extractor available'); }
      return r.text;
    });
    const changed = (id: string | null, meta?: { prompt?: boolean }) => {
      if (meta?.prompt !== false) this.emit('promptChanged', id);
      // a deleted blob: its live routine runs are stopped and its routines stop existing for the engine
      if (id && !this.store.get(id)) { try { this.routines.forgetBlob(id); } catch { /* best effort */ } try { this.team.forgetBlob(id); } catch { /* best effort */ } this.usage.forget(id); this.core.delete(id); this.mirrorWrittenAt.delete(id); this.dropQueuedMemory(id); }
    };
    this.store.on('changed', changed);
    // a retired / deleted blob loses its browser; an edited allowlist / download switch applies to the running one at once
    const browserChanged = (id: string | null) => {
      if (!id) return;
      const b = this.store.get(id);
      if (!b || b.archivedAt != null) { this.browserAsks.delete(id); void this.browsers.close(id).catch(() => {}); }
      else void this.browsers.settingsChanged(id).catch(() => {});
    };
    this.store.on('changed', browserChanged);
    const aboutMeChanged = () => changed(null);
    this.store.on('aboutMe', aboutMeChanged);
    this.offStore = () => { this.store.off('changed', changed); this.store.off('changed', browserChanged); this.store.off('aboutMe', aboutMeChanged); };
  }

  // ── lookups ──────────────────────────────────────────────────────────────────────────────────────
  byCwd(cwd: string): BlobProfile | null { return this.store.byCwd(cwd); }
  /** Folders a blob may read but not write: Kora (the Chief) reads every teammate's workspace to collect their outputs. */
  readableDirs(blobId: string): string[] {
    return teamReadDirs(this.store, blobId);
  }
  /** Called once the chat engine has loaded its persisted threads (it reconciles running job steps). */
  /** The host's "best installed" engine (ui-server: Sonnet 5.5 when Claude is signed in, else Codex, else a free model). */
  setBestEngine(fn: () => BlobEngine | null): void { this.bestEngineFn = fn; }
  attachEngine(bridge: unknown): void {
    this.bridge = bridge;
    // Kora is coming soon: no job sweeper, no group router, no routine scheduler or webhook receiver (edition.ts).
    if (!this.surfaceOn()) { this.log('blobs: Kora is coming soon; routines, jobs and groups stay stopped'); return; }
    this.team.attachEngine(bridge as never);
    // Phase 3 / 8: the chat engine's member-turn runner (group threads) and its read side for outside access
    const eng = bridge as { runMemberTurn?: GroupBridge['runMemberTurn']; outside?: OutsideEngine } | null;
    if (eng && typeof eng.runMemberTurn === 'function') this.groups.attach({ runMemberTurn: (r) => eng.runMemberTurn!(r) });
    this.outsideEngine = eng?.outside ?? null;
    this.routineBridge = routineBridgeFrom(bridge);
    if (this.routineBridge) this.routines.start();
  }
  /** Phase 4: a routine run needs the user, finished or failed (the daemon turns it into a quiet notification). */
  onRoutineAttention(cb: (e: { blobId: string; kind: AttentionKind; title: string }) => void): () => void { this.on('routineAttention', cb); return () => this.off('routineAttention', cb); }
  /** Subscribe to "a blob's static prompt inputs changed" (SOUL, profile, about-me; blobId null = every blob). */
  onPromptChanged(cb: (blobId: string | null) => void): () => void { this.on('promptChanged', cb); return () => this.off('promptChanged', cb); }

  // ── the static system prompt (synchronous) ───────────────────────────────────────────────────────
  private coreOf(blobId: string): { you: string; blob: string; hash: string } {
    let c = this.core.get(blobId);
    if (!c) {
      const m = parseMirror(readMirror(blobId));
      c = { ...m, hash: hash(m.you + '\u0000' + m.blob) };
      this.core.set(blobId, c);
      void this.refreshCore(blobId); // the db is the truth; the mirror is only the warm start
    }
    return c;
  }

  /** Skills the blob sees; also what the engine's session options need (plugin dir + names). */
  skills(blobId: string): { dir: string; skills: InstalledSkill[]; qualified: string[] } {
    const r = installBlobSkills({ blobHome: blobHome(blobId), koraCmd: this.koraCmd, ...(this.userSkillDirs ? { userSkillDirs: this.userSkillDirs } : {}) });
    return { ...r, qualified: r.skills.map((s) => `${PLUGIN_NAME}:${s.name}`) };
  }

  systemPrompt(i: { blobId: string; threadId: string; agent: string }): string {
    const blob = this.store.get(i.blobId);
    if (!blob) return '';
    const agent = agentOfInstance(i.agent);
    const core = this.coreOf(i.blobId);
    this.promptCoreHash.set(i.blobId, core.hash);
    this.threadState(i.threadId).aboutHash = hash(this.store.aboutMe()); // what THIS session's static prompt knows
    const sk = this.skills(i.blobId);
    return blobSystemPromptText({
      blob, soul: this.store.soul(i.blobId), aboutMe: this.store.aboutMe(), core, agent, blobHome: blobHome(i.blobId),
      skillIndex: skillIndexText(sk.skills, path.join(pluginDir(blobHome(i.blobId)), 'skills')), koraCmd: this.koraCmd,
      canDelegateLegwork: agent === 'claude' && blob.helpers !== false, // helpers are the Claude lead's tools (kora_spawn); Codex / OpenCode blobs have none, and a blob can switch them off
      ...(blob.role === 'chief' ? { teamCards: this.team.systemTeamBlock(i.threadId) } : {}),
      hasApps: normalizeGrants(blob.toolGrants?.apps).mode !== 'none',
      hasBrowser: blob.role !== 'chief',
    });
  }

  // ── per-turn context (async, bounded) ────────────────────────────────────────────────────────────
  private threadState(threadId: string): ThreadState {
    let s = this.threads.get(threadId);
    if (!s) { s = { turns: 0, injected: new Map(), coreHash: null }; this.threads.set(threadId, s); if (this.threads.size > 500) this.threads.delete(this.threads.keys().next().value as string); }
    return s;
  }

  async turnContext(i: { blobId: string; threadId: string; text: string; agent: string; origin: ThreadOrigin | null }): Promise<string> {
    const blob = this.store.get(i.blobId);
    if (!blob) return '';
    const st = this.threadState(i.threadId);
    st.turns += 1;
    let memoryBlock = '';
    if (i.text.trim()) {
      try {
        await this.importMirror(i.blobId);
        const exclude = [...st.injected].filter(([, turn]) => st.turns - turn < DEDUPE_TURNS).map(([id]) => id);
        const r = await withTimeout(this.memory.recall({ blobId: i.blobId, query: i.text, budgetTokens: RECALL_BUDGET_TOKENS, includeTeam: blob.role === 'chief', excludeFactIds: exclude, ...(i.origin?.kind === 'kora' || i.origin?.kind === 'routine' ? { taskScoped: true } : {}) }), RECALL_TIMEOUT_MS);
        if (r) { memoryBlock = r.memoryBlock; for (const id of r.factIds) st.injected.set(id, st.turns); }
      } catch (e: any) { this.log(`blobs: recall skipped: ${e?.message ?? e}`); }
    }
    // Core notes changed since this session's static prompt was built: say so once per change
    let coreDelta: string | null = null;
    const c = this.core.get(i.blobId);
    const baseline = st.coreHash ?? this.promptCoreHash.get(i.blobId) ?? null;
    if (c && baseline && c.hash !== baseline) {
      coreDelta = `<memory-core-updated>\n${[c.you && `About the user:\n${c.you}`, c.blob && `Your working notes:\n${c.blob}`].filter(Boolean).join('\n\n') || '(core notes are now empty)'}\n</memory-core-updated>`;
      st.coreHash = c.hash;
    } else if (!st.coreHash && c) st.coreHash = c.hash;
    // About me is read every turn (a hash of one small file): an edit reaches threads that already exist, whatever their
    // engine did with the static prompt it was started with (found live: only NEW threads knew the change).
    let aboutDelta: string | null = null;
    const aboutNow = this.store.aboutMe();
    const aboutHash = hash(aboutNow);
    const aboutBaseline = st.aboutHash ?? null; // unknown (no prompt built in this process): nothing to compare, learn it now
    if (aboutBaseline !== null && aboutHash !== aboutBaseline) aboutDelta = `<about-me-updated>\n${aboutNow.trim() || '(the user cleared their About me)'}\n</about-me-updated>`;
    st.aboutHash = aboutHash;
    const teamDelta = blob.role === 'chief' ? this.team.turnTeamDelta(i.threadId) : null;
    const base0 = turnContextText({ memoryBlock, coreDelta, fromKora: i.origin?.kind === 'kora' && st.turns === 1 });
    const base = aboutDelta ? (base0 ? `${aboutDelta}\n${base0}` : aboutDelta) : base0;
    return teamDelta ? (base ? `${teamDelta}\n${base}` : teamDelta) : base;
  }

  // ── after a turn: ingest (serialised, never throws) ──────────────────────────────────────────────
  async afterTurn(i: { blobId: string; threadId: string; messageIds: { user: string; assistant: string }; userText: string; assistantText: string; at: number; brief?: boolean }): Promise<MemoryReceiptWire[]> {
    const blob = this.store.get(i.blobId);
    if (!blob || !i.assistantText.trim()) return [];
    // Credentials leave here: the summary transcript and the retry queue (pending-turns.jsonl) hold this text too (pl8 S2-1).
    i = { ...i, userText: scrubSecrets(i.userText), assistantText: scrubSecrets(i.assistantText) };
    const d = this.dirty.get(i.threadId) ?? { blobId: i.blobId, lastAt: i.at, lines: [] };
    d.lastAt = this.now();
    d.lines.push({ role: 'user', text: i.userText.slice(0, 1500) }, { role: 'assistant', text: i.assistantText.slice(0, 1500) });
    if (d.lines.length > 12) d.lines.splice(0, d.lines.length - 12);
    this.dirty.set(i.threadId, d);
    if (this.ingestQueued >= MAX_INGEST_QUEUE) { this.log('blobs: ingest queue full, turn skipped'); return []; }
    this.ingestQueued++;
    const run = async (): Promise<MemoryReceiptWire[]> => {
      try { return await this.ingest(blob, i); }
      catch (e: any) { this.log(`blobs: memory ingest failed: ${e?.message ?? e}`); return []; }
      finally { this.ingestQueued--; }
    };
    const p = this.ingestTail.then(run, run);
    this.ingestTail = p;
    return p;
  }

  private async ingest(blob: BlobProfile, i: { blobId: string; threadId: string; messageIds: { user: string; assistant: string }; userText: string; assistantText: string; at: number; brief?: boolean }): Promise<MemoryReceiptWire[]> {
    this.extractorMissed = false;
    const receipts = await this.memory.ingestTurn({
      blobId: blob.id, threadId: i.threadId, messageId: i.messageIds.user, userMessageId: i.messageIds.user, assistantMessageId: i.messageIds.assistant,
      userText: i.userText, assistantText: i.assistantText, at: i.at, allowTeam: blob.role === 'chief', ...(i.brief ? { learn: false } : {}),
    });
    // deleted while the extractor ran: what this turn just wrote goes with the rest of the blob
    if (!this.store.get(blob.id)) { try { await this.memory.forgetBlob(blob.id); } catch { /* best effort */ } return []; }
    if (this.extractorMissed) {
      this.queuePending({ blobId: blob.id, threadId: i.threadId, userMessageId: i.messageIds.user, assistantMessageId: i.messageIds.assistant, userText: i.userText, assistantText: i.assistantText, at: i.at });
      // The no-model corrections ("I moved to Austin") were applied before the model was asked: keep their receipts.
      if (receipts.length) void this.refreshCore(blob.id);
      return this.toWire(receipts);
    }
    if (receipts.length) void this.refreshCore(blob.id);
    return this.toWire(receipts);
  }

  private async toWire(receipts: Array<{ id: string; kind: string; factId: string; pendingId?: string; text: string; blobId: string }>): Promise<MemoryReceiptWire[]> {
    const out: MemoryReceiptWire[] = [];
    const pend = receipts.some((r) => r.kind === 'pending') ? await this.memory.listPending({}) : [];
    for (const r of receipts) {
      if (r.kind === 'pending') {
        const p = pend.find((x) => x.id === r.pendingId);
        out.push({ id: r.id, kind: 'held', scope: p?.scope ?? 'you', text: r.text, previousText: null, factId: null, undone: false, reason: p ? (p.reason === 'sensitive' ? 'Looks sensitive' : 'Not sure about this one') : null });
        continue;
      }
      const f = r.factId ? await this.memory.getFact(r.factId) : undefined;
      let previous: string | null = null;
      if (r.kind === 'updated' && r.factId) {
        const all = await this.memory.listFacts({ includeRetired: true, ...(f?.scope === 'blob' ? { scope: 'blob' as const, blobId: f.blobId } : {}) });
        previous = all.find((x) => x.supersededBy === r.factId)?.text ?? null;
      }
      out.push({ id: r.id, kind: r.kind as 'added' | 'updated' | 'retired', scope: f?.scope ?? 'you', text: r.text, previousText: previous, factId: r.factId || null, undone: false, reason: null });
    }
    return out;
  }

  // ── pending turns (no extractor was available) ───────────────────────────────────────────────────
  private pendingFile() { return path.join(blobsStoreDir(), 'pending-turns.jsonl'); }
  private queuePending(t: PendingTurn): void {
    try {
      const book = this.readBook(); book.add(t, this.now());
      this.writeBook(book);
    } catch { /* advisory */ }
  }
  /** pending-turns.jsonl: `{item, attempts, nextAt}` per line; an old-format line (a bare turn) loads as due now. */
  private readBook(): RetryBook<PendingTurn> {
    let entries: Array<RetryEntry<PendingTurn>> = [];
    try {
      entries = fs.readFileSync(this.pendingFile(), 'utf8').split('\n').filter(Boolean).map((l) => {
        const r = JSON.parse(l) as RetryEntry<PendingTurn> | PendingTurn;
        return 'item' in r && 'attempts' in r ? (r as RetryEntry<PendingTurn>) : { item: r as PendingTurn, attempts: 1, nextAt: 0 };
      });
    } catch { entries = []; }
    return new RetryBook<PendingTurn>(entries);
  }
  private writeBook(book: RetryBook<PendingTurn>): void {
    const rows = book.all();
    writeFileAtomic(this.pendingFile(), rows.length ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : '');
  }
  pendingTurnCount(): number { return this.readBook().size; }

  /**
   * A helper's brief carries only what the task needs: lines the blob copied verbatim out of the user's memory, Core notes or
   * About me are removed (a free model has no business holding "my wife's birthday is ..."). Never throws.
   */
  async scrubBrief(blobId: string, task: string): Promise<string> {
    try {
      const secrets = new Set<string>();
      const add = (s: string, min: number) => { const n = normalizeLine(s); if (n.length >= min) secrets.add(n); };
      for (const l of this.store.aboutMe().split('\n')) add(l, 16);
      const c = this.core.get(blobId);
      for (const l of `${c?.you ?? ''}\n${c?.blob ?? ''}`.split('\n')) add(l, 16);
      const facts = await withTimeout(this.memory.listFacts({ blobId }), 800);
      for (const f of facts ?? []) { add(f.text, 14); add(renderFact(f.text), 14); }
      if (!secrets.size) return task;
      let removed = 0;
      const kept = task.split('\n').filter((line) => {
        const n = normalizeLine(line);
        if (n.length < 14) return true;
        for (const s of secrets) if (n.includes(s)) { removed++; return false; }
        return true;
      });
      return removed ? `${kept.join('\n').trim()}\n\n(${removed} line${removed === 1 ? '' : 's'} with personal details were left out of this brief on purpose.)` : task;
    } catch { return task; }
  }

  /** The extractor chain's state (last model that answered, resting models, retryAt), or null for a plain function. */
  /** Group routing's warm Haiku session: start it before the first auto-routed message needs it (cheap; a no-op while running). */
  prewarmRouting(): void { if (!this.surfaceOn()) return; try { (this.oneShot as { prewarm?: () => void }).prewarm?.(); } catch { /* advisory */ } }
  extractorStatus(): unknown { return (this.oneShot as { status?: () => unknown }).status?.() ?? null; }

  /**
   * Process queued turns whose backoff has passed while an extractor can be reached; stop at the first miss (which backs
   * that turn off). Nothing is even tried while the chain says every model is resting (`retryAt`). Returns how many were ingested.
   */
  async drainPending(max = 5): Promise<number> {
    const book = this.readBook();
    const status = this.extractorStatus() as { retryAt?: number | null } | null;
    const due = book.due(this.now(), max, status?.retryAt ?? null);
    let done = 0;
    for (const e of due) {
      const t = e.item;
      // a deleted blob's queued turns are dropped, never written back as orphans (pl7 S2-4)
      if (!this.store.get(t.blobId)) { book.done(e); continue; }
      this.extractorMissed = false;
      try {
        await this.memory.ingestTurn({ blobId: t.blobId, threadId: t.threadId, messageId: t.userMessageId, userMessageId: t.userMessageId, assistantMessageId: t.assistantMessageId, userText: t.userText, assistantText: t.assistantText, at: t.at, allowTeam: this.store.get(t.blobId)?.role === 'chief' });
      } catch { book.failed(e, this.now()); break; }
      if (this.extractorMissed) { book.failed(e, this.now()); break; }
      book.done(e); done++;
    }
    if (due.length) { try { this.writeBook(book); } catch { /* advisory */ } }
    return done;
  }

  // ── core notes <-> memory.md mirror ──────────────────────────────────────────────────────────────
  /**
   * Re-read the Core notes from the db into the cache + mirror file. The db is the one truth: when the SHARED "About the user"
   * note changed, every other blob's mirror is rewritten too (one note, many files: a stale copy must never look like a
   * hand edit later).
   */
  async refreshCore(blobId: string, cascade = true): Promise<void> {
    try {
      // first look at this blob since the daemon started: a hand edit made while it was down is imported (if newer), never overwritten
      if (!this.core.has(blobId) && !this.mirrorWrittenAt.has(blobId)) await this.importMirror(blobId);
      const c = await this.memory.getCore(blobId);
      const h = hash(c.you + '\u0000' + c.blob);
      const prev = this.core.get(blobId);
      this.core.set(blobId, { you: c.you, blob: c.blob, hash: h });
      if (!prev || prev.hash !== h || !fs.existsSync(mirrorPath(blobId))) writeMirror(blobId, c, (t) => this.mirrorWrittenAt.set(blobId, t));
      if (cascade && (!prev || prev.you !== c.you)) await this.refreshAllMirrors(blobId);
    } catch { /* memory unavailable: the warm-start mirror stays */ }
  }

  /** Bring every other blob's cache + mirror in step with the db (the shared note is the same text in all of them). */
  private async refreshAllMirrors(except?: string): Promise<void> {
    for (const b of this.store.list({ includeArchived: true })) {
      if (b.id === except) continue;
      await this.refreshCore(b.id, false);
    }
  }

  /**
   * A hand-edited memory.md becomes the Core notes before the next recall - but only when the file is NEWER than the note it
   * would replace. After a restart nothing remembers what this process wrote, and a stale per-blob copy of the shared note
   * (written before another blob edited it) must never overwrite the newer db text (found live 2026-10-10).
   */
  private async importMirror(blobId: string): Promise<void> {
    try {
      const st = fs.statSync(mirrorPath(blobId));
      const wrote = this.mirrorWrittenAt.get(blobId) ?? 0;
      if (st.mtimeMs <= wrote + 1500) return;
      this.mirrorWrittenAt.set(blobId, st.mtimeMs);
      const m = parseMirror(readMirror(blobId));
      const cur = await this.memory.getCore(blobId);
      const newer = (updatedAt: number | undefined) => st.mtimeMs > (updatedAt ?? 0) + 1000;
      if (m.you !== cur.you && newer(cur.youUpdatedAt)) await this.memory.setCore('you', blobId, m.you).catch(() => {});
      if (m.blob !== cur.blob && newer(cur.blobUpdatedAt)) await this.memory.setCore('blob', blobId, m.blob).catch(() => {});
      await this.refreshCore(blobId);
    } catch { /* no mirror yet */ }
  }

  // ── tools ────────────────────────────────────────────────────────────────────────────────────────
  toolSpecs(ctx: BlobToolContext & Partial<Pick<TeamToolContext, 'fullAccess' | 'userMessageSince'>>): FleetToolSpec[] {
    return [
      ...allBlobToolSpecs(selfToolSpecs({ store: this.store, memory: this.memory, log: this.log, onMemoryChanged: (id: string) => { void this.refreshCore(id); } }, ctx), this.team, ctx),
      ...routineToolSpecs(this.routines, ctx),
      ...this.appSpecs(ctx),
      ...(ctx.blobId === CHIEF_BLOB_ID ? groupToolSpecs({ groups: this.groups.groups, resolveBlob: (ref) => this.team.resolveBlob(ref), callerId: ctx.blobId }) : []),
      ...this.browserSpecs(ctx),
    ];
  }

  /** The 12 browser_* tools of this blob's own browser. Kora (the Chief) delegates instead of browsing. */
  private browserSpecs(ctx: BlobToolContext): FleetToolSpec[] {
    const blob = this.store.get(ctx.blobId);
    if (!blob || blob.role === 'chief') return [];
    const ask = ctx.askApproval;
    return browserFleetSpecs(() => {
      if (ask) this.browserAsks.set(ctx.blobId, ask);
      return this.browsers.get(ctx.blobId);
    });
  }

  /** What the ui-server's live route talks to (`/blob-browser/:blobId/live`): one real, non-archived blob = one browser. */
  get browserLive(): LiveBrowserSource {
    // ONE object for the daemon's life: the ui-server keys the shared engine install (and its progress) on it, so a getter that
    // built a new source per call lost the install between the POST that started it and the GET that asked how it was going.
    return (this.browserLiveSource ??= this.browsers.liveSource((id) => { const b = this.store.get(id); return !!b && b.archivedAt == null; }));
  }
  private browserLiveSource: LiveBrowserSource | null = null;

  /** The user's browser settings for a blob (read live by the host). */
  private browserSettings(blobId: string): Partial<BlobBrowserSettings> {
    const c = this.store.get(blobId)?.toolGrants?.computer;
    return { allowLocalHosts: Array.isArray(c?.allowLocalHosts) ? c!.allowLocalHosts : [], allowDownloads: c?.allowDownloads === true };
  }

  /**
   * An outbound browser action (buy / book / send / sign in) needs the user's OK. It lands as the SAME inline approval card as
   * every other approval, on the thread whose tool call raised it; the live panel's bar answers the same question and the first
   * answer wins (`req.signal` aborts when the panel answered, which retires the card). With no card to show it waits for the
   * panel (or the host's own timeout) rather than denying at once: a person watching the panel can still answer.
   */
  private raiseBrowserApproval(req: BrowserApprovalRequest): Promise<boolean> {
    const ask = this.browserAsks.get(req.blobId);
    const name = this.store.get(req.blobId)?.name ?? 'This blob';
    if (!ask) {
      // No card to show. Nobody watching the panel either = nobody can answer: deny at once (the host would wait for its timeout).
      if (!(this.browsers.peek(req.blobId)?.status().viewers)) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => { if (req.signal?.aborted) resolve(false); else req.signal?.addEventListener('abort', () => resolve(false), { once: true }); });
    }
    return ask({
      title: `${name} wants to: ${req.summary}`,
      detail: [req.summary, req.url].filter(Boolean).join('\n'),
      args: { kind: 'app-action', appName: 'Browser', tool: 'browser', summary: [req.summary, req.url && `on ${req.url}`].filter(Boolean).join(' '), url: req.url },
      ...(req.signal ? { signal: req.signal } : {}),
    }).catch(() => false);
  }

  /**
   * Phase 8: outside access (`kora mcp --team`). Built on first use over the real stores; before the chat engine attaches every
   * call answers "Kora is still starting" instead of failing. Tokens and the audit log live under <KORA_HOME>/blobs/outside.
   */
  get outside(): OutsideService {
    if (!this.outsideSvc) {
      const eng = (): OutsideEngine | null => this.outsideEngine;
      const starting = (): never => { throw new Error('Kora is still starting. Try again in a few seconds.'); };
      const engine: OutsideEngine = {
        threads: (id) => eng()?.threads(id) ?? [],
        thread: (id) => eng()?.thread(id) ?? null,
        rows: (id) => eng()?.rows(id) ?? [],
        blobState: (id) => eng()?.blobState(id) ?? 'idle',
        search: (q, ids, n) => eng()?.search(q, ids, n) ?? [],
        models: (inst) => eng()?.models(inst) ?? [],
        send: async (i) => (eng() ? eng()!.send(i) : starting()),
        interrupt: async (id) => (eng() ? eng()!.interrupt(id) : false),
        groupSend: async (i) => (eng()?.groupSend ? eng()!.groupSend!(i) : { ok: false, message: 'Kora is still starting.' }),
      };
      this.outsideSvc = new OutsideService({
        host: makeOutsideHost({
          store: this.store as never, engine, groups: this.groups.groups, koraReady: () => this.koraReady(),
          cardOf: (id) => this.team.cards.cards().find((c) => c.blobId === id) ?? null,
          skillNames: (id) => this.skills(id).skills.filter((s) => s.source !== 'user').map((s) => s.name),
        }),
      });
    }
    return this.outsideSvc;
  }

  /** apps_connected / apps_tools / apps_run: none at all unless the blob has an app grant (the model is not even told apps exist). */
  private appSpecs(ctx: BlobToolContext): FleetToolSpec[] {
    const ask = ctx.askApproval;
    return appToolSpecs(this.apps, {
      blobId: ctx.blobId, threadId: ctx.threadId,
      permission: () => this.store.get(ctx.blobId)?.permission ?? 'ask',
      grants: () => this.store.get(ctx.blobId)?.toolGrants?.apps,
      ...(ctx.emitCard ? { emitCard: (c) => ctx.emitCard!(c) } : {}),
      ...(ask ? {
        approve: async (req) => {
          // a standing "Always for this blob" on this very action: no card
          if (matchesAppRule(readRules(this.store.get(ctx.blobId)?.toolGrants?.approvals), req.tool)) return true;
          const c = approvalCopy(req, req.args, this.store.get(ctx.blobId)?.name ?? 'This blob');
          const rule = appRule(req.tool, req.summary);
          try {
            return (await ask({
              title: c.title, detail: c.detail, args: c.args,
              ...(rule ? { always: { label: rule.label, remember: () => { this.saveRule(ctx.blobId, rule); } } } : {}),
            })) === true;
          } catch { return false; }
        },
      } : {}),
    });
  }

  // ── standing approvals ("Always for this blob") ─────────────────────────────────────────────────
  /** A rule for this exact call already covers it (read live: a rule added a second ago applies to the very next call). */
  alwaysAllowed(blobId: string, toolName: string, input: Record<string, unknown>): boolean {
    return matchesRule(readRules(this.store.get(blobId)?.toolGrants?.approvals), toolName, input);
  }
  /** The rule an "Always" on this call would add (its label is the button's tooltip), or null when none is safe. */
  approvalRuleFor(toolName: string, input: Record<string, unknown>): { label: string } | null {
    const r = ruleFor(toolName, input);
    return r ? { label: r.label } : null;
  }
  /** The user chose "Always for this blob" on a card: persist the rule. Returns it (null = nothing safe to remember). */
  rememberAlways(blobId: string, toolName: string, input: Record<string, unknown>): ApprovalRule | null {
    const rule = ruleFor(toolName, input, this.now());
    return rule ? this.saveRule(blobId, rule) : null;
  }
  private saveRule(blobId: string, rule: ApprovalRule): ApprovalRule | null {
    const blob = this.store.get(blobId);
    if (!blob) return null;
    const next = addRule(readRules(blob.toolGrants?.approvals), rule);
    this.store.update(blobId, { toolGrants: { ...blob.toolGrants, approvals: next } }, { promptNeutral: true });
    return rule;
  }

  /** A bearer token for one Codex / OpenCode blob session (the driver puts it on the MCP server's argv). */
  mcpIssue(session: McpSession): string { return this.hub.issue(session); }
  mcpRevoke(threadId: string): void { this.hub.revokeThread(threadId); }

  /** The RuntimeMode a blob thread starts in for (engine, permission). */
  runtimeModeFor(instanceId: string, permission: BlobProfile['permission']): string { return resolveBlobRuntimeMode(instanceId, permission); }

  /** Make sure Kora (the Chief) exists; `engine` is only used when it has to be created. Idempotent. */
  ensureKora(engine: BlobEngine): BlobProfile { const k = this.store.ensureKora(engine, KORA_SOUL); this.team.upgradeKora(); return k; }
  /** Kora exists and is not retired. */
  koraReady(): boolean { const k = this.store.get(CHIEF_BLOB_ID); return !!k && k.archivedAt == null; }

  /** Undo a self-change receipt (SOUL / model edit). Returns false when the token is unknown or already undone. */
  undoSelfChange(token: string): boolean | Promise<boolean> {
    if (this.routines.ownsUndo(token)) return this.routines.undo(token); // routine create / change / delete receipts
    const e = pendingUndo(token);
    if (!e || isUndone(token)) return false;
    if (e.kind === 'soul') this.store.writeSoul(e.blobId, String(e.before ?? ''));
    else if (e.kind === 'model' && e.before && typeof e.before === 'object') this.store.update(e.blobId, { engine: e.before as BlobProfile['engine'] });
    else if (e.kind === 'profile' && e.before && typeof e.before === 'object') {
      const b = e.before as { name: string; title: string; permission: BlobProfile['permission']; soul: string };
      try { this.store.update(e.blobId, { name: b.name, title: b.title, permission: b.permission }); } catch { return false; } // the old name was taken meanwhile
      this.store.writeSoul(e.blobId, String(b.soul ?? ''));
    }
    markUndone(token);
    return true;
  }

  // ── Phase 2: what the ui-server's blobs.* RPCs call (host.ts KoraBlobsLike) ───────────────────────
  templates() { return listTemplates(); }
  /** The gallery's Hire: no confirm card (the user clicked). Throws the first problem when nothing was hired. */
  hireTemplates(templateIds: readonly string[]): BlobProfile[] {
    const r = this.team.hireStarters([...templateIds]);
    if (!r.profiles.length) throw new Error(r.errors[0] ?? 'Nobody was hired.');
    for (const p of r.profiles) this.grantConnectedApps(p.id, getTemplate(p.templateId ?? '')?.draft.apps ?? []);
    return r.profiles;
  }

  /**
   * A new blob is allowed the apps it comes with, but only those the user has ALREADY connected (a hire never opens a door
   * that was shut, and never waits on the network: this runs in the background and the roster refreshes when it lands).
   */
  grantConnectedApps(blobId: string, slugs: readonly string[]): void {
    const wanted = [...new Set(slugs.map((s) => s.toLowerCase()).filter(Boolean))];
    if (!wanted.length) return;
    void (async () => {
      try {
        if ((await this.apps.mode()) === 'unavailable') return;
        const connected = new Set((await withTimeout(this.apps.accounts(), 3000))?.filter((a) => a.status.toUpperCase() === 'ACTIVE').map((a) => a.toolkit.toLowerCase()) ?? []);
        const ok = wanted.filter((s) => connected.has(s));
        const blob = this.store.get(blobId);
        if (!ok.length || !blob) return;
        const cur = normalizeGrants(blob.toolGrants?.apps);
        if (cur.mode === 'all') return;
        const allow = new Set(cur.mode === 'list' ? cur.allow : []);
        for (const s of ok) allow.add(`toolkit:${s}`);
        this.store.update(blobId, { toolGrants: { ...blob.toolGrants, apps: { mode: 'list', allow: [...allow] } } });
      } catch (e: any) { this.log(`blobs: could not allow connected apps for ${blobId}: ${e?.message ?? e}`); }
    })();
  }
  /** `blobs.create`: a proposal card's Hire / Tweak (flips the card to hired) or a plain draft. Routines are written paused. */
  hireDraft(draft: BlobDraft, proposalId: string | null): BlobProfile {
    const profile = proposalId ? this.team.hireProposal(proposalId, draft) : hireFromDraft(this.store, draft, this.team.hireContext());
    this.grantConnectedApps(profile.id, draft.apps);
    return profile;
  }
  proposalDismiss(proposalId: string): void {
    if (!this.team.dismissProposal(proposalId)) throw new Error('That proposal is gone or was already answered.');
  }
  jobGet(jobId: string) {
    const c = this.team.jobs.card(jobId);
    if (!c) throw new Error(`No job ${jobId}.`);
    return c;
  }
  async jobCancel(jobId: string, stepId: string | null) {
    const r = await this.team.jobs.cancel(jobId, stepId);
    if (!r.ok) throw new Error(r.error);
    return this.jobGet(jobId);
  }
  /** Stop pressed on a Kora (Chief) thread: cancel its unfinished jobs and interrupt their step threads. */
  async jobsCancelForThread(koraThreadId: string): Promise<string[]> {
    return await this.team.jobs.cancelForThread(koraThreadId);
  }
  jobFeedback(jobId: string, stepId: string, reaction: 'good' | 'redo'): void {
    if (!this.team.jobs.feedback(jobId, stepId, reaction)) throw new Error('That step has no result to react to yet.');
  }
  /** The user clicked Confirm / Not now on a confirm card. */
  confirmResolve(cardId: string, accept: boolean) {
    const r = this.team.resolveConfirm(cardId, accept);
    // a hire through Kora's card: the new blob gets the apps it comes with that are already connected
    for (const p of (r as { profiles?: BlobProfile[] }).profiles ?? []) if (p.templateId && p.toolGrants?.apps?.mode === 'none') this.grantConnectedApps(p.id, getTemplate(p.templateId)?.draft.apps ?? []);
    return r;
  }

  // ── usage ────────────────────────────────────────────────────────────────────────────────────────
  recordTurnUsage(cwd: string, threadId: string, usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }): void {
    const b = this.store.byCwd(cwd);
    if (b) this.usage.record(b.id, threadId, usage);
  }
  usageByBlob(): Map<string, TokenTotals> { return this.usage.all(); }

  // ── memory facade helpers the ui-server maps to wire shapes ──────────────────────────────────────
  async factsWire(scope: 'you' | 'blob' | 'team', blobId: string | null, includeRetired: boolean): Promise<BlobFactWire[]> {
    const facts = await this.memory.listFacts({ scope, ...(scope === 'blob' && blobId ? { blobId } : {}), includeRetired });
    return facts.map(factToWire);
  }

  // ── maintenance ──────────────────────────────────────────────────────────────────────────────────
  /** One pass: drain queued turns, summarise idle threads, nightly tidy. Safe to call by hand (tests). */
  async maintenanceTick(): Promise<{ drained: number; summarised: number; tidied: boolean }> {
    let drained = 0, summarised = 0, tidied = false;
    try { if (this.pendingTurnCount()) drained = await this.drainPending(); } catch { /* next tick */ }
    const now = this.now();
    for (const [threadId, d] of [...this.dirty]) {
      if (!this.store.get(d.blobId)) { this.dirty.delete(threadId); continue; }
      if (now - d.lastAt < IDLE_SUMMARY_MS) continue;
      this.dirty.delete(threadId);
      try {
        this.extractorMissed = false;
        await this.memory.summarizeThread({ threadId, blobId: d.blobId, transcript: d.lines });
        if (this.extractorMissed) this.dirty.set(threadId, { ...d, lastAt: now }); else summarised++;
      } catch { /* retried when the thread is next dirty */ }
    }
    // nightly: once per local day after 03:00, when memory says it is worth it, and nothing is being ingested
    const nowD = new Date(now); const day = nowD.toDateString();
    if (nowD.getHours() >= 3 && this.lastTidyDay !== day && this.ingestQueued === 0) {
      try {
        if (await this.memory.needsTidy()) {
          this.extractorMissed = false;
          await this.memory.tidy({});
          tidied = true;
        }
        // every blob's mirror, whether or not a tidy ran: the db is the truth and a stale copy is how notes got lost
        for (const b of this.store.list({ includeArchived: true })) await this.refreshCore(b.id, false);
        this.lastTidyDay = day;
      } catch { /* tomorrow */ }
    }
    return { drained, summarised, tidied };
  }

  startMaintenance(): () => void {
    // Kora is coming soon: no mirror refresh (it starts the memory worker), no retries / summaries / tidy (edition.ts).
    if (!this.surfaceOn()) return () => {};
    let busy = false;
    void this.refreshAllMirrors().catch(() => {}); // boot: put every blob's cache + memory.md in step with the db
    const t = setInterval(() => { if (busy) return; busy = true; this.maintenanceTick().catch(() => {}).finally(() => { busy = false; }); }, 5 * 60_000);
    t.unref();
    return () => clearInterval(t);
  }

  /** Delete everything memory-side for a blob (the profile/folder delete is BlobStore.delete). */
  async forgetBlob(blobId: string): Promise<void> {
    this.dropQueuedMemory(blobId); // first: a drain or summary in flight must not write the blob back after the purge
    try { await this.memory.forgetBlob(blobId); } catch { /* best effort */ }
    this.usage.forget(blobId); this.core.delete(blobId);
  }

  /** A deleted blob's memory work still waiting: its idle-thread summaries and its pending-turns.jsonl retries (pl7 S2-4). */
  private dropQueuedMemory(blobId: string): void {
    for (const [threadId, d] of [...this.dirty]) if (d.blobId === blobId) this.dirty.delete(threadId);
    try {
      const book = this.readBook();
      const mine = book.all().filter((e) => e.item.blobId === blobId);
      if (mine.length) { for (const e of mine) book.done(e); this.writeBook(book); }
    } catch { /* advisory */ }
  }

  async close(): Promise<void> {
    await this.routines.stop().catch(() => {});
    this.groups.dispose();
    await this.browsers.shutdown().catch(() => {}); // graceful: cookies flush before the memory db closes
    this.team.dispose();
    this.offStore();
    this.usage.flush();
    await this.memory.close().catch(() => {});
  }
}

/** The ui-server's bridge as the routine engine needs it, or null for an older bridge without the hidden-thread methods. */
export function routineBridgeFrom(bridge: unknown): RoutineBridge | null {
  const b = bridge as Partial<Record<string, (...a: any[]) => any>> | null;
  if (!b || typeof b.startHiddenThread !== 'function' || typeof b.createResultsThread !== 'function' || typeof b.postRoutineReport !== 'function' || typeof b.snapshot !== 'function' || typeof b.onSettled !== 'function') return null;
  return {
    startHiddenThread: (p) => b.startHiddenThread!(p),
    snapshot: (id) => b.snapshot!(id),
    ...(typeof b.interrupt === 'function' ? { interrupt: (id: string) => b.interrupt!(id) } : {}),
    createResultsThread: (p) => b.createResultsThread!(p),
    ...(typeof b.threadExists === 'function' ? { threadExists: (id: string) => b.threadExists!(id) as boolean } : {}),
    ...(typeof b.deleteHiddenThread === 'function' ? { deleteHiddenThread: (id: string) => b.deleteHiddenThread!(id) as Promise<boolean> } : {}),
    postReport: (id, card) => b.postRoutineReport!(id, card),
    onSettled: (cb) => b.onSettled!(cb),
  };
}

export function factToWire(f: { id: string; scope: 'you' | 'blob' | 'team'; blobId?: string; text: string; since: number; until?: number; confidence: number; important: boolean; lastUsedAt: number; source: { threadId: string | null; messageId: string | null } }): BlobFactWire {
  return { id: f.id, scope: f.scope, blobId: f.blobId ?? null, text: f.text, since: f.since, until: f.until ?? null, confidence: f.confidence, important: f.important, sourceThreadId: f.source.threadId, sourceMessageId: f.source.messageId, lastUsedAt: f.lastUsedAt || null };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms); t.unref();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

// ── the mirror file ───────────────────────────────────────────────────────────────────────────────
const mirrorPath = (blobId: string) => path.join(blobHome(blobId), 'memory.md');
const MIRROR_HEAD = '<!-- Kora keeps this file in step with the blob\'s memory. Edit it here or in the Memory tab. -->';
function readMirror(blobId: string): string { try { return fs.readFileSync(mirrorPath(blobId), 'utf8'); } catch { return ''; } }
function writeMirror(blobId: string, c: { you: string; blob: string }, stamp: (t: number) => void): void {
  try {
    writeFileAtomic(mirrorPath(blobId), `${MIRROR_HEAD}\n\n## About the user\n${c.you.trim()}\n\n## My working notes\n${c.blob.trim()}\n`);
    stamp(fs.statSync(mirrorPath(blobId)).mtimeMs);
  } catch { /* advisory */ }
}
export function parseMirror(md: string): { you: string; blob: string } {
  const m = /## About the user\n([\s\S]*?)(?:\n## My working notes\n([\s\S]*))?$/.exec(md);
  return { you: (m?.[1] ?? '').trim(), blob: (m?.[2] ?? '').trim() };
}
export { writeMirror as _writeMirrorForTests };
