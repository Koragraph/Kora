// A worker pane backed by a chat SessionDriver instead of a PTY (docs/fleet/WORKER-BOXES.md). To the fleet it is an
// ordinary Pane (an id, state, prompt, read, report, kill, worktree, role), so kora_spawn / kora_wait / kora_read /
// merge / swarm bookkeeping work unchanged; underneath, the worker runs on the same engine as a chat thread (Claude SDK,
// Codex exec, agy, OpenCode, ACP), so every step, error and approval arrives as a structured ChatEvent:
//   - state is the engine's own (eventDriven), never scraped: a failed turn is an error, not "looks idle";
//   - a transient API failure is retried here (6 times, backed off up to 5 min) while the worker stays `working`;
//   - the box renders the feed (WorkerFeed); `read('screen')` returns a plain-text render of it for the lead.
import type { AgentId, PaneInfo } from '../protocol/types';
import type { ApprovalAnswer, ChatEvent, RuntimeMode, UserInputQuestion } from '../session/events';
import { Pane, type PaneOptions } from './pane';
import { WorkerFeed, applyChatEvent, newFeedMapState, type WorkerFeedItem } from './worker-feed';
import { retryableErrorText, ERROR_STALL_MAX_RETRIES, DRIVER_RETRY_DELAYS_MS, DRIVER_RATE_LIMIT_DELAYS_MS } from './error-stall';
import { log } from './log';

/** The engines a DriverPane runs on (the daemon's SessionManager, behind a narrow seam). */
export interface WorkerDriverHost {
  /** True when `agent` has a chat driver that can run a headless worker. */
  supports(agent: AgentId): boolean;
  /** True when `agent`'s engine announces a tool call as it starts (DriverCapabilities.reportsToolStart). Absent = yes. */
  reportsToolStart?(agent: AgentId): boolean;
  /** A hidden worker session in `cwd`; returns its thread id. */
  start(p: { paneId: string; agent: AgentId; cwd: string; account: string | null; model: string | null; effort?: string | null; runtimeMode: RuntimeMode; title: string }): Promise<string>;
  send(threadId: string, text: string, origin: 'user' | 'kora-notice'): Promise<void>;
  /** Stop the running turn; `turnId` = the turn it is meant for (a no-op once that turn is gone). */
  interrupt(threadId: string, turnId?: string): Promise<void>;
  respondApproval(threadId: string, requestId: string, decision: ApprovalAnswer): Promise<void>;
  respondUserInput(threadId: string, requestId: string, answers: Record<string, unknown>): Promise<void>;
  /** End the session and forget the hidden thread. */
  dispose(threadId: string): Promise<void>;
  subscribe(threadId: string, onEvent: (e: ChatEvent) => void): () => void;
}

export interface DriverPaneOptions extends PaneOptions {
  host: WorkerDriverHost;
  model: string | null;
  effort?: string | null;
  runtimeMode: RuntimeMode;
}

export { DRIVER_RETRY_DELAYS_MS, DRIVER_RATE_LIMIT_DELAYS_MS }; // defined in error-stall.ts, shared with the chat lane
/** A running turn with no engine event for this long, no tool running and no approval open has a dead stream (the
 *  engine's own API retries emit events, so silence is real): interrupt it and send "continue". */
export const DRIVER_STREAM_STALL_MS = 4 * 60_000;
/** The same watchdog for an engine that reports tool calls only once they finish: a quiet stretch may be a long build,
 *  so only a silence far beyond any build is treated as dead. */
export const DRIVER_STREAM_STALL_BLIND_MS = 30 * 60_000;
const STREAM_STALL_MESSAGE = 'No response from the engine for a long time — stopped the turn and continuing';
/** How long the watchdog's own interrupt may take to settle before Kora gives up on it and lets the fleet tell the lead. */
export const DRIVER_STALL_RECOVERY_MS = 30_000;
const STALL_RECOVERY_FAILED = 'The engine went silent and did not stop when asked — the lead is told';
const NO_HUMAN_ANSWER = 'No human is watching this worker. Decide yourself with the information you have, say what you assumed, and continue.';

