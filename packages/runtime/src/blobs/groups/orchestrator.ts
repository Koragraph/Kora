// The group turn orchestrator. It owns NO model code: every member turn goes through an injected `GroupBridge` (the
// ui-server runs the member's own provider session for that group thread), the routing through `routeMessage`.
//
//   user message -> transcript.append -> route -> one turn per recipient
//     * turns are SERIAL per (thread, member) and PARALLEL across members
//     * each turn has its own timeout; a slow blob is cut off with a note, the rest of the group is never blocked
//     * a reply that @mentions a teammate queues THAT teammate's reply (a hand-over, depth + 1, capped at MAX_CHAIN_DEPTH)
//     * members never delegate: the bridge is told `allowDelegation` only for the Chief; a mention is only an invitation
//   A hard cap on turns per user message keeps a chatty chain from becoming a runaway bill.
import type { CapabilityCard } from '../cards';
import type { OneShot } from '../types';
import { buildMemberPrompt } from './context';
import { joinNames, parseMentions } from './mentions';
import { routeMessage, type RouteDecision } from './router';
import type { GroupMessage, GroupProfile, GroupTranscript, MemberDirectory } from './types';

export const MAX_CHAIN_DEPTH = 3;
export const MAX_TURNS_PER_MESSAGE = 8;
export const DEFAULT_MEMBER_TIMEOUT_MS = 3 * 60_000;

export interface MemberTurnRequest {
  groupId: string;
  threadId: string;
  blobId: string;
  /** The fully built turn text (instructions, unseen chat, the message). */
  prompt: string;
  /** The group's shared folder. */
  cwd: string;
  /** True only for the Chief: members can never delegate (SPEC: only Kora delegates). */
  allowDelegation: boolean;
  depth: number;
  /** The transcript message that triggered this turn. */
  triggerSeq: number;
  signal: AbortSignal;
  /** Stream the reply as it grows (optional; the UI shows the bubble filling in). */
  onText?(textSoFar: string): void;
}
export interface MemberTurnResult { text: string }

/** The ui-server implements this over the member's provider session. Must reject (not hang) on failure. */
export interface GroupBridge {
  runMemberTurn(req: MemberTurnRequest): Promise<MemberTurnResult>;
}

export type GroupEvent =
  | { type: 'routed'; threadId: string; messageSeq: number; recipients: string[]; label: string; decision: RouteDecision }
  | { type: 'turn-start'; threadId: string; blobId: string; depth: number }
  | { type: 'turn-delta'; threadId: string; blobId: string; text: string }
  | { type: 'turn-end'; threadId: string; blobId: string; message: GroupMessage; depth: number }
  | { type: 'turn-timeout'; threadId: string; blobId: string; depth: number }
  | { type: 'turn-empty'; threadId: string; blobId: string; depth: number }
  | { type: 'turn-aborted'; threadId: string; blobId: string; depth: number }
  | { type: 'turn-error'; threadId: string; blobId: string; depth: number; error: string }
  | { type: 'chain-capped'; threadId: string; reason: 'depth' | 'turns'; blobIds: string[] };

export interface GroupOrchestratorDeps {
  bridge: GroupBridge;
  members: MemberDirectory;
  /** Capability cards for the auto picker (TeamCards.cards() filtered to the members). */
  cardsOf?(blobIds: readonly string[]): CapabilityCard[];
  oneShot?(): OneShot | null;
  titleOf?(blobId: string): string;
  onEvent?(e: GroupEvent): void;
  memberTimeoutMs?: number;
  autoPickBudgetMs?: number;
  log?(msg: string): void;
}

export interface GroupRunResult {
  decision: RouteDecision;
  userMessage: GroupMessage;
  replies: GroupMessage[];
  timedOut: string[];
  failed: Array<{ blobId: string; error: string }>;
  turns: number;
  capped: boolean;
}

export class GroupOrchestrator {
  private tails = new Map<string, Promise<unknown>>();
  /** Every turn in flight -> the thread it belongs to (Stop in one group thread never touches another). */
  private controllers = new Map<AbortController, string>();
  private stopped = new WeakSet<AbortController>();
  /** Threads the person stopped: queued hand-overs of the stopped run never start. Cleared by the next user message. */
  private halted = new Set<string>();
  constructor(private deps: GroupOrchestratorDeps) {}

