// GroupsService: the one object the runtime owns for group chats (Phase 3 wiring, docs/bots/GROUPS.md). It holds the
// GroupStore (profiles), keeps it pruned when blobs retire, and builds the GroupOrchestrator once the chat engine's
// bridge exists. The ui-server calls `send` for a group thread's user message and adapts the events to the transcript.
import { EventEmitter } from 'node:events';
import { buildCard, type CapabilityCard } from '../cards';
import type { BlobStore } from '../store';
import type { BlobProfile, OneShot } from '../types';
import { CHIEF_BLOB_ID } from '../types';
import { GroupOrchestrator, type GroupBridge, type GroupEvent, type GroupRunResult } from './orchestrator';
import { GroupStore, blobDirectoryOf } from './store';
import type { GroupProfile, GroupTranscript } from './types';

export interface GroupsServiceOptions {
  store: Pick<BlobStore, 'get' | 'list' | 'soul' | 'on' | 'off'>;
  /** The extractor chain (cheapest free OpenCode -> haiku -> null); looked up per message. */
  oneShot: () => OneShot | null;
  /** Capability cards of the team (TeamCards.cards()). */
  cardsOf: () => CapabilityCard[];
  log?: (msg: string) => void;
  memberTimeoutMs?: number;
  autoPickBudgetMs?: number;
}

export class GroupsService extends EventEmitter {
  readonly groups: GroupStore;
  private orchestrator: GroupOrchestrator | null = null;
  private eventListeners = new Set<(e: GroupEvent) => void>();
  private offStore: () => void;
  private o: GroupsServiceOptions;

  constructor(o: GroupsServiceOptions) {
    super();
    this.o = o;
    this.groups = new GroupStore({ members: blobDirectoryOf(o.store as never) });
    // a retired / deleted member leaves its groups; one under two members is archived (store.prune)
    const prune = () => { try { this.groups.prune(); } catch (e: any) { o.log?.(`groups: prune failed: ${e?.message ?? e}`); } };
    o.store.on('changed', prune);
    this.offStore = () => { o.store.off?.('changed', prune); };
    this.groups.on('changed', (id: string | null) => this.emit('changed', id));
  }

  /** The chat engine is up: build the orchestrator over its member-turn bridge. */
  attach(bridge: GroupBridge): void {
    const { o } = this;
    const fromEnv = Number(process.env.KORA_GROUP_MEMBER_TIMEOUT_MS);
    const memberTimeoutMs = o.memberTimeoutMs ?? (Number.isFinite(fromEnv) && fromEnv >= 500 ? fromEnv : undefined);
    this.orchestrator = new GroupOrchestrator({
      bridge,
      members: blobDirectoryOf(o.store as never),
      cardsOf: (ids) => this.cardsFor(ids),
      oneShot: () => o.oneShot(),
      titleOf: (id) => o.store.get(id)?.title ?? '',
      onEvent: (e) => { for (const l of [...this.eventListeners]) { try { l(e); } catch { /* a listener never breaks a turn */ } } },
      // QA stacks shorten the five-minute per-member budget (KORA_GROUP_MEMBER_TIMEOUT_MS) so a timeout is testable
      ...(memberTimeoutMs ? { memberTimeoutMs } : {}),
      ...(o.autoPickBudgetMs ? { autoPickBudgetMs: o.autoPickBudgetMs } : {}),
      ...(o.log ? { log: o.log } : {}),
    });
  }
  get attached(): boolean { return this.orchestrator != null; }

  /** The auto picker reads the members' capability cards; Kora has none in the team list, so she gets her own. */
  cardsFor(ids: readonly string[]): CapabilityCard[] {
    const have = new Map(this.o.cardsOf().map((c) => [c.blobId, c]));
    const out: CapabilityCard[] = [];
    for (const id of ids) {
      const c = have.get(id);
      if (c) { out.push(c); continue; }
      const p: BlobProfile | null = this.o.store.get(id);
      if (p) { try { out.push(buildCard(p, { soul: this.o.store.soul(id) })); } catch { /* card is advisory */ } }
    }
    return out;
  }

  onEvent(cb: (e: GroupEvent) => void): () => void { this.eventListeners.add(cb); return () => { this.eventListeners.delete(cb); }; }

  /** One user message in a group thread. Resolves when the whole chain (replies and hand-overs) has settled. */
  send(i: { groupId: string; threadId: string; transcript: GroupTranscript; text: string; userName?: string }): Promise<GroupRunResult> {
    const group = this.groups.get(i.groupId);
    if (!group) return Promise.reject(new Error('That group no longer exists.'));
    if (group.archivedAt != null) return Promise.reject(new Error(`${group.name} is archived. Rebuild it from the roster to talk there again.`));
    if (!this.orchestrator) return Promise.reject(new Error('Group chats are not ready yet. Try again in a moment.'));
    return this.orchestrator.handleUserMessage({ group, threadId: i.threadId, transcript: i.transcript, text: i.text, ...(i.userName ? { userName: i.userName } : {}) });
  }

  /** Stop in a group thread: its member turns end quietly. Returns how many were running. */
  stop(threadId: string): number { return this.orchestrator?.abortThread(threadId) ?? 0; }

  /** A group went away: everything in flight stops. */
  abortAll(): void { this.orchestrator?.abortAll(); }

  /** Kora's roster line for the chief prompt: "launch-week (Popo, Junip)" etc. */
  describe(): string {
    return this.groups.list().map((g) => `${g.name} (${g.memberIds.map((id) => this.o.store.get(id)?.name ?? id).join(', ')})`).join('; ');
  }

  /** The members a group thread must create a provider session for: active blobs only, in group order. */
  activeMembers(group: GroupProfile): BlobProfile[] {
    return group.memberIds.map((id) => this.o.store.get(id)).filter((b): b is BlobProfile => !!b && b.archivedAt == null);
  }

  isChief(blobId: string): boolean { return blobId === CHIEF_BLOB_ID; }

  dispose(): void { this.abortAll(); this.offStore(); this.removeAllListeners(); }
}