export class DriverPane extends Pane {
  override feed: WorkerFeed = new WorkerFeed();
  readonly host: WorkerDriverHost;
  model: string | null;
  readonly effort: string | null;
  readonly runtimeMode: RuntimeMode;
  threadId: string | null = null;
  costUsd: number | null = null;
  contextPct: number | null = null;
  pendingApproval: { requestId: string; title: string } | null = null;
  retrying: { attempt: number; max: number; message: string; nextAt: number | null } | null = null;
  /** When the last turn completed; null while one runs (PaneInfo.turnEndedAt). */
  turnEndedAt: number | null = null;
  private map = newFeedMapState();
  private unsub: (() => void) | null = null;
  private running = false;
  private queue: { text: string; origin: 'user' | 'kora-notice' }[] = [];
  private retryTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  private started: Promise<void> | null = null;
  private rendered = new Set<string>();
  /** Tool calls started and not yet finished in the running turn: a long build or test is quiet, not stalled. */
  private activeTools = new Set<string>();
  private stallTimer: NodeJS.Timeout | null = null;
  /** Kora interrupted a silent turn: its `interrupted` settle is the cue to continue, not the end of the work. */
  private stallRecovering = false;
  private recoverTimer: NodeJS.Timeout | null = null;
  /** The engine's running turn (from turn.started), and the last one that settled (a late duplicate settle is dropped). */
  private currentTurnId: string | null = null;
  private lastSettledTurnId: string | null = null;
  /** An interrupt not yet answered: a queued prompt waits for it, or it would stop the prompt's new turn instead. */
  private interruptInFlight: Promise<void> | null = null;
  /** Silence after which a running turn is treated as a dead stream (tests shorten it). */
  stallAfterMs = DRIVER_STREAM_STALL_MS;
  /** How long the watchdog's interrupt may take to settle (tests shorten it). */
  recoverAfterMs = DRIVER_STALL_RECOVERY_MS;
  /** A tool call is running right now (the fleet's "no output for 5 min" check waits longer for it). */
  get toolRunning(): boolean { return this.activeTools.size > 0; }

  constructor(o: DriverPaneOptions) {
    super(o);
    this.host = o.host; this.model = o.model; this.effort = o.effort ?? null; this.runtimeMode = o.runtimeMode;
    this.eventDriven = true;
    this.feed.on('item', (i: WorkerFeedItem) => { this.render(i); this.emit('feed', i); });
    this.steerSink = async (text, source, delivery) => this.steer(text, source, delivery);
    // Capability, not a name check: an engine that cannot say a tool started would read every long tool as a dead stream.
    if (this.host.reportsToolStart && !this.host.reportsToolStart(this.declaredAgent)) this.stallAfterMs = DRIVER_STREAM_STALL_BLIND_MS;
  }

  get surface(): 'gui' { return 'gui'; }

  /** Start the hidden session (no PTY). The initial prompt arrives through Runtime.prompt → steerSink. */
  override spawn(): void {
    this.launched = true;
    this.writeLocal(`kora · ${this.agent} worker${this.model ? ` (${this.model})` : ''} in ${this.cwd}\r\n`);
    this.started = (async () => {
      try {
        const threadId = await this.host.start({ paneId: this.id, agent: this.declaredAgent, cwd: this.cwd, account: this.account, model: this.model, effort: this.effort, runtimeMode: this.runtimeMode, title: this.name });
        this.threadId = threadId;
        this.unsub = this.host.subscribe(threadId, (e) => this.onEvent(e));
        log(`pane ${this.id}: ${this.agent} worker session ${threadId}`);
        this.hint('idle');
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        log(`pane ${this.id}: worker session failed to start: ${msg}`);
        this.feed.error(`Could not start ${this.agent}: ${msg}`);
        this.finish(1);
      }
    })();
  }

  /** A prompt for the worker: the lead's (queue) or the human's steer from the box (steer = stop the turn, then send). */
  private async steer(text: string, source: 'human' | 'leader' | 'kora', delivery: 'steer' | 'queue'): Promise<void> {
    if (this.exited) throw new Error(`pane ${this.id} has exited`);
    await this.started;
    if (!this.threadId) throw new Error(`pane ${this.id}: worker session is not running`);
    this.feed.user(text, source);
    const origin = source === 'kora' ? 'kora-notice' as const : 'user' as const;
    if (source === 'human') this.steeredAt = Date.now();
    // A new instruction supersedes a pending automatic retry.
    this.cancelRetry();
    if (this.running && delivery === 'steer') {
      this.queue.unshift({ text, origin });
      await this.interrupt('interrupt');
      return; // the turn.settled(interrupted) drains the queue
    }
    if (this.running || this.interruptInFlight) { this.queue.push({ text, origin }); return; }
    await this.sendNow(text, origin);
  }