  /** Abort every turn in flight (daemon shutdown, group deleted). */
  abortAll(): void { for (const c of this.controllers.keys()) c.abort(); }

  /** The person pressed Stop in this group thread: its member turns end quietly (no "taking too long" note). */
  abortThread(threadId: string): number {
    let n = 0;
    this.halted.add(threadId);
    for (const [c, t] of this.controllers) if (t === threadId) { this.stopped.add(c); c.abort(); n++; }
    return n;
  }

  private emit(e: GroupEvent): void { try { this.deps.onEvent?.(e); } catch { /* listeners never break a turn */ } }
  private nameOf(id: string): string { return this.deps.members.name(id) ?? id; }

  /** Handle one message from the person. Resolves when the whole chain (replies and hand-overs) has settled. */
  async handleUserMessage(o: { group: GroupProfile; threadId: string; transcript: GroupTranscript; text: string; userName?: string }): Promise<GroupRunResult> {
    const { group, threadId, transcript } = o;
    this.halted.delete(threadId);
    const members = group.memberIds.filter((id) => this.deps.members.active(id)).map((id) => ({ id, name: this.nameOf(id) }));
    const live: GroupProfile = { ...group, memberIds: members.map((m) => m.id) };
    const decision = await routeMessage({
      group: live, members, text: o.text, authorId: 'user', recent: transcript.list(),
      ...(this.deps.cardsOf ? { cards: this.deps.cardsOf(live.memberIds) } : {}),
      oneShot: this.deps.oneShot?.() ?? null, ...(this.deps.autoPickBudgetMs != null ? { budgetMs: this.deps.autoPickBudgetMs } : {}),
    });
    const userMessage = transcript.append({ authorId: 'user', authorName: o.userName ?? 'You', text: o.text, to: decision.recipients, kind: 'message' });
    const label = joinNames(decision.recipients.map((id) => this.nameOf(id)));
    this.emit({ type: 'routed', threadId, messageSeq: userMessage.seq, recipients: decision.recipients, label, decision });

    const run: RunState = { group: live, threadId, transcript, replies: [], timedOut: [], failed: [], turns: 0, capped: false, inflight: new Set() };
    for (const id of decision.recipients) this.turn(run, id, userMessage, 0);
    // hand-overs are scheduled by the turns themselves (never awaited inside a turn: A -> B -> A would deadlock on A's queue)
    while (run.inflight.size) await Promise.all([...run.inflight]);
    return { decision, userMessage, replies: run.replies, timedOut: run.timedOut, failed: run.failed, turns: run.turns, capped: run.capped };
  }

