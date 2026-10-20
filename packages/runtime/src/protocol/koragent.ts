// The Kora ↔ Koragent contract (koragent/docs/koragent/NAMES.md + plans/05-integration.md §1–§2), Kora's side.
//
// Launch: `koragent --task-spec <file> --event-stream unix:<path>` in a pane (PTY: the full TUI, pre-seeded with the
// task). Kora passes `~/.kora/panes/<paneId>.sock` as the path. KORAGENT LISTENS on it; Kora connects as a client,
// retrying until it is up, and reconnects after a drop or a daemon restart.
// Framing: NDJSON, one JSON object per line, both directions. On every connect Kora sends `hello{sinceSeq}` first;
// Koragent replays its ring buffer from sinceSeq+1, then streams live.
//
// These types are the wire. Add fields, never rename or remove. Unknown event types / fields are ignored by Kora.

/** Koragent's session state (NAMES.md `SessionState`). */
export type SessionState = 'starting' | 'ready' | 'working' | 'retrying' | 'blocked' | 'done' | 'failed' | 'exited';

/** `{model}` (a provider/model id, e.g. `opencode/big-pickle`) | `{alias, hints}` (future gateway). */
export type ModelRoute = { model: string } | { alias: string; hints?: Record<string, unknown> };

export interface Budget { maxUsd?: number; maxTokens?: number; maxSteps?: number; maxWallMs?: number }

export type CreditSource = 'free' | 'byok' | 'subscription' | 'credits';

/** One ■ declaration of the X1 packet. */
export interface GraphPacketSymbol { kind: string; name: string; file: string; line: number; signature?: string }
/**
 * Pre-resolved code context handed in at task start (the X1 packet, structured). `text` is the rendered block Kora
 * would have prepended to an OpenCode prompt (header + lines + trailer), so a consumer may inject it verbatim.
 * Paths are repo-relative; they resolve against `TaskSpec.worktree.path`.
 */
export interface GraphPacket {
  v: 1;
  source: 'kora';
  symbols: GraphPacketSymbol[];
  /** Every file the packet points at (declarations first, then paths the task names). */
  files: string[];
  /** Non-declaration lines of the packet (callers, ranked tail), in order. */
  notes: string[];
  text: string;
}

export interface TaskSpec {
  v: 1;
  taskId: string;
  goal: string;
  context?: GraphPacket;
  acceptance: { check?: string; criteria?: string[]; checkTimeoutMs?: number };
  budget: Budget;
  route: ModelRoute[];
  worktree: { path: string; mainRoot: string; branch: string };
  permission: 'supervised' | 'auto-edits' | 'full';
  /** JSON report path; the `.md` rendering goes next to it (same basename). */
  report: { path: string };
  parent?: { kind: 'kora'; orchestratorId: string; paneId?: string };
  verify?: { maxFixRounds: number; escalateAfter: number };
  /** Kora-managed paths (exact, or `dir/` prefixes) that are never the worker's changes. */
  managedFiles?: string[];
}

export interface TaskReport {
  v: 1;
  taskId: string;
  sessionId: string;
  status: 'done' | 'partial' | 'blocked' | 'budget' | 'failed';
  summary: string;
  changes: { path: string; added: number; removed: number; note?: string }[];
  check: { command: string; exitCode: number; outputTail: string; ranBy: 'harness' } | null;
  findings: { text: string; ref?: string }[];
  blockers: string[];
  attempts: { model: string; outcome: 'ok' | 'rate-limited' | 'gone' | 'check-failed' | 'crashed' }[];
  usage: { steps: number; tokens: Record<string, number>; costUsd: number; refCostUsd: number; bySource: Partial<Record<CreditSource, number>> };
}

/** Fields every outbound event carries. */
export interface KoragentEventBase { v: 1; seq: number; ts: number; sessionID?: string; taskID?: string }

export type KoragentEvent = KoragentEventBase & (
  | { type: 'hello'; pid: number; version: string; capabilities: string[]; replayFrom: number }
  | { type: 'ui.ready' }
  | { type: 'session.state'; state: SessionState; reason?: string; retryAt?: number; blockedOn?: string }
  | { type: 'turn.start' }
  | { type: 'turn.end'; outcome: string }
  | { type: 'tool.start'; callID: string; tool: string; title: string; mcpServer?: string }
  | { type: 'tool.end'; callID: string; status: string; ms: number; files?: string[]; exitCode?: number }
  | { type: 'permission.request'; id: string; tool: string; summary: string }
  | { type: 'budget.update'; tokens: { in: number; out: number; cacheRead: number }; usd: number; steps: number; limit?: Budget }
  | { type: 'steer.received'; id: string; source: SteerSource; delivery: SteerDelivery; preview: string }
  | { type: 'steer.delivered'; id: string; atStep: number }
  | { type: 'model.switch'; from?: string; to: string; reason?: string }
  | { type: 'route.failover'; from: string; to: string; reason: string; retryAfter?: number }
  | { type: 'task.check'; command?: string; exitCode?: number; outputTail?: string; round?: number }
  | { type: 'task.report'; report: TaskReport }
  | { type: 'error'; message: string; fatal: boolean }
);
export type KoragentEventType = KoragentEvent['type'];

export type SteerSource = 'human' | 'leader' | 'kora';
export type SteerDelivery = 'steer' | 'queue';

/**
 * Kora → Koragent. `steer.id` is Kora's own id (optional in the contract): Koragent echoes it as `steer.received.id`
 * when present, so Kora can match the acknowledgement.
 */
export type KoragentInbound =
  | { type: 'hello'; sinceSeq: number }
  | { type: 'steer'; text: string; source: SteerSource; delivery: SteerDelivery; id?: string }
  | { type: 'interrupt' }
  | { type: 'permission.reply'; id: string; allow: boolean }
  | { type: 'view.focus'; focused: boolean }
  | { type: 'catalog.update'; cooldowns: { model: string; until: number; reason: string }[]; passRates: Record<string, number> }
  | { type: 'budget.set'; budget: Budget }
  /** Treat `model` as cooling until `until` (epoch ms; default Koragent's gone floor): the route skips it. */
  | { type: 'model.reject'; model: string; reason?: string; until?: number };