  private async sendNow(text: string, origin: 'user' | 'kora-notice'): Promise<void> {
    this.running = true;
    // A new instruction is a new task: an old failure no longer describes the worker, and it gets its retries back.
    if (origin === 'user') { this.errorStall = null; this.retries = 0; }
    this.hint('working');
    this.armStallTimer();
    try { await this.host.send(this.threadId!, text, origin); }
    catch (e: any) {
      this.running = false;
      const msg = String(e?.message ?? e);
      this.feed.error(msg);
      this.hint('idle');
      throw e;
    }
  }

  private onEvent(e: ChatEvent): void {
    if (this.exited) return;
    this.lastOutputAt = Date.now();
    if (this.running) this.armStallTimer();
    try { applyChatEvent(this.feed, this.map, e); } catch (err) { log(`pane ${this.id}: feed mapping failed`, err); }
    switch (e.type) {
      case 'turn.started':
        this.running = true; this.promptPending = false;
        // A new turn supersedes whatever the last one ended on: a retry in flight, or an error it stopped on.
        this.retrying = null; this.errorStall = null; this.turnEndedAt = null;
        this.currentTurnId = e.turnId ?? null;
        this.hint('working');
        return;
      case 'approval.opened':
        this.pendingApproval = { requestId: e.requestId, title: e.title || e.toolName || 'Permission' };
        this.hint('blocked', `asks: ${this.pendingApproval.title}`);
        return;
      case 'approval.resolved':
        if (this.pendingApproval?.requestId === e.requestId) this.pendingApproval = null;
        if (!this.exited) this.hint(this.running ? 'working' : 'idle');
        return;
      case 'user-input.requested':
        // A worker has no human at its side: answer every question with "decide yourself" so it never parks.
        void this.host.respondUserInput(this.threadId!, e.requestId, answerAll(e.questions)).catch((x) => log(`pane ${this.id}: user-input answer failed`, x));
        this.feed.notice(`Asked: ${e.questions.map((q) => q.question).join(' / ').slice(0, 200)} — told to decide itself`);
        return;
      case 'thread.token-usage': {
        const u = e.usage;
        if (typeof u.costUsd === 'number') this.costUsd = u.costUsd;
        if (u.maxTokens && u.usedTokens) this.contextPct = Math.min(100, Math.round((u.usedTokens / u.maxTokens) * 100));
        this.emit('meta');
        return;
      }
      case 'tool.started': this.activeTools.add(e.itemId); return;
      // Progress does not restore retries: a failure that recurs after a few tool calls would be retried forever.
      case 'tool.result': this.activeTools.delete(e.itemId); return;
      case 'turn.settled':
        // A late interrupt re-settling a turn that already ended (Claude emits `interrupted` for it) is not news.
        // (Same id and no turn.started since: an engine that reuses one id for every turn still settles each of them.)
        if (e.turnId && e.turnId === this.lastSettledTurnId && this.currentTurnId === null) return;
        this.lastSettledTurnId = e.turnId ?? null;
        this.currentTurnId = null;
        return this.onSettled(e.state, e.errorMessage ?? null);
      case 'runtime.error':
        // Recorded on the feed; the turn's own settle decides retry vs stop.
        this.feed.error(e.message);
        if (!this.running) this.hint('idle');
        return;
      case 'session.exited':
        if (!e.recoverable) this.feed.notice(`Session ended${e.reason ? `: ${e.reason}` : ''}`);
        return;
      default: return;
    }
  }

  private onSettled(state: string, errorMessage: string | null): void {
    this.running = false;
    // A turn that failed before it ever started (start-up / auth inside the driver) has still taken the prompt.
    this.promptPending = false;
    this.activeTools.clear();
    this.clearStallTimer();
    this.clearRecoverTimer();
    if (this.stallRecovering) {
      this.stallRecovering = false;
      this.retrying = null;
      // Our own interrupt of a silent turn: continue it (a human steer that arrived meanwhile goes first instead).
      // Only when it really was our interrupt or a retryable error — a usage limit or auth failure takes the normal path.
      const ours = state === 'interrupted' || (state === 'failed' && !!errorMessage && !!retryableErrorText(errorMessage));
      if (ours && !this.queue.length) return this.scheduleRetry(STREAM_STALL_MESSAGE);
    }
    if (state === 'failed') {
      const retryable = errorMessage ? retryableErrorText(errorMessage) : null;
      if (retryable && this.retries < ERROR_STALL_MAX_RETRIES && !this.queue.length) return this.scheduleRetry(retryable.text, retryable.kind === 'rate-limit' ? DRIVER_RATE_LIMIT_DELAYS_MS : DRIVER_RETRY_DELAYS_MS);
      // runtime.error usually said it already (found live: every Codex usage-limit failure showed twice).
      const last = this.feed.snapshot().at(-1);
      if (!(last?.kind === 'error' && errorMessage && last.text === errorMessage.slice(0, last.text.length))) this.feed.error(errorMessage || 'The turn failed');
      this.errorStall = { line: (errorMessage || 'turn failed').slice(0, 200), at: Date.now(), retries: this.retries, retrying: false };
      this.retrying = null;
    } else if (state === 'completed') { this.retries = 0; this.errorStall = null; this.retrying = null; this.turnEndedAt = Date.now(); }
    // An interrupt still on its way would stop the queued prompt's new turn: send it once the interrupt is answered.
    if (this.interruptInFlight && this.queue.length) return;
    this.drain();
  }