  /** Queue one member turn behind that member's earlier turns in this thread. */
  private turn(run: RunState, blobId: string, trigger: GroupMessage, depth: number): Promise<void> {
    if (this.halted.has(run.threadId)) return Promise.resolve();
    if (run.turns >= MAX_TURNS_PER_MESSAGE) { this.cap(run, 'turns', [blobId]); return Promise.resolve(); }
    run.turns++;
    const key = `${run.threadId}\u0000${blobId}`;
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.runTurn(run, blobId, trigger, depth));
    const tail = next.catch(() => {});
    run.inflight.add(tail);
    void tail.then(() => run.inflight.delete(tail));
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return next;
  }

  private cap(run: RunState, reason: 'depth' | 'turns', blobIds: string[]): void {
    if (run.capped) return;
    run.capped = true;
    run.transcript.append({ authorId: 'system', authorName: 'Kora', text: reason === 'depth' ? 'Stopped the back-and-forth here. Mention someone again to keep it going.' : 'That is a lot of replies for one message, so I stopped. Ask again to continue.', to: [], kind: 'note' });
    this.emit({ type: 'chain-capped', threadId: run.threadId, reason, blobIds });
  }

  private async runTurn(run: RunState, blobId: string, trigger: GroupMessage, depth: number): Promise<void> {
    const { group, threadId, transcript } = run;
    if (!this.deps.members.active(blobId)) return;
    const self = { id: blobId, name: this.nameOf(blobId) };
    const roster = group.memberIds.map((id) => ({ id, name: this.nameOf(id), title: this.deps.titleOf?.(id) ?? '', chief: this.deps.members.isChief(id) }));
    const prompt = buildMemberPrompt({ group, self, members: roster, trigger, transcript: transcript.list(), depth, maxDepth: MAX_CHAIN_DEPTH });

    const ctl = new AbortController();
    this.controllers.set(ctl, threadId);
    this.emit({ type: 'turn-start', threadId, blobId, depth });
    const timeoutMs = this.deps.memberTimeoutMs ?? DEFAULT_MEMBER_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((res) => { timer = setTimeout(() => { res('timeout'); ctl.abort(); }, timeoutMs); timer.unref?.(); });
    let result: MemberTurnResult | 'timeout' | { error: string };
    try {
      const p = this.deps.bridge.runMemberTurn({
        groupId: group.id, threadId, blobId, prompt, cwd: group.workspace, allowDelegation: this.deps.members.isChief(blobId), depth,
        triggerSeq: trigger.seq, signal: ctl.signal, onText: (t) => this.emit({ type: 'turn-delta', threadId, blobId, text: t }),
      }).catch((e: unknown): { error: string } => ({ error: String((e as Error)?.message ?? e).slice(0, 300) }));
      result = await Promise.race([p, timedOut]);
    } finally { if (timer) clearTimeout(timer); this.controllers.delete(ctl); }

    if (this.stopped.has(ctl)) {
      this.emit({ type: 'turn-aborted', threadId, blobId, depth });
      return;
    }
    if (result === 'timeout') {
      run.timedOut.push(blobId);
      transcript.append({ authorId: 'system', authorName: 'Kora', text: `${self.name} is taking too long, so the group moved on.`, to: [], kind: 'note' });
      this.emit({ type: 'turn-timeout', threadId, blobId, depth });
      return;
    }
    if ('error' in result) {
      run.failed.push({ blobId, error: result.error });
      this.deps.log?.(`groups: ${self.name} turn failed: ${result.error}`);
      this.emit({ type: 'turn-error', threadId, blobId, depth, error: result.error });
      return;
    }
    const text = result.text.trim();
    if (!text) { this.emit({ type: 'turn-empty', threadId, blobId, depth }); return; } // never an empty bubble: the row says so

    // who does this reply hand over to? (never the author; a member cannot @all a chain open past the depth cap)
    const others = group.memberIds.map((id) => ({ id, name: this.nameOf(id) }));
    const handOver = parseMentions(text, others, { exclude: blobId }).ids.filter((id) => group.memberIds.includes(id));
    const willHandOver = depth < MAX_CHAIN_DEPTH ? handOver : [];
    const reply = transcript.append({ authorId: blobId, authorName: self.name, text, to: willHandOver, kind: 'message' });
    run.replies.push(reply);
    this.emit({ type: 'turn-end', threadId, blobId, message: reply, depth });

    if (!handOver.length) return;
    if (!willHandOver.length) { this.cap(run, 'depth', handOver); return; }
    for (const id of willHandOver) this.turn(run, id, reply, depth + 1);
  }
}

interface RunState {
  group: GroupProfile;
  threadId: string;
  transcript: GroupTranscript;
  replies: GroupMessage[];
  timedOut: string[];
  failed: Array<{ blobId: string; error: string }>;
  turns: number;
  capped: boolean;
  inflight: Set<Promise<unknown>>;
}

/** In-memory transcript (tests, and the fallback for a thread-less preview). */
export class MemoryTranscript implements GroupTranscript {
  private rows: GroupMessage[] = [];
  constructor(private now: () => number = Date.now) {}
  append(m: Omit<GroupMessage, 'id' | 'seq' | 'ts'> & { ts?: number }): GroupMessage {
    const seq = this.rows.length + 1;
    const row: GroupMessage = { ...m, id: `gm_${seq}`, seq, ts: m.ts ?? this.now() };
    this.rows.push(row);
    return row;
  }
  list(): GroupMessage[] { return [...this.rows]; }
}