  /** Send the next queued prompt, or go idle. */
  private drain(): void {
    const next = this.queue.shift();
    if (next) { void this.sendNow(next.text, next.origin).catch(() => {}); return; }
    this.hint('idle');
  }

  /** Interrupt the running turn (tagged with its id); a queued prompt waits until the engine has answered. */
  /** An interrupt the engine never answers gives up after `recoverAfterMs`, so it cannot hold the queue forever. */
  private interrupt(what: string): Promise<void> {
    let deadline: NodeJS.Timeout | null = null;
    const timedOut = new Promise<void>((resolve) => {
      deadline = setTimeout(() => { log(`pane ${this.id}: ${what} not answered within ${Math.round(this.recoverAfterMs / 1000)} s — giving up on it`); resolve(); }, this.recoverAfterMs);
      deadline.unref?.();
    });
    const p: Promise<void> = Promise.race([this.host.interrupt(this.threadId!, this.currentTurnId ?? undefined), timedOut])
      .catch((err) => log(`pane ${this.id}: ${what} failed`, err))
      .finally(() => {
        if (deadline) clearTimeout(deadline);
        if (this.interruptInFlight !== p) return;
        this.interruptInFlight = null;
        if (!this.exited && !this.running && !this.retryTimer && this.queue.length) this.drain();
      });
    this.interruptInFlight = p;
    return p;
  }

  private scheduleRetry(message: string, delays: readonly number[] = DRIVER_RETRY_DELAYS_MS): void {
    const attempt = ++this.retries;
    const delay = delays[Math.min(attempt - 1, delays.length - 1)];
    const nextAt = Date.now() + delay;
    this.retrying = { attempt, max: ERROR_STALL_MAX_RETRIES, message, nextAt };
    this.errorStall = { line: message, at: Date.now(), retries: attempt, retrying: true };
    this.feed.error(message, { attempt, max: ERROR_STALL_MAX_RETRIES, nextAt });
    log(`pane ${this.id}: turn failed on a retryable error — retry ${attempt}/${ERROR_STALL_MAX_RETRIES} in ${delay} ms (${message})`);
    // Stays `working`: a lead's kora_wait must not read the gap before the retry as "done".
    this.hint('working');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.exited || !this.threadId) return;
      void this.sendNow('continue', 'kora-notice').catch(() => {});
    }, delay);
    this.retryTimer.unref?.();
  }
  // ── dead-stream watchdog: re-armed on every engine event while a turn runs ──
  private armStallTimer(): void {
    this.clearStallTimer();
    if (this.exited) return;
    this.stallTimer = setTimeout(() => { this.stallTimer = null; this.onStreamStall(); }, this.stallAfterMs);
    this.stallTimer.unref?.();
  }
  private clearStallTimer(): void {
    if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
  }
  private onStreamStall(): void {
    if (this.exited || !this.running || !this.threadId || this.stallRecovering) return;
    // A long tool or a human's approval is not a dead stream; check again later.
    if (this.activeTools.size > 0 || this.pendingApproval) return this.armStallTimer();
    // Retries spent: leave it to the fleet's stall note, which tells the lead.
    if (this.retries >= ERROR_STALL_MAX_RETRIES) return;
    log(`pane ${this.id}: no engine event for ${Math.round(this.stallAfterMs / 1000)} s with no tool running — interrupting to continue`);
    this.stallRecovering = true;
    this.retrying = { attempt: this.retries + 1, max: ERROR_STALL_MAX_RETRIES, message: STREAM_STALL_MESSAGE, nextAt: null };
    this.emit('meta');
    // The interrupt may never settle (no live query / child, or it rejects): give up after a deadline instead of
    // leaving the box "working" with a retry pill that also hides it from the fleet's stall note.
    this.recoverTimer = setTimeout(() => { this.recoverTimer = null; this.onRecoveryTimeout(); }, this.recoverAfterMs);
    this.recoverTimer.unref?.();
    void this.interrupt('stall interrupt');
  }
  private onRecoveryTimeout(): void {
    if (this.exited || !this.stallRecovering) return;
    log(`pane ${this.id}: the stall interrupt did not settle within ${Math.round(this.recoverAfterMs / 1000)} s — leaving it to the fleet's stall note`);
    this.stallRecovering = false;
    this.retrying = null;
    // The unanswered interrupt must not keep holding the queue.
    this.interruptInFlight = null;
    if (!this.running && this.queue.length) this.drain();
    const quietSince = this.lastOutputAt;
    this.feed.error(STALL_RECOVERY_FAILED);
    this.lastOutputAt = quietSince; // still silent: the fleet's "no output" check must not restart its clock
    this.emit('meta');
  }
  private clearRecoverTimer(): void {
    if (this.recoverTimer) { clearTimeout(this.recoverTimer); this.recoverTimer = null; }
  }

  private cancelRetry(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.clearRecoverTimer();
    this.stallRecovering = false;
    if (this.retrying) { this.retrying = null; this.errorStall = null; }
  }

  /** The human answered the box's approval card. */
  async respondApproval(requestId: string, decision: ApprovalAnswer): Promise<void> {
    if (!this.threadId) throw new Error(`pane ${this.id}: worker session is not running`);
    await this.host.respondApproval(this.threadId, requestId, decision);
  }

  /** The lead's report: the worker's last assistant message. */
  /** The last answer; a worker whose last turn failed for good says so instead of reading as an empty "done". */
  report(): string {
    const text = this.feed.lastAssistantText();
    if (this.errorStall && !this.retrying) return `${text ? `${text}\n\n` : ''}[kora] The worker's last turn FAILED: ${this.errorStall.line}`;
    return text;
  }

  // ── the plain-text screen (kora_read screen / scrollback, the terminal fallback) ──
  private render(i: WorkerFeedItem): void {
    const final = (i.kind === 'assistant' && !i.streaming) || (i.kind === 'tool' && i.status !== 'running') || i.kind === 'user' || i.kind === 'error' || i.kind === 'notice' || (i.kind === 'approval' && i.status === 'open');
    if (!final) return;
    const key = i.kind === 'approval' ? `${i.id}:${i.status}` : i.id;
    if (this.rendered.has(key)) return;
    this.rendered.add(key);
    if (this.rendered.size > 2000) this.rendered.clear();
    let text = '';
    if (i.kind === 'user') text = `> ${i.text}`;
    else if (i.kind === 'assistant') text = `⏺ ${i.text}`;
    else if (i.kind === 'tool') text = `  ${i.status === 'failed' ? '✗' : '⎿'} ${i.tool} ${i.title}${i.added != null ? ` +${i.added} −${i.removed ?? 0}` : ''}`;
    else if (i.kind === 'approval') text = `? ${i.title} — waiting for approval`;
    else if (i.kind === 'error') text = `! ${i.text}${i.retry ? ` (retry ${i.retry.attempt}/${i.retry.max})` : ''}`;
    else text = `· ${i.text}`;
    this.writeLocal(`${text.replace(/\r?\n/g, '\r\n')}\r\n`);
  }

  // ── no PTY ──
  override write(_data: string | Buffer): void { /* keystrokes have nowhere to go: steer through prompt() */ }
  override resize(cols: number, rows: number): void { super.resize(cols, rows); }
  override kill(_signal = 'SIGTERM'): void { this.finish(0); }
  override dispose(): void { this.finish(0); super.dispose(); }

  private finish(code: number): void {
    if (this.exited) return;
    this.cancelRetry();
    this.clearStallTimer();
    this.exited = true; this.exitCode = code; this.pid = null;
    this.unsub?.(); this.unsub = null;
    const tid = this.threadId;
    if (tid) void this.host.dispose(tid).catch((e) => log(`pane ${this.id}: worker session dispose failed`, e));
    this.flushOutput();
    const prev = this.state;
    const r = this.tracker.force('idle', null);
    if (r?.changed) this.emit('state', r.state, r.blocker, prev);
    setImmediate(() => this.emit('exit', code));
  }

  override info(): PaneInfo {
    return { ...super.info(), surface: 'gui', model: this.model, costUsd: this.costUsd, contextPct: this.contextPct, pendingApproval: this.pendingApproval, retrying: this.retrying, turnEndedAt: this.turnEndedAt };
  }
}

function answerAll(questions: UserInputQuestion[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const q of questions) out[q.question] = NO_HUMAN_ANSWER;
  return out;
}
