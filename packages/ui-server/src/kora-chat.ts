// @effect-diagnostics globalConsole:off -- the daemon logs to stdout for `vp run` / the desktop wrapper, not through a Logger.
// @effect-diagnostics globalDate:off -- plain timestamps for wire payloads and logs, produced outside any Effect fiber.
// @effect-diagnostics globalTimers:off -- raw callback-boundary timers around the in-process kora runtime.
// @effect-diagnostics nodeBuiltinImport:off -- plain Node APIs: this module is the boundary to the in-process kora runtime, which is not Effect code.
// The chat-turn engine: drives real agent turns through the kora daemon's own `SessionManager` and
// translates kora `ChatEvent`s into Kora `ThreadEvent`s. This module runs INSIDE `kora server run`
// (see host.ts): the Runtime, SessionManager and ChatThreadStore are the daemon's — there is exactly one of each,
// shared with the unix-socket lane, and every pane a chat orchestrator spawns is a pane of that one runtime.
//
// Flow: `chat.dispatch(turn.start)` emits the user bubble + turn-start, then
// calls `SessionManager.sendTurn`. The kora driver fans events through our `notify`
// seam; `mapChatEvent` turns each into the ordered ThreadEvent stream the Kora
// client renders (`subscribeThread`): message-sent(user) → turn-start-requested →
// session-set(running) → streaming assistant message-sent deltas → activity-appended →
// session-set(ready).
import * as NodeCrypto from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

import {
  isFleetAgentMode,
  ChatThreadDetailSnapshot as ChatThreadDetailSnapshotSchema,
  ThreadIndexSnapshot as ThreadIndexSnapshotSchema,
} from "@kora/contracts";
import type {
  ThreadStreamItem,
  ThreadOrigin,
  ThreadMessageNotice,
  ThreadMessageContext,
  ChatThreadHead,
  ChatThreadDetailSnapshot,
  ChatThreadActivity,
  ChatThread,
  ChatPlanProposal,
  ThreadIndexItem,
  ThreadIndexSnapshot,
  ProjectSurface,
  ChatSessionStatus,
  ChatSession,
  ChatProjectHead,
  ThreadMessage,
  ChatLatestTurn,
  ThreadEvent,
  ModelPick,
  ClientChatCommand,
  MessageAttachment,
  MemoryReceipt,
  BlobUsage,
  BlobProfile,
  BlobCardPayload,
} from "@kora/contracts";
import { projectContextChipForAgent } from "@kora/shared/contextChipReferences";
import { rewriteSkillMentions } from "@kora/shared/skillPrompt";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Effect from "effect/Effect";

import {
  pickFreeEngine,
  onStoreChanged,
  modelsOfInstance,
  buildContinueSeed,
} from "./blobsEngine.ts";
import { listBlobFiles } from "./blobsFs.ts";
import { looksLikePlan } from "./planText.ts";
import { outsideRowsOf } from "./blobsOutsideRows.ts";
import { cardSummary, toWireReceipt } from "./blobsWire.ts";
import {
  type GroupMessageLike,
  memberThreadKey,
  memberReplyText,
  groupMessagesOf,
  friendlyMemberError,
} from "./groupThread.ts";
import { isBlobsCwd } from "./assistantFs.ts";
import type { LegacyProjectHead, LegacyThread } from "./chatMigration.ts";
import { FleetService, type KoraRuntimeLike, type WorkerEventForEngine } from "./fleet-service.ts";
import { resolveMainRoot } from "./graph.ts";
import {
  type KoraUsageLimitsReport,
  type KoraSessionManager,
  type KoraRuntime,
  type KoraPendingModeNotice,
  type KoraOutsideEngine,
  type KoraMemberTurnRequest,
  type KoraManagerRuntime,
  type KoraGroupMessage,
  type KoraGroupJson,
  type KoraGroupEvent,
  type KoraFleetOps,
  host,
} from "./host.ts";
import { hydrateRecord, openRequests, toPermissionMode } from "./hydrate.ts";
import { noteSkillCwd, skillsFor } from "./agentSkills.ts";
import { usageLimits, usageProviderOf as usageAgentOf } from "./usageLimits.ts";
import { dropProjectPrefs } from "./prefsStore.ts";
import { koraHome } from "./paths.ts";
import { claudeResolvedModels, prettyClaudeId } from "./claudeModels.ts";

/** The runtime `TokenUsage` (session/events.ts) as it arrives on `thread.token-usage`. */
interface KoraTokenUsage {
  usedTokens: number;
  maxTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalProcessedTokens?: number;
  autoCompactThreshold?: number;
  compactsAutomatically?: boolean;
  costUsd?: number;
  source?: string;
}

/**
 * Snapshot guard: a snapshot whose field VALUES don't match the wire schema silently tears the RPC
 * connection down when the server encodes it (an async, unlogged drop). Two independent failure
 * modes bite here and BOTH are handled:
 *   1. Schema drift (a field the schema rejects) — logged LOUDLY with the offending path.
 *   2. A nested `undefined` (e.g. an absent `changedFiles` on a tool activity). `Schema.Unknown`
 *      passes it, but `RpcSerialization.layerJson` DIES with "Expected JSON value" and drops the
 *      socket. Schema.encodeUnknownSync does NOT catch this, which is exactly why it went unseen.
 * So we also return a JSON-sanitized clone: JSON.stringify drops `undefined` (matching the wire's
 * own JSON encoding and the persisted shape), guaranteeing every snapshot is wire-safe no matter
 * what future field is added. ISO-string/branded-string/null values round-trip unchanged.
 */
function guardEncode<T>(schema: Schema.Top, value: T, label: string): T {
  try {
    Schema.encodeUnknownSync(schema as never)(value as never);
  } catch (e) {
    console.error(
      `[kora-ui] ENCODE GUARD FAILED for ${label}:`,
      String((e as Error).message).slice(0, 800),
    );
  }
  return toJsonValue(value) as T;
}

/** An out-of-band note for an orchestrator; `kind`+`paneId` let a stale one be dropped before delivery. */
interface PendingNote {
  /** `report` / `exhausted` come from swarm workers (S2's `swarm-report` / `swarm-exhausted`). */
  kind: "steered" | "blocked" | "done" | "idle" | "report" | "exhausted" | "stopped" | "stalled";
  paneId: string;
  text: string;
  /** `stalled`: the worker's lastOutputAt when it was found quiet — any output since makes the note stale. */
  quietSince?: number;
}

/**
 * What any agent hears on its first turn after a daemon restart cut its previous one. Resuming a session whose last turn
 * was cut (a tool call with no result) makes the agent CLI add a "continue where you left off" of its own, and the
 * NEXT message from the person was then answered with the OLD task (found live in Blobs 2026-10-09). The note closes
 * the cut turn and points at the new message. `cut` = the request that was being worked on.
 */
export function restartClosedNote(cut: string | null): string {
  const what = cut ? ` ("${cut.replace(/\s+/g, " ").trim().slice(0, 140)}")` : "";
  return `[kora] Kora's daemon restarted while you were answering the previous request${what}. That turn was cut and is CLOSED: a tool call in it that reads as rejected or interrupted was not refused by the user. Do NOT carry on with it or redo it. Answer ONLY the person's new message below; if it asks about the old request, say it was interrupted by a restart and offer to start it again.`;
}

/** What a fleet lead hears on its first turn after a daemon restart killed its previous turn. */
export const FLEET_RESTART_NOTE =
  "[kora] Kora's daemon restarted while your previous turn was running. A tool call of that turn that reads as rejected or interrupted was NOT refused by the user: the restart cut it, and a kora_spawn in it DID start its workers. Unfinished swarm tasks were resumed and finished ones kept. Call kora_workers FIRST to see every task's real state, then kora_wait for the running ones; do not spawn again a task it lists.";

/** Slack after a leader rate limit's reset before the digest goes out (the provider's clock is not ours). */
const LEADER_LIMIT_GRACE_MS = 5_000;
/** A rate limit without a reset time: try again after this long. */
const LEADER_LIMIT_FALLBACK_MS = 5 * 60_000;

const DIGEST_SECTIONS: ReadonlyArray<{ kind: string; title: string }> = [
  { kind: "report", title: "Done: reports written (verify results inline)" },
  { kind: "done", title: "Exited" },
  { kind: "blocked", title: "Stuck: waiting on an answer" },
  { kind: "exhausted", title: "Stuck: out of free models" },
  { kind: "steered", title: "Steered by the human" },
];

/**
 * X4: the ONE turn a swarm leader gets after its own rate limit resets, instead of a turn per worker note. The
 * workers kept going while Claude was limited; this groups what happened: done (with verify results), exited,
 * stuck, steered. Notes of a kind outside the sections still appear, under "Other".
 */
function buildSwarmDigest(
  notes: ReadonlyArray<{ kind: string; paneId: string; text: string }>,
): string {
  const strip = (t: string): string => t.replace(/^\[kora\]\s*/, "").trim();
  const known = new Set(DIGEST_SECTIONS.map((s) => s.kind));
  const sections = [
    ...DIGEST_SECTIONS.map((s) => ({
      title: s.title,
      items: notes.filter((n) => n.kind === s.kind),
    })),
    { title: "Other", items: notes.filter((n) => !known.has(n.kind)) },
  ].filter((s) => s.items.length > 0);
  const lines = [
    `[kora] While you were rate-limited, your swarm kept working. Digest of ${notes.length} update${notes.length === 1 ? "" : "s"}:`,
  ];
  for (const s of sections) {
    lines.push("", `${s.title} (${s.items.length}):`);
    for (const n of s.items) lines.push(`- ${strip(n.text)}`);
  }
  lines.push(
    "",
    "Continue the plan: read the reports (kora_wait / kora_read), merge what passed verification, and re-dispatch or answer what is stuck.",
  );
  return lines.join("\n");
}
/** The kora ChatEvent envelope, loosely typed (the mapper reads a handful of fields per variant). */
interface KoraChatEvent {
  type: string;
  threadId: string;
  seq: number;
  at: number;
  turnId?: string;
  itemId?: string;
  requestId?: string;
  state?: string;
  reason?: string;
  stream?: string;
  delta?: string;
  /** plan.proposed: the plan the agent handed back in plan mode. */
  markdown?: string;
  toolKind?: string;
  toolName?: string;
  /** approval.opened on a blob thread: what "Always for this blob" would remember. */
  alwaysLabel?: string;
  /** approval.opened for a sensitive call through a symlink: where it really lands. */
  linkTarget?: string;
  title?: string;
  detail?: string;
  input?: unknown;
  status?: string;
  output?: string;
  changedFiles?: unknown;
  /** tool.result of a Read the daemon bounded to a window (runtime graph/read-bounder.ts). */
  bounded?: { path?: unknown; offset?: unknown; limit?: unknown; total?: unknown };
  requestKind?: string;
  options?: unknown;
  /** Structured questions (Claude's AskUserQuestion) and the answers they settle with. */
  questions?: unknown;
  answers?: Record<string, unknown>;
  /** The worker picker: the lead's proposed workers, the installed catalog, and the user's answer. */
  picks?: unknown;
  catalog?: unknown;
  answer?: unknown;
  args?: unknown;
  message?: string;
  errorClass?: string;
  errorMessage?: string;
  usage?: unknown;
  plan?: unknown;
  explanation?: string;
  /** The provider (Claude Agent SDK) session id, carried on thread.started; used to locate the
   *  transcript JSONL for graph-savings accounting. */
  providerThreadId?: string;
  op?: string;
  subject?: string;
  summary?: string;
  view?: unknown;
  hits?: unknown;
  note?: unknown;
  decision?: string;
  paneId?: string;
  workerAgent?: string;
  /** usage.rate-limit: when the leader's limit resets (epoch ms; seconds are normalised). */
  resetsAt?: number;
  window?: string;
}

// ── local read-model records (projected from the events we emit) ──────────────────────
interface ThreadRecord {
  threadId: string;
  koraThreadId: string;
  projectId: string;
  cwd: string;
  title: string;
  modelSelection: ModelPick;
  runtimeMode: ChatThread["runtimeMode"];
  interactionMode: ChatThread["interactionMode"];
  /** chat = a plain agent; orchestrator = runs a fleet of worker panes (the composer's toggle). */
  agentMode: ChatThread["agentMode"];
  /** Plans the agent handed back in plan mode (the plan card under the last turn). */
  proposedPlans?: ChatPlanProposal[];
  /** The turn that already proposed a plan (Claude's ExitPlanMode), so its final text is not proposed again. */
  planProposedTurnId?: string | null;
  branch: string | null;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ThreadMessage[];
  activities: ChatThreadActivity[];
  session: ChatSession | null;
  latestTurn: ChatLatestTurn | null;
  latestUserMessageAt: string | null;
  /** Streaming assistant message being assembled for the active turn. */
  currentAssistant: {
    messageId: string;
    text: string;
    turnId: string;
    createdAt: string;
    /** The `itemId` of the last content.delta folded in — a change means a new text block (the
     *  driver started a fresh assistant-text item, typically after a tool call), so a paragraph
     *  break is inserted rather than running the two blocks together. */
    lastItemId?: string | undefined;
    /** Something else happened (a tool call, a question, a worker event) since the last text delta: the next
     *  text starts a new paragraph even when the driver reuses the item id (Claude numbers blocks per message,
     *  so consecutive messages both stream `turn_1:text:0`). */
    breakPending?: boolean | undefined;
  } | null;
  /**
   * Out-of-band notes for an ORCHESTRATOR (a worker finished / blocked / was steered by the human), queued
   * while a turn is running and delivered as one `[kora] …` user turn once the thread is idle. Transient.
   */
  pendingNotes?: PendingNote[];
  /**
   * A fleet lead's turn died with the previous daemon: its tool results (a kora_spawn / kora_wait answer) are lost,
   * and the resumed lead believed a spawned task "never got spawned" (Swarm QA 2026-10-02). Rides once on the next
   * turn sent to the agent (the user's or Kora's). Persisted until delivered, so a second restart keeps it.
   */
  restartNote?: string;
  /**
   * The human pressed Stop on a swarm lead: worker notes collect but never wake the lead until the person writes
   * again (QA 2026-10-10: a worker that finished after Stop woke the lead into a turn nobody asked for). Persisted so
   * a restart does not release it; cleared when the next user turn starts.
   */
  stopHold?: boolean;
  /** Swarm workers the Stop sweep (or a spawn that landed after it) stopped; named in the stop note. Transient. */
  stopNoteWorkers?: string[];
  /** Panes that already have a `worker.attached` row (the driver's event and the runtime's notify both report a spawn). Transient. */
  attachedPanes?: Set<string>;
  /**
   * X4: the leader (Claude) is rate-limited until `until` (epoch ms). Worker notes collect meanwhile; `timer`
   * fires after the reset and delivers them as ONE digest turn. Transient.
   */
  leaderLimit?: { until: number; timer: ReturnType<typeof setTimeout> | null } | null;
  /** The next flushPending turn is the post-limit digest (buildSwarmDigest) rather than plain notes. Transient. */
  digestNext?: boolean;
  /** The Claude Agent SDK session id (from thread.started providerThreadId). Locates the transcript
   *  JSONL for graph-savings accounting. */
  koraSessionId: string | null;
  /** Kora provider driver-kind (e.g. "claude", "codex") — mirrored onto `session.providerName` so
   *  the web composer keeps the thread on the right provider. Defaults to Claude for legacy records. */
  providerDriver: string;
  /** Set by thread.archive: the thread leaves the sidebar's shell and lists under getArchivedShellSnapshot. */
  archivedAt?: string | null;
  /**
   * The leader's measured tokens, summed over this thread's settled turns (the SDK's own turn usage; `input`
   * excludes cache reads). Feeds the swarm value meter. Counted from when this field was introduced.
   */
  leaderUsage?: { input: number; cached: number; output: number; turns: number };
  /** Blobs: where the thread came from (absent = the user started it). Persisted; rides the thread wire. */
  origin?: ThreadOrigin | null;
  /** Blobs: the user message that only seeds the thread (a routine prompt, a "continue on a free model" digest);
   *  its turn is not learned from. */
  seedMessageId?: string;
  /** Blobs: the user picked this thread's access mode in its permission menu. Until then the thread follows the blob
   *  profile (Ask / Auto / Full resolved for the thread's engine) and never a mode the client merely sent along. */
  runtimeModeSetByUser?: boolean;
}
interface ProjectRecord {
  project: ChatProjectHead;
}

type ThreadListener = (item: ThreadStreamItem) => void;
type ShellListener = (item: ThreadIndexItem) => void;

/** The runtime's `TurnUsage` on `turn.settled` (runtime/src/session/events.ts). */
interface TurnUsageLike {
  usageStatus?: "complete" | "partial" | "unavailable";
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

const nowIso = (): string => new Date().toISOString();
const uuid = (): string => NodeCrypto.randomUUID();

/**
 * Coerce a value into a strict JSON value (dropping `undefined` keys and any
 * non-JSON leaf). The `/ws` wire uses `RpcSerialization.layerJson`, whose codec
 * DIES with "Expected JSON value" on a nested `undefined` — e.g. a `tool.result`
 * activity payload that carries `changedFiles: undefined`. A die inside a frame
 * tears the whole subscription stream (the client then re-subscribes and shows
 * "Syncing messages…" or, without reconnect, the stream just stops mid-turn).
 * The `Schema.Unknown` payload passes schema encoding, so this only bites at the
 * JSON layer. Persistence hides the bug (JSON.stringify already drops undefined),
 * so hydrated threads encode fine while in-memory live ones die — which is why
 * only fresh tool turns broke. Sanitizing here matches the persisted shape and is
 * the single real fix for the mid-turn "drop".
 */
function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * A composer attachment as handed to a session driver: an absolute, already-resolved filesystem path
 * (never a dataUrl). Structurally the same shape as the runtime's `session/events.ts` `MessageAttachment` —
 * ui-server has no workspace dependency on `@kora/runtime` (see assistantFs.ts), so it is typed locally.
 */
interface RuntimeAttachment {
  type: "image" | "file";
  path: string;
  mimeType?: string;
  name?: string;
}

const ATTACHMENT_ID_PATTERN = /^[a-z0-9_-]+$/i;
/** A thread id the engine accepts from a client: a single safe path segment (clients mint UUIDs). */
const SAFE_THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Strip path separators and leading dots so a crafted `name` can never escape its attachment directory. */
function sanitizeAttachmentName(name: string): string {
  const base = path.basename(name).replace(/^\.+/, "_");
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 255);
  return cleaned.length > 0 ? cleaned : "file";
}

function decodeDataUrl(dataUrl: string): Buffer {
  const match = /^data:[^,]*;base64,([\s\S]+)$/.exec(dataUrl);
  if (!match) throw new Error("invalid data URL");
  return Buffer.from(match[1]!, "base64");
}

/** `surface = isBlobsCwd ? "blobs" : "code"` — recomputed every time a project head is built (create + hydrate),
 *  never trusted from a stale stored value or an older client. */
export function deriveProjectSurface(workspaceRoot: string): ProjectSurface {
  return isBlobsCwd(workspaceRoot) ? "blobs" : "code";
}

/** A blob runs at most this many threads at once (SPEC "Threads"); the next send is refused with a plain reason. */
export const BLOB_MAX_RUNNING_THREADS = 3;

/** The daemon default model when a chat project has no `defaultModelSelection` and no prior thread —
 *  mirrors config.ts's `isDefault` Claude entry (instanceId "claude", model "sonnet"). */
const REQUEST_OPENED_KINDS: ReadonlySet<string> = new Set([
  "approval.requested",
  "user-input.requested",
  "worker-picker.requested",
]);
const REQUEST_RESOLVED_KINDS: ReadonlySet<string> = new Set([
  "approval.resolved",
  "user-input.resolved",
  "worker-picker.resolved",
]);

const DEFAULT_MODEL_PICK = {
  instanceId: "claude",
  model: "sonnet",
} as unknown as ModelPick;

/**
 * Route a Kora provider `instanceId` (carried on `modelSelection.instanceId`) to the kora agent slug
 * that drives it AND the Kora driver-kind the client expects on `session.providerName` (the composer's
 * `deriveThreadAgentLock` filters the provider picker by driver-kind, so these must line up — see
 * config.ts `providers`). Unknown instances fall back to Claude, the always-available chat driver.
 */
const CLAUDE_ROUTE = { driver: "claude", koraAgent: "claude" } as const;
const AGENT_ROUTING: Record<string, { readonly driver: string; readonly koraAgent: string }> = {
  claude: CLAUDE_ROUTE,
  codex: { driver: "codex", koraAgent: "codex" },
  // Google's agent: the `agy` CLI (runtime AntigravityDriver).
  antigravity: { driver: "antigravity", koraAgent: "antigravity" },
  // Free OpenCode models as a CHAT engine (runtime OpenCodeDriver, Blobs); a swarm worker is a pane and needs none of this.
  opencode: { driver: "opencode", koraAgent: "opencode" },
};
/** Drivers whose sessions get the fleet bridge (kora_spawn...). Antigravity (agy has no per-run MCP) and ACP/API engines have none. */
const FLEET_BRIDGE_DRIVERS: ReadonlySet<string> = new Set(["claude", "codex", "opencode"]);
function routeAgent(instanceId: string | undefined): { driver: string; koraAgent: string } {
  const hit = instanceId ? AGENT_ROUTING[instanceId] : undefined;
  if (hit) return hit;
  // `claude-work` is the Claude driver with the named account `work` (accountOf below); an ACP / API engine id
  // (`gemini`, `acp-hermes`, `api-groq`) routes to its own driver, `driver === instanceId` (the composer locks on it).
  if (accountOf(instanceId)) return CLAUDE_ROUTE;
  if (instanceId) {
    try {
      const dynamic = host().engines?.route(instanceId);
      if (dynamic) return dynamic;
    } catch {
      /* no engines service: fall back to Claude below */
    }
  }
  return CLAUDE_ROUTE;
}

/** The named Claude account a provider instance id selects (`claude-work` -> `work`), or null for the default login. */
function accountOf(instanceId: string | undefined): string | null {
  const m = instanceId ? /^claude-([a-z0-9][a-z0-9-]{0,29})$/.exec(instanceId) : null;
  return m ? (m[1] ?? null) : null;
}

export { routeAgent as routeAgentForTests, accountOf as accountOfForTests };

/** kora's native approval kind → the client's AgentRequestKind (pendingRequests.ts). */
const AGENT_REQUEST_KINDS: Record<
  string,
  "command" | "file-read" | "file-change" | "mcp-elicitation"
> = {
  command_execution_approval: "command",
  file_change_approval: "file-change",
  file_read_approval: "file-read",
  mcp_elicitation_approval: "mcp-elicitation",
};

/** `appName` for an approval raised by a connected-app tool (`args.kind === "app-action"`, set by the runtime); {} otherwise. */
function appApprovalFields(args: unknown): { appName?: string } {
  const a = args as { kind?: unknown; appName?: unknown } | null;
  return a && a.kind === "app-action" && typeof a.appName === "string" && a.appName
    ? { appName: a.appName }
    : {};
}

/** The `effort` option a Kora model selection carries (`options: [{ id: "effort", value }]`), if any. */
function effortOf(selection: ModelPick): string | null {
  const opts = (
    selection as {
      options?: ReadonlyArray<{ id: string; value: unknown }> | Record<string, unknown>;
    }
  ).options;
  if (!opts) return null;
  if (Array.isArray(opts)) {
    const hit = opts.find((o) => o && o.id === "effort");
    return hit && typeof hit.value === "string" ? hit.value : null;
  }
  const v = (opts as Record<string, unknown>).effort;
  return typeof v === "string" ? v : null;
}

/** Map a kora turn.settled state → an ChatSession status. */
function settleStatus(state: string | undefined): ChatSessionStatus {
  switch (state) {
    case "failed":
      return "error";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    default:
      return "ready";
  }
}

/** "opencode/space-bunny-free" → "space-bunny", "openrouter/qwen/qwen3-coder:free" → "qwen3-coder". */
function shortSwarmModel(id: string | null | undefined): string {
  const last =
    String(id ?? "")
      .split("/")
      .pop() ?? "";
  return last.replace(/:free$/, "").replace(/-free$/, "") || String(id ?? "a free model");
}

/**
 * A Code project is a folder that exists. The browser's typed-path fallback accepted a file (every turn then failed
 * with `spawn ENOTDIR`) or a mistyped path (the chip said "Folder missing … moved, renamed or deleted" for a folder
 * that never was). Refuse both with a plain reason the client shows.
 */
export function assertProjectFolder(root: string, createIfMissing = false): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(root);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" && createIfMissing) {
      fs.mkdirSync(root, { recursive: true });
      return;
    }
    if (code === "EACCES" || code === "EPERM")
      throw new Error(
        `Kora can't open ${root} (permission denied). Give your user access to it, or pick another folder.`,
      );
    throw new Error(`There is no folder at ${root}. Check the path and try again.`);
  }
  if (!st.isDirectory())
    throw new Error(`${root} is a file, not a folder. Open the folder that holds it instead.`);
}

class ChatEngine {
  private readonly sessions: KoraSessionManager;
  private readonly runtime: KoraRuntime;
  /** Fleet read model + pane-backed terminals (the right-panel worker tiles). */
  readonly fleet: FleetService;
  private globalSeq = 0;
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly threads = new Map<string, ThreadRecord>();
  /** kora threadId → Kora threadId (the notify fan-out is keyed by the kora id). */
  private readonly koraToThread = new Map<string, string>();
  private readonly threadListeners = new Map<string, Set<ThreadListener>>();
  /** Blob threads whose turn was accepted but whose `turn.started` has not arrived yet: they count as running for
   *  the three-thread cap (two sends in the same tick must not both pass). Transient. */
  private readonly blobStarting = new Map<string, number>();
  /** Blobs groups: (group thread, blob) -> that member's hidden provider thread. Rebuilt from the threads' origins on boot. */
  private readonly groupMemberThreads = new Map<string, string>();
  /** Blobs groups: member thread id -> listener fed by that thread's messages and its settle (`runMemberTurn`). Transient. */
  private readonly memberTaps = new Map<
    string,
    (e: { kind: "message" } | { kind: "settled"; status: ChatSessionStatus }) => void
  >();
  /** Blobs groups: approval / question request id -> the member thread parked on it (a group thread mirrors its members' cards). */
  private readonly memberRequests = new Map<string, string>();
  /** Blobs groups: the reply bubble a member is streaming right now, keyed (group thread, blob). Transient. */
  private readonly liveMemberRows = new Map<string, { id: string; text: string }>();
  /** Blobs groups: user messages in flight per group thread (the thread reads "working" until the last one settles). */
  private readonly groupRuns = new Map<string, number>();
  private groupEventsOff: (() => void) | null = null;
  /** Outside access: the client a follow-up message came through, keyed by the message id (consumed when the bubble is made). */
  private readonly viaByMessage = new Map<string, string>();
  /** Assistant messages already handed to the memory hook (a turn is learned from once). Transient. */
  private readonly memoryHooked = new Set<string>();
  private readonly blobSettledListeners = new Set<
    (e: { threadId: string; koraThreadId: string; blobId: string; ok: boolean }) => void
  >();
  /** Blob threads that settled or need the user (approval / question / failure): the daemon's macOS notifier listens. */
  private readonly blobAttentionListeners = new Set<
    (e: { threadId: string; blobId: string; kind: "settled" | "needs-you" | "failed" }) => void
  >();
  private readonly shellListeners = new Set<ShellListener>();
  /**
   * The Kora read model (projects + per-thread projection + the Kora↔kora id map) lives here so it
   * survives a daemon restart. The kora ChatThreadStore persists the SessionManager's own thread
   * meta + ChatEvent log under ~/.kora/chat/, but (a) it keys by the kora id, not the client's
   * Kora threadId, and (b) it never stores the USER prompt (the driver pushes it to the SDK without
   * emitting a ChatEvent). So we persist our own projection — the exact bytes subscribeShell /
   * subscribeThread replay — and hydrate it on boot.
   */
  private readonly dataDir = path.join(koraHome(), "kora-daemon");
  private readonly projectsPath = path.join(this.dataDir, "projects.json");
  private readonly threadsDir = path.join(this.dataDir, "threads");
  /** Composer uploads, decoded off their data URLs and written once: `<id>/<sanitized name>` plus a
   *  `meta.json` sidecar (name + mimeType) so the HTTP route can serve them without the engine's state. */
  private readonly attachmentsDir = path.join(koraHome(), "attachments");

  constructor() {
    // The daemon's own runtime + session manager. Worker panes spawned for a chat orchestrator are panes of
    // THIS runtime, so their hooks (prelaunch, reportAgentSession, status) dial the daemon's socket and land here.
    const { runtime, sessions, managerRuntime, proxyPaneId, makeFleetOps } = host();
    this.runtime = runtime;
    this.fleet = new FleetService(runtime as unknown as KoraRuntimeLike, {
      threadForOrchestrator: (orchestratorId) => this.threadForOrchestrator(orchestratorId),
      orchestratorIdFor: (threadId) => {
        const rec = this.threads.get(threadId);
        return rec ? proxyPaneId(rec.koraThreadId) : null;
      },
      onWorkerEvent: (threadId, event) => this.onWorkerEvent(threadId, event),
      leaderTokensFor: (threadId) => this.threads.get(threadId)?.leaderUsage ?? null,
    });
    // The orchestrator's own fleet tools go through the same FleetOps the socket lane uses, wrapped so the
    // panel sees the verdict / merge / plan the agent produced (not only the human's button presses).
    const fleetOps = makeFleetOps(runtime);
    const wrappedFleet: KoraFleetOps = {
      ...fleetOps,
      // An exited worker stays readable after the runtime reaps its pane (30s): the roster still lists it and
      // `kora_read` answers with its last screen, so the orchestrator can see why it died instead of guessing.
      list: (orchestratorId) => {
        const live = fleetOps.list(orchestratorId) as Array<{ id: string }>;
        const owner = this.threadForOrchestrator(orchestratorId);
        const snap = owner ? this.fleet.snapshot(owner.threadId) : null;
        const gone = (snap?.workers ?? []).filter(
          (w) => w.state === "exited" && !live.some((l) => l.id === w.paneId),
        );
        return [
          ...live,
          ...gone.map((w) => ({
            id: w.paneId,
            name: w.title,
            agent: w.agent,
            account: w.account,
            state: "exited",
            blocker: null,
            exited: true,
            exitCode: w.exitCode,
            cwd: w.cwd,
            worktree: w.worktree,
            costUsd: w.costUsd,
            contextPct: w.contextPct,
            steeredAt: w.steeredAt,
            createdAt: w.createdAt,
            lastOutputAt: w.lastOutputAt,
          })),
        ];
      },
      // When the lead last looked at each worker (wait / read / report): an "idle" note for a worker it already saw
      // after it went idle is old news and would only cost the lead an extra turn.
      wait: (...args: Parameters<typeof fleetOps.wait>) => {
        const r = fleetOps.wait(...args);
        void Promise.resolve(r).then(() => this.leadSawWorker.set(args[0], Date.now()));
        return r;
      },
      read: (paneId, source, lines) => {
        this.leadSawWorker.set(paneId, Date.now());
        const remembered = this.fleet.rememberedScreen(paneId);
        if (remembered !== null && !(runtime as unknown as KoraRuntimeLike).panes.has(paneId))
          return `(worker exited; its last screen)\n${remembered}`;
        return fleetOps.read(paneId, source, lines);
      },
      drainNotes: (orchestratorId) => this.drainNotesFor(orchestratorId),
      mergeVerify: async (paneIds) => {
        const r = await fleetOps.mergeVerify(paneIds);
        const threadId = this.threadIdForWorkers(paneIds);
        if (threadId)
          this.fleet.recordVerdict(
            threadId,
            toJsonValue({ pairs: r.pairs, order: r.order, verifiedAt: nowIso() }) as never,
          );
        return r;
      },
      merge: async (paneId, opts) => {
        const r = await fleetOps.merge(paneId, opts);
        const threadId = this.threadIdForWorkers([paneId]);
        if (threadId) this.fleet.recordMerge(threadId, paneId, r);
        return r;
      },
      setPlan: (orchestratorId, plan) => {
        fleetOps.setPlan(orchestratorId, plan);
        const owner = this.threadForOrchestrator(orchestratorId);
        const rec = owner ? this.threads.get(owner.threadId) : undefined;
        if (rec)
          this.appendActivity(
            rec,
            "info",
            "fleet.plan",
            "plan updated",
            { plan: plan.slice(0, 4000) },
            rec.session?.activeTurnId ?? undefined,
          );
      },
    };
    // Chat drivers are built lazily (first session start), so replacing the daemon seam's fleet ops here reaches
    // every orchestrator thread. The socket lane's chat.* methods share the same wrapped ops — harmless: the
    // wrappers only add read-model bookkeeping for threads this engine owns.
    (managerRuntime as KoraManagerRuntime).fleet = wrappedFleet;
    // The Codex orchestrator's tools run out of process; its bridge drains the same queue over the socket.
    runtime.noteSource = { drain: (orchestratorId) => this.drainNotesFor(orchestratorId) };
    // ChatEvents reach us on the runtime's notify channel — the same emission the socket lane forwards.
    runtime.on("notify", (method, params) => this.onKoraNotify(method, params));
    this.sessions = sessions;
    this.hydrate();
    // Blobs: every blob in the runtime store has a project here; re-sync whenever the store changes.
    this.syncBlobProjects();
    try {
      const store = host().blobs?.store;
      if (store) onStoreChanged(store, () => this.syncBlobProjects());
    } catch {
      /* an older runtime store without events: the handlers re-sync after each write */
    }
    // Blobs groups: a project per group, member threads re-linked, and the orchestrator's events become transcript rows.
    this.rebuildGroupState();
    this.syncGroupProjects();
    try {
      const groups = host().blobs?.groups;
      if (groups) {
        groups.on("changed", () => this.syncGroupProjects());
        this.groupEventsOff = groups.onEvent((e) => this.onGroupEvent(e));
      }
    } catch {
      /* an older runtime without groups */
    }
  }

  // ── fleet ↔ thread plumbing ─────────────────────────────────────────────────────────
  /** `chat:<kora id>` → the Kora thread that owns that orchestrator id. */
  private threadForOrchestrator(orchestratorId: string): { threadId: string; cwd: string } | null {
    if (!orchestratorId.startsWith("chat:")) return null;
    const kora = this.koraToThread.get(orchestratorId.slice(5));
    const rec = kora ? this.threads.get(kora) : undefined;
    return rec ? { threadId: rec.threadId, cwd: rec.cwd } : null;
  }

  private threadIdForWorkers(paneIds: readonly string[]): string | null {
    const panes = (this.runtime as unknown as KoraRuntimeLike).panes;
    for (const id of paneIds) {
      const orch = panes.get(id)?.orchestratorId;
      const owner = orch ? this.threadForOrchestrator(orch) : null;
      if (owner) return owner.threadId;
    }
    return null;
  }

  /**
   * A worker-side happening. Two audiences: the transcript (an activity row the human sees inline) and
   * the ORCHESTRATOR itself, which is told as a `[kora] …` user turn — immediately when idle, otherwise
   * queued until its running turn settles (the SDK query is single-turn at a time).
   */
  private onWorkerEvent(threadId: string, event: WorkerEventForEngine): void {
    const rec = this.threads.get(threadId);
    if (!rec) return;
    const turnId = rec.session?.activeTurnId ?? undefined;
    switch (event.kind) {
      case "spawned": {
        // The Claude driver appends `worker.attached` itself (with the turn id). A worker spawned through the
        // out-of-process bridge (a Codex orchestrator) has no driver event, so append the row here — once. The
        // runtime's notify fires INSIDE agentSpawn, before the driver's event, so an activity-scan raced and both
        // rows landed; a per-thread set settles it whichever path is first.
        // Stop landed while the lead's kora_spawn was still in flight: the worker appears AFTER the sweep. Nobody
        // owns it any more (the turn was cut), so stop it too instead of leaving it running unobserved.
        if (rec.stopHold && rec.agentMode === "swarm") {
          const p = (this.runtime as unknown as KoraRuntimeLike).panes.get(event.paneId);
          if (p && this.fleet.kill(rec.threadId, event.paneId)) {
            rec.stopNoteWorkers = [...(rec.stopNoteWorkers ?? []), event.paneId];
            return;
          }
        }
        if (!this.markAttached(rec, event.paneId))
          this.appendActivity(
            rec,
            "info",
            "worker.attached",
            `spawned ${event.paneId} · ${event.agent} · ${event.title}`,
            { paneId: event.paneId, agent: event.agent, title: event.title, role: "worker" },
            turnId,
          );
        return;
      }
      case "steered":
        this.appendActivity(
          rec,
          "info",
          "worker.steered",
          `you steered ${event.paneId}: ${event.text.slice(0, 200)}`,
          { paneId: event.paneId, text: event.text },
          turnId,
        );
        // The Runtime's own steer note targets a PANE orchestrator; ours is a chat thread, so deliver it here.
        this.queueNote(rec, {
          kind: "steered",
          paneId: event.paneId,
          text: `[kora] the human just steered worker ${event.paneId}: "${event.text}"
Treat this as a HARD OVERRIDE: accept it, adjust the plan (kora_plan), and do NOT re-issue the instruction it overrode. If it changes what ${event.paneId} touches, re-check the other workers for new conflicts.`,
        });
        return;
      case "blocked":
        if (isFolderTrustPrompt(event.blocker)) {
          // Kora never answers an agent's trust dialog for a folder the user has not trusted (trust/gate.ts). Say so to
          // both, and keep the lead from answering it or re-sending the task (it starts once the dialog is answered).
          this.appendActivity(
            rec,
            "info",
            "worker.blocked",
            `${event.paneId} is waiting for folder trust: this folder isn't trusted in Kora, so its trust prompt is yours to answer (trust the folder, or answer it in the worker's pane)`,
            { paneId: event.paneId, blocker: event.blocker },
            turnId,
          );
          this.queueNote(rec, {
            kind: "blocked",
            paneId: event.paneId,
            text: `[kora] worker ${event.paneId} is WAITING FOR FOLDER TRUST (its agent asks: "${event.blocker}"). Kora does not answer this for a folder the user has not trusted. Do NOT answer it with kora_prompt and do NOT re-send its task: the task is queued and starts by itself once the prompt is answered. Tell the user in one line: trust this folder in Kora, or answer the prompt in the worker's pane.`,
          });
          return;
        }
        this.appendActivity(
          rec,
          "info",
          "worker.blocked",
          `${event.paneId} needs attention${event.blocker ? `: ${event.blocker}` : ""}`,
          { paneId: event.paneId, blocker: event.blocker },
          turnId,
        );
        {
          // A swarm worker in a thread that is not Full access / Auto waits on a permission prompt that is the
          // HUMAN's to answer (their tile shows "needs you"). The lead must neither wake for it nor type "Allow always"
          // into it (QA 2026-10-10: it did, twice, burning a turn each time). Only the transcript row is left.
          const swarmPane = (this.runtime as unknown as KoraRuntimeLike).panes.get(
            event.paneId,
          )?.swarm;
          if (swarmPane && rec.runtimeMode !== "full-access" && rec.runtimeMode !== "auto") return;
        }
        this.queueNote(rec, {
          kind: "blocked",
          paneId: event.paneId,
          text: `[kora] worker ${event.paneId} is BLOCKED${event.blocker ? ` on: ${event.blocker}` : ""}. Read its screen (kora_read) and either answer it (kora_prompt) or tell the human what it needs.`,
        });
        return;
      case "done":
        this.appendActivity(
          rec,
          "info",
          "worker.done",
          `${event.paneId} finished${event.exitCode != null ? ` (exit ${event.exitCode})` : ""}`,
          { paneId: event.paneId, exitCode: event.exitCode, title: event.title },
          turnId,
        );
        this.queueNote(rec, {
          kind: "done",
          paneId: event.paneId,
          text: `[kora] worker ${event.paneId} ("${event.title}") has EXITED${event.exitCode != null ? ` with code ${event.exitCode}` : ""}. Check its worktree / output and continue the plan.`,
        });
        return;
      case "stopped":
        this.appendActivity(
          rec,
          "info",
          "worker.stopped",
          `you stopped ${event.paneId}`,
          { paneId: event.paneId, title: event.title, taskId: event.taskId },
          turnId,
        );
        // A decision, not a crash: the lead used to read the exit as a failure and respawn the task.
        this.queueNote(rec, {
          kind: "stopped",
          paneId: event.paneId,
          text: `[kora] the human STOPPED worker ${event.paneId} ("${event.title}")${event.taskId ? ` (swarm task ${event.taskId})` : ""}. This is their decision, not a failure: do NOT respawn it or redo its work yourself unless they ask. Carry on with the rest and say in your answer what was left undone; its branch is kept.`,
        });
        this.persistThread(rec);
        return;
      case "idle": {
        // The lead already looked at this worker after it went idle (kora_wait / kora_read): show the row, skip the note.
        const saw = this.leadSawWorker.get(event.paneId) ?? 0;
        const seen = saw >= event.idleSince;
        this.appendActivity(
          rec,
          "info",
          "worker.idle",
          event.problem
            ? `${event.paneId} stopped: ${event.problem.slice(0, 160)}`
            : `${event.paneId} finished its turn — waiting`,
          { paneId: event.paneId, title: event.title, problem: event.problem },
          turnId,
        );
        if (seen) return;
        this.queueNote(rec, {
          kind: "idle",
          paneId: event.paneId,
          text: event.problem
            ? `[kora] worker ${event.paneId} ("${event.title}") STOPPED on an error and is idle — it will not continue on its own:\n  ${event.problem}\nDon't wait on it. Re-dispatch the task (kora_ask_workers → another agent or model) or tell the user; ask them before doing it yourself on their own tokens. kora_kill ${event.paneId} when done with it.`
            : `[kora] worker ${event.paneId} ("${event.title}") finished its turn and is idle. Collect its answer with kora_read ${event.paneId} (or kora_wait, which returns at once now), then continue — give it more work with kora_prompt or kora_kill it.\nEnd of its screen:\n${event.tail
                .split("\n")
                .slice(-6)
                .map((l) => `  ${l}`)
                .join("\n")}`,
        });
        return;
      }
      case "stalled": {
        const mins = Math.max(1, Math.round(event.quietMs / 60_000));
        this.appendActivity(
          rec,
          "info",
          "worker.stalled",
          `${event.paneId} has shown no output for ${mins} min while working`,
          { paneId: event.paneId, title: event.title, quietMs: event.quietMs },
          turnId,
        );
        // The lead already looked after the quiet began (kora_workers flags it STALLED?): no extra turn.
        if ((this.leadSawWorker.get(event.paneId) ?? 0) >= event.lastOutputAt + event.quietMs)
          return;
        this.queueNote(rec, {
          kind: "stalled",
          paneId: event.paneId,
          quietSince: event.lastOutputAt,
          text: `[kora] worker ${event.paneId} ("${event.title}") says it is working but has written nothing for ${mins} min — it may be hung (a dropped API stream, a dialog kora did not recognise). Look with kora_read ${event.paneId} source=screen; kora_prompt it, or kora_kill and re-dispatch if it is stuck.\nEnd of its screen:\n${event.tail
            .split("\n")
            .slice(-6)
            .map((l) => `  ${l}`)
            .join("\n")}`,
        });
        return;
      }
      // ── swarm workers (S2 emits these from the runtime's `swarm.worker` notification) ──
      case "swarm-report": {
        const v = event.verify;
        const verdict =
          v?.state === "passed"
            ? ` — verified${v.bounces > 0 ? ` after ${v.bounces} bounce${v.bounces === 1 ? "" : "s"}` : ""}`
            : v?.state === "failed"
              ? ` — verification FAILED after ${v.bounces} bounce${v.bounces === 1 ? "" : "s"}${v.summary ? `: ${v.summary}` : ""}`
              : "";
        this.appendActivity(
          rec,
          "info",
          "worker.report",
          `${event.paneId} wrote its report${v ? ` · verify ${v.state}` : ""}`,
          { paneId: event.paneId, taskId: event.taskId, verify: v ?? null },
          turnId,
        );
        this.queueNote(rec, {
          kind: "report",
          paneId: event.paneId,
          text: `[kora] swarm worker ${event.paneId} (task ${event.taskId}) finished and wrote its report${verdict}. Read it with kora_wait ${event.paneId} (or kora_read), then merge, follow up or re-dispatch.`,
        });
        return;
      }
      case "swarm-failover":
        // No note: kora_wait follows the old id to the new pane and says so (journey d). The transcript records it.
        this.appendActivity(
          rec,
          "info",
          "worker.respawned",
          // Rate limit or outage: the event does not say which, so neither does the row.
          // Plain words: no pane ids (p1 → p2) in the chat; the fields keep them for the worker views.
          `A helper switched free models: ${shortSwarmModel(event.fromModel)} was busy or down, now ${shortSwarmModel(event.toModel)}`,
          {
            paneId: event.paneId,
            newPaneId: event.newPaneId,
            taskId: event.taskId,
            fromModel: event.fromModel,
            toModel: event.toModel,
          },
          turnId,
        );
        return;
      case "swarm-exhausted":
        this.appendActivity(
          rec,
          "info",
          "worker.rate-limited",
          `${event.paneId} paused: every free model is rate-limited or gone`,
          { paneId: event.paneId, taskId: event.taskId, tried: event.tried },
          turnId,
        );
        this.queueNote(rec, {
          kind: "exhausted",
          paneId: event.paneId,
          text: `[kora] swarm worker ${event.paneId} (task ${event.taskId}) is paused: every free model is rate-limited or gone${event.tried.length ? ` (tried ${event.tried.join(", ")})` : ""}. Hand this slice to the cheap paid tier now: kora_ask_workers (claude Haiku or codex Luna; Kora fixes the model, the user's Stretch button approves it), then kora_spawn it, and tell the user in one line. Do not do the slice yourself unasked (a provider key in Settings → Swarm raises the free limits).`,
        });
        return;
      case "swarm-bounced":
        // X2: the gate sent findings back to the same worker. Claude hears only the final pass / fail (swarm-report).
        this.appendActivity(
          rec,
          "info",
          "worker.bounced",
          `${event.paneId} failed verification — sent back (bounce ${event.verify.bounces})`,
          { paneId: event.paneId, taskId: event.taskId, verify: event.verify },
          turnId,
        );
        return;
      default:
        return;
    }
  }

  /** True if this pane already has its `worker.attached` row; marks it otherwise. */
  /** When the lead last looked at each worker through its fleet tools (wait / read / report). */
  private readonly leadSawWorker = new Map<string, number>();

  private markAttached(rec: ThreadRecord, paneId: string): boolean {
    rec.attachedPanes ??= new Set();
    if (rec.attachedPanes.has(paneId)) return true;
    rec.attachedPanes.add(paneId);
    return false;
  }

  /** Take (and clear) the notes still true for this orchestrator — shared by the in-process Claude driver and the bridge. */
  private drainNotesFor(orchestratorId: string): string[] {
    const owner = this.threadForOrchestrator(orchestratorId);
    const rec = owner ? this.threads.get(owner.threadId) : undefined;
    if (!rec?.pendingNotes?.length) return [];
    const notes = this.liveNotes(rec.pendingNotes);
    rec.pendingNotes = [];
    return notes.map((n) => n.text);
  }

  /**
   * Stop on a swarm lead is a decision about the WHOLE run, not only the leader's turn: stop its live swarm workers,
   * hold every worker note until the person writes again, and leave a note for that next turn saying what Stop did
   * (a tool call it cut reads as "rejected" to the lead even when the worker it was starting did start).
   */
  private stopSwarmOnInterrupt(rec: ThreadRecord): void {
    const chief = this.isChiefThread(rec);
    if (rec.agentMode !== "swarm" && !chief) return;
    rec.stopHold = true;
    const killed: string[] = [];
    if (rec.agentMode === "swarm") {
      try {
        for (const w of this.fleet.snapshot(rec.threadId)?.workers ?? []) {
          if (!w.swarm || w.state === "exited") continue;
          if (this.fleet.kill(rec.threadId, w.paneId)) killed.push(w.paneId);
        }
      } catch {
        /* best effort: the hold above still keeps the lead quiet */
      }
      // Queued tasks (kora_spawn queue:true behind the worker cap) must not start once the slots free up.
      const orch = host().proxyPaneId(rec.koraThreadId);
      if (orch) {
        try {
          for (const t of (this.runtime as unknown as KoraRuntimeLike).swarm?.cancelQueued?.(
            orch,
          ) ?? [])
            killed.push(t);
        } catch {
          /* best effort */
        }
      }
      // The sweep's own "stopped" rows are enough; notes that said "finished / idle / EXITED, continue" are now wrong.
      rec.pendingNotes = (rec.pendingNotes ?? []).filter((n) => n.kind === "stopped");
    }
    rec.stopNoteWorkers = [...(rec.stopNoteWorkers ?? []), ...killed];
    // Kora the Chief: Stop is a decision about the delegated work too. Cancel its unfinished jobs (this interrupts
    // the step threads and cascades to what depended on them). Fire and forget: the cancel notes join the stop note.
    if (chief) {
      void (host().blobs?.jobsCancelForThread?.(rec.koraThreadId) ?? Promise.resolve([]))
        .then((ids) => {
          if (ids.length)
            this.appendActivity(
              rec,
              "info",
              "job.cancelled",
              `Stopped the job${ids.length > 1 ? "s" : ""}: ${ids.length} step${ids.length === 1 ? "" : "s"} cancelled`,
              { steps: ids },
            );
        })
        .catch(() => {});
    }
    this.persistThread(rec);
  }

  /** The Chief's own thread (Kora): the only thread that plans and delegates jobs. */
  private isChiefThread(rec: ThreadRecord): boolean {
    if (!this.isBlobProject(rec.projectId)) return false;
    return host().blobs?.store.get(rec.projectId)?.role === "chief";
  }

  /** The Stop note for the lead's next turn (taken once); null when Stop was not pressed. Also releases the hold. */
  private takeStopNote(rec: ThreadRecord): string | null {
    if (!rec.stopHold) return null;
    rec.stopHold = false;
    const chief = this.isChiefThread(rec);
    const workers = [...new Set(rec.stopNoteWorkers ?? [])];
    rec.stopNoteWorkers = [];
    // Notes that collected while held ride on this turn (one wake-up), not as a separate turn after it.
    const held = this.liveNotes(rec.pendingNotes ?? []).map((n) => n.text);
    rec.pendingNotes = [];
    const tail = held.length ? `\n\n${held.join("\n\n")}` : "";
    const body = chief
      ? "That was a decision: a tool call it cut (a delegate_to, for one) that reads as rejected or interrupted was NOT refused by them and may have started a thread. Their unfinished jobs were cancelled with it; check job status before you say what ran."
      : `That was a decision: a tool call it cut (even a kora_spawn) that reads as rejected or interrupted was NOT refused by them and may have STARTED a worker. ${
          workers.length
            ? `Stop also stopped these swarm workers: ${workers.join(", ")} (their branches are kept).`
            : "No swarm worker was running when they pressed it."
        } Call kora_workers FIRST for the real state.`;
    return `[kora] the human pressed STOP on your previous turn. ${body} Do NOT respawn, resume or finish the old request unless the new message below asks you to. Answer ONLY the new message.${tail}`;
  }

  private queueNote(rec: ThreadRecord, note: PendingNote): void {
    if (!isFleetAgentMode(rec.agentMode)) return;
    // One pending note per (kind, worker): a later "blocked" for the same worker replaces the earlier one.
    const rest = (rec.pendingNotes ?? []).filter(
      (n) => !(n.kind === note.kind && n.paneId === note.paneId),
    );
    rec.pendingNotes = [...rest, note];
    this.flushPending(rec);
  }

  /**
   * Drop notes that are no longer true by the time they can be delivered: a "blocked" for a worker that has
   * since moved on (the real runs delivered a stack of these after the workers were already merged, and the
   * orchestrator spent a turn explaining they were stale).
   */
  private liveNotes(notes: PendingNote[]): PendingNote[] {
    const panes = (this.runtime as unknown as KoraRuntimeLike).panes;
    return notes.filter((n) => {
      // An "idle" note for a worker that has since started working again (the lead already gave it more) is stale.
      if (n.kind === "idle") return panes.get(n.paneId)?.state !== "working";
      // A "stalled" worker that has written anything since, or stopped working, is not stalled any more.
      if (n.kind === "stalled") {
        const p = panes.get(n.paneId);
        return !!p && !p.exited && p.state === "working" && p.lastOutputAt === n.quietSince;
      }
      if (n.kind !== "blocked") return true;
      const p = panes.get(n.paneId);
      return !!p && !p.exited && p.state === "blocked";
    });
  }

  /** The mode notice the agent has not heard yet (taken = cleared + marked announced in the runtime store). */
  private takeNotice(rec: ThreadRecord): KoraPendingModeNotice | null {
    try {
      return this.sessions.takeModeNotice(rec.koraThreadId);
    } catch {
      return null;
    }
  }

  /** The restart note, once (cleared on the record, which is persisted with the turn's events). */
  private takeRestartNote(rec: ThreadRecord): string | null {
    const note = rec.restartNote ?? null;
    if (note) delete rec.restartNote;
    return note;
  }

  private leaderLimited(rec: ThreadRecord): boolean {
    return !!rec.leaderLimit && rec.leaderLimit.until > Date.now();
  }

  /**
   * THE one path that sends Kora-authored turns (it replaced flushNotes): a pending mode notice and the queued
   * worker notes go out together as ONE user turn — notice first — so two flushes can never race into two
   * concurrent sendTurn calls. Waits while a turn runs (the settle hook calls again), while the thread has no
   * messages (the notice then rides on the first user turn, see startTurn) and while the leader is rate-limited
   * (X4: notes collect; the reset timer sends them as one digest).
   */
  private flushPending(rec: ThreadRecord): void {
    const running = rec.session?.status === "running" || rec.currentAssistant !== null;
    if (running) return;
    if (rec.stopHold) return; // the human pressed Stop: only their next message wakes the lead
    if (rec.messages.length === 0) return;
    if (this.leaderLimited(rec)) return;
    const notes = this.liveNotes(rec.pendingNotes ?? []);
    rec.pendingNotes = [];
    // A mode switch alone never starts a turn: its notice (and the new toolset + prompt, via the session restart)
    // rides on the user's next message (startTurn). It only goes out here alongside worker notes that must be sent.
    if (notes.length === 0) return;
    const notice = this.takeNotice(rec);
    const restart = this.takeRestartNote(rec);
    const digest = rec.digestNext === true;
    rec.digestNext = false;
    const notesText =
      notes.length === 0
        ? ""
        : digest
          ? buildSwarmDigest(notes)
          : notes.map((n) => n.text).join("\n\n");
    const text = [notice?.text, restart, notesText].filter((t): t is string => !!t).join("\n\n");
    const messageNotice: ThreadMessageNotice = notice
      ? { kind: "agent-mode-switched", from: notice.from, to: notice.to }
      : { kind: "fleet-note" };
    const createdAt = nowIso();
    const messageId = `msg_u_${uuid()}`;
    this.emitMessageSent(rec, {
      messageId,
      role: "user",
      text,
      turnId: null,
      streaming: false,
      createdAt,
      notice: messageNotice,
    });
    this.emitEvent(rec, {
      ...this.base(rec),
      type: "turnStartRequested",
      payload: {
        threadId: rec.threadId as ThreadEvent["aggregateId"],
        messageId: messageId as ThreadMessage["id"],
        runtimeMode: rec.runtimeMode,
        interactionMode: rec.interactionMode,
        createdAt,
      },
    } as ThreadEvent);
    this.pushThreadShell(rec);
    void this.sessions
      .sendTurn({ threadId: rec.koraThreadId, text, origin: "kora-notice" })
      .catch((err) => {
        const r = this.threads.get(rec.threadId);
        if (!r) return;
        this.appendActivity(r, "error", "runtime_error", `note delivery failed: ${String(err)}`, {
          error: String(err),
        });
        this.setSession(r, "error", null, String(err));
      });
  }

  /**
   * X4: the leader hit its rate limit. The swarm keeps working (workers do not depend on Claude); record it (the
   * composer's `swarm-leader-limited` banner reads the latest `leader.rate-limited` activity's `until`), hold every
   * Kora turn, and deliver what collected as one digest once the limit resets.
   */
  private markLeaderLimited(
    rec: ThreadRecord,
    resetsAt: number | undefined,
    message: string | undefined,
  ): void {
    const now = Date.now();
    // The SDK reports seconds or milliseconds depending on the record; anything below 1e12 is seconds.
    const at = resetsAt === undefined ? undefined : resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
    const until = at !== undefined && at > now ? at : now + LEADER_LIMIT_FALLBACK_MS;
    if (rec.leaderLimit?.timer) clearTimeout(rec.leaderLimit.timer);
    const threadId = rec.threadId;
    const timer = setTimeout(
      () => this.onLeaderLimitReset(threadId),
      until - now + LEADER_LIMIT_GRACE_MS,
    );
    timer.unref?.();
    rec.leaderLimit = { until, timer };
    this.appendActivity(
      rec,
      "info",
      "leader.rate-limited",
      `${{ codex: "Codex", antigravity: "Antigravity", opencode: "OpenCode" }[rec.providerDriver] ?? "Claude"} is rate-limited until ${new Date(until).toISOString()}; the swarm keeps working`,
      { until, message: message ?? null },
    );
  }

  private onLeaderLimitReset(threadId: string): void {
    const rec = this.threads.get(threadId);
    if (!rec || !rec.leaderLimit) return;
    rec.leaderLimit = null;
    const collected = (rec.pendingNotes ?? []).length;
    rec.digestNext = collected > 0;
    this.appendActivity(
      rec,
      "info",
      "leader.rate-limited",
      collected > 0
        ? `Claude's rate limit reset — sending the swarm digest (${collected} update${collected === 1 ? "" : "s"})`
        : "Claude's rate limit reset",
      { until: null, message: null },
    );
    this.flushPending(rec);
  }

  /**
   * Explicit re-index of the repo a cwd belongs to — the composer graph chip's "Re-index"
   * action (freshness at session start/resume is the daemon's SessionManager's job). Always targets
   * the MAIN checkout, never a worktree. Fire-and-forget; the
   * chip reflects progress via the RUNNING ingest_jobs row that this creates.
   */
  /** The daemon's thread id behind a client thread (the key of cost.jsonl and the savings ledger), or null. */
  public koraThreadIdOf(threadId: string): string | null {
    return this.threads.get(threadId)?.koraThreadId ?? null;
  }

  /** B5: can the thread's last chip-started compaction be undone? */
  public canUndoCompaction(threadId: string): boolean {
    const rec = this.threads.get(threadId);
    return !!rec && this.sessions.canUndoCompaction?.(rec.koraThreadId) === true;
  }

  /** B5: restore the thread's transcript from before the compaction; the next message resumes from it. */
  public async undoCompaction(threadId: string): Promise<{ ok: boolean; reason?: string }> {
    const rec = this.threads.get(threadId);
    if (!rec || !this.sessions.undoCompaction) return { ok: false, reason: "no such thread" };
    try {
      return await this.sessions.undoCompaction(rec.koraThreadId);
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /** B5: a hand-over brief for starting a fresh thread (side session; falls back to a local digest). */
  public async threadBrief(
    threadId: string,
  ): Promise<{ brief: string; source: "side-session" | "digest" } | null> {
    const rec = this.threads.get(threadId);
    if (!rec || !this.sessions.threadBrief) return null;
    try {
      const r = await this.sessions.threadBrief(rec.koraThreadId);
      return r ? { brief: r.brief, source: r.source } : null;
    } catch {
      return null;
    }
  }

  /** B17: a graph answer for a pure "who calls X" question, or null (the client sends the message to the agent). */
  public async quickAnswer(
    threadId: string,
    text: string,
  ): Promise<{ text: string; kind: string; name: string; approxTokens: number } | null> {
    const rec = this.threads.get(threadId);
    if (!rec || !this.sessions.quickAnswer) return null;
    try {
      return await this.sessions.quickAnswer(rec.koraThreadId, text);
    } catch {
      return null;
    }
  }

  public discardQuickNotes(threadId: string): void {
    const rec = this.threads.get(threadId);
    if (rec) this.sessions.discardQuickNotes?.(rec.koraThreadId);
  }

  /** The distinct folders live threads work in, for the boot-time skill read. */
  public threadCwds(): string[] {
    return [...new Set([...this.threads.values()].map((rec) => rec.cwd).filter(Boolean))];
  }

  /** Does any live thread run on this provider driver (so its skill list is worth reading at boot)? */
  public usesDriver(driver: string): boolean {
    for (const rec of this.threads.values()) if (rec.providerDriver === driver) return true;
    return false;
  }

  public reindex(cwd: string, full = false): void {
    // No graph in a blob's workspace: never index ~/Blobs.
    if (isBlobsCwd(cwd)) return;
    if (typeof this.runtime.graph.ingest !== "function") return;
    const root = resolveMainRoot(cwd);
    try {
      void Promise.resolve(this.runtime.graph.ingest(root, { wait: false, full })).catch(() => {});
    } catch {
      /* best-effort */
    }
  }

  /** The project's default model, else its most recently created thread's model, else the daemon default. */
  private defaultModelSelectionFor(projectId: string): ModelPick {
    const project = this.projects.get(projectId)?.project;
    if (project?.defaultModelSelection) return project.defaultModelSelection;
    let latest: ThreadRecord | null = null;
    for (const rec of this.threads.values()) {
      if (rec.projectId !== projectId) continue;
      if (!latest || rec.createdAt > latest.createdAt) latest = rec;
    }
    return latest ? latest.modelSelection : DEFAULT_MODEL_PICK;
  }

  // ── Blobs (handlers/blobs.ts + blobsEngine.ts; docs/bots/ARCH.md sections 1, 3, 4) ───────────────────
  /** A blob is a project (`blobId === projectId`, surface "blobs"): its profile truth lives in the runtime
   *  `BlobStore`, mirrored here into a ProjectRecord so sessions, approvals, usage and the sidebar work unchanged. */
  private isBlobProject(projectId: string): boolean {
    return this.projects.get(projectId)?.project.surface === "blobs";
  }

  /** A blob's engine as the model selection a thread starts with. */
  private modelPickOfEngine(engine: BlobProfile["engine"]): ModelPick {
    return {
      instanceId: engine.instanceId,
      model: engine.model,
      ...(engine.effort ? { options: [{ id: "effort", value: engine.effort }] } : {}),
    } as unknown as ModelPick;
  }

  /** The access mode a blob's threads start in: the runtime's own table (`resolveBlobRuntimeMode`) when it offers
   *  one, else ask -> approval-required, full -> full-access, auto -> the engine's "free inside its workspace" mode. */
  public blobRuntimeMode(blob: BlobProfile): ChatThread["runtimeMode"] {
    const valid = ["approval-required", "auto-accept-edits", "auto", "full-access"];
    try {
      const fromRuntime = host().blobs?.runtimeModeFor?.(blob.engine.instanceId, blob.permission);
      if (fromRuntime && valid.includes(fromRuntime))
        return fromRuntime as ChatThread["runtimeMode"];
    } catch {
      /* fall through to the local table */
    }
    if (blob.permission === "ask") return "approval-required";
    if (blob.permission === "full") return "full-access";
    return blob.engine.instanceId === "claude" ? "auto" : "auto-accept-edits";
  }

  /** The posture a thread of blob `projectId` runs in for `instanceId` (its engine can differ per thread); null for a
   *  thread that is not a blob's. */
  private blobPostureFor(projectId: string, instanceId: string): ChatThread["runtimeMode"] | null {
    if (!this.isBlobProject(projectId)) return null;
    const profile = host().blobs?.store.get(projectId) ?? null;
    if (!profile) return null;
    return this.blobRuntimeMode({ ...profile, engine: { ...profile.engine, instanceId } });
  }

  /**
   * The access mode a NEW thread starts in. A blob's thread takes its blob's posture whatever the composer's default
   * said (the client's "Full access" default reached every blob thread and skipped Ask, the Auto policy and the
   * outbound rule). The creating command carries no way to tell a deliberate pick from a stale default, so it is never
   * trusted: the permission menu's explicit `setThreadRuntimeMode` is the only way to change it.
   */
  private initialRuntimeMode(
    projectId: string,
    instanceId: string,
    requested: ChatThread["runtimeMode"],
  ): ChatThread["runtimeMode"] {
    return this.blobPostureFor(projectId, instanceId) ?? requested;
  }

  /** A blob thread nobody changed by hand follows its blob's profile (Ask -> Full later applies to old threads too). */
  private followBlobPosture(rec: ThreadRecord): void {
    if (rec.runtimeModeSetByUser) return;
    const posture = this.blobPostureFor(rec.projectId, rec.modelSelection.instanceId);
    if (!posture || posture === rec.runtimeMode) return;
    rec.runtimeMode = posture;
    this.emitEvent(rec, {
      ...this.base(rec),
      type: "threadRuntimeModeSet",
      payload: {
        threadId: rec.threadId as ThreadEvent["aggregateId"],
        runtimeMode: posture,
        updatedAt: nowIso(),
      },
    } as ThreadEvent);
    this.pushThreadShell(rec);
  }

  /** Create or update the project that mirrors `blob`; pushes the change to every client. Idempotent. */
  public upsertBlobProject(blob: BlobProfile): void {
    // A blob's project root must be a folder under the Blobs root: that is what makes it an assistant folder (no
    // graph, no worktree, trusted). A profile pointing anywhere else is never mirrored.
    if (!isBlobsCwd(blob.workspace)) {
      host().log(
        `[kora-ui] blob ${blob.id} not mirrored: ${blob.workspace} is outside the Blobs folder`,
      );
      return;
    }
    const existing = this.projects.get(blob.id);
    const pick = this.modelPickOfEngine(blob.engine);
    const next: ChatProjectHead = {
      ...(existing?.project ?? {
        scripts: [],
        createdAt: new Date(blob.createdAt).toISOString() as ChatProjectHead["createdAt"],
      }),
      id: blob.id as ChatProjectHead["id"],
      title: (blob.name || blob.id) as ChatProjectHead["title"],
      workspaceRoot: blob.workspace as ChatProjectHead["workspaceRoot"],
      defaultModelSelection: pick,
      surface: "blobs",
      updatedAt: new Date(blob.updatedAt).toISOString() as ChatProjectHead["updatedAt"],
    } as ChatProjectHead;
    if (existing) {
      const before = existing.project;
      if (
        before.title === next.title &&
        before.workspaceRoot === next.workspaceRoot &&
        before.surface === "blobs" &&
        JSON.stringify(before.defaultModelSelection) === JSON.stringify(pick)
      )
        return;
      existing.project = next;
      this.persistProjects();
      this.pushProjectShell(existing);
      return;
    }
    const rec: ProjectRecord = { project: next };
    this.projects.set(blob.id, rec);
    this.persistProjects();
    this.pushProjectShell(rec);
  }

  /** Reconcile the project mirror with the blob store (boot + every store change). Never removes a project: a real
   *  delete is explicit (`deleteBlobProject`), so a store that briefly lists nothing cannot hide anyone's threads. */
  public syncBlobProjects(): void {
    const blobs = host().blobs;
    if (!blobs) return;
    let list: BlobProfile[];
    try {
      list = blobs.store.list({ includeArchived: true });
    } catch (cause) {
      host().log(
        `[kora-ui] blob project sync skipped: ${String((cause as Error)?.message ?? cause)}`,
      );
      return;
    }
    for (const blob of list) this.upsertBlobProject(blob);
  }

  /** Real delete: the blob's threads (workers killed), then its project. */
  public deleteBlobProject(blobId: string): void {
    if (!this.isBlobProject(blobId)) return;
    this.deleteProject(blobId);
  }

  // ── Chat -> Kora migration (chatMigration.ts): the engine slice it drives ─────────────────────────────
  /** Project heads whose folder is under the retired Chat folders (General and every Chat project). */
  public legacyProjects(isLegacy: (cwd: string) => boolean): LegacyProjectHead[] {
    return [...this.projects.values()]
      .map((p) => p.project)
      .filter((p) => isLegacy(p.workspaceRoot))
      .map((p) => {
        const pick = p.defaultModelSelection as unknown as {
          instanceId?: string;
          model?: string;
          options?: Array<{ id: string; value: unknown }>;
        } | null;
        const effort = pick?.options?.find((o) => o.id === "effort")?.value;
        return {
          id: p.id,
          title: p.title,
          workspaceRoot: p.workspaceRoot,
          engine:
            pick?.instanceId && pick.model
              ? {
                  instanceId: pick.instanceId,
                  model: pick.model,
                  effort: typeof effort === "string" ? effort : null,
                }
              : null,
        };
      });
  }

  /** Threads that live in a retired Chat folder (or belong to a legacy project), newest first, un-archived first. */
  public legacyThreads(isLegacy: (cwd: string) => boolean): LegacyThread[] {
    const legacyProjects = new Set(this.legacyProjects(isLegacy).map((p) => p.id));
    return [...this.threads.values()]
      .filter((r) => isLegacy(r.cwd) || legacyProjects.has(r.projectId))
      .sort(
        (a, b) =>
          Number(!!a.archivedAt) - Number(!!b.archivedAt) || b.updatedAt.localeCompare(a.updatedAt),
      )
      .map((r) => ({
        threadId: r.threadId,
        projectId: r.projectId,
        cwd: r.cwd,
        title: r.title,
        archived: !!r.archivedAt,
        running: this.threadRunning(r),
      }));
  }

  public threadExists(threadId: string): boolean {
    return this.threads.has(threadId);
  }

  /**
   * Re-point a thread at a blob: its project, folder and runtime head change; the transcript stays as it was except
   * that paths under the old folder (`rewrites`, longest first) now name the blob's copy of those files.
   */
  public async moveThread(
    threadId: string,
    blob: { id: string; workspace: string },
    rewrites: ReadonlyArray<readonly [string, string]>,
  ): Promise<{ moved: boolean; transcriptCopied: boolean; reason?: string }> {
    const rec = this.threads.get(threadId);
    if (!rec) return { moved: false, transcriptCopied: false, reason: "the chat is gone" };
    if (!this.projects.has(blob.id))
      return { moved: false, transcriptCopied: false, reason: "the blob is not ready" };
    if (this.threadRunning(rec))
      return { moved: false, transcriptCopied: false, reason: "it is running right now" };
    let transcriptCopied = false;
    try {
      const moveHead = this.sessions.moveThread?.bind(this.sessions);
      if (moveHead)
        transcriptCopied = (await moveHead(rec.koraThreadId, blob.workspace)).transcriptCopied;
    } catch (cause) {
      return {
        moved: false,
        transcriptCopied: false,
        reason: `its session could not be moved (${String((cause as Error)?.message ?? cause)})`,
      };
    }
    const rewrite = (value: string): string => {
      let out = value;
      for (const [from, to] of rewrites)
        if (from && out.includes(from)) out = out.split(from).join(to);
      return out;
    };
    const deep = <T>(value: T): T => JSON.parse(rewrite(JSON.stringify(value ?? null))) as T;
    rec.messages = deep(rec.messages);
    rec.activities = deep(rec.activities);
    rec.projectId = blob.id;
    rec.cwd = blob.workspace;
    rec.worktreePath = null;
    this.persistThread(rec);
    this.pushThreadShell(rec);
    return { moved: true, transcriptCopied };
  }

  /** Remove a project head whose threads have all moved away. Never touches a project that still has threads. */
  public dropProject(projectId: string): void {
    for (const rec of this.threads.values()) if (rec.projectId === projectId) return;
    if (this.isBlobProject(projectId)) return;
    if (this.projects.delete(projectId)) {
      this.persistProjects();
      const item: ThreadIndexItem = {
        kind: "project-removed",
        sequence: this.nextSeq(),
        projectId: projectId as ChatProjectHead["id"],
      };
      for (const l of this.shellListeners) l(item);
    }
  }

  /** A one-message thread from a blob (no model run): the migration's "Moved your Chat projects into Kora" notice. */
  public postNotice(blobId: string, title: string, markdown: string): string | null {
    const blob = host().blobs?.store.get(blobId) ?? null;
    if (!blob || !this.isBlobProject(blobId)) return null;
    const threadId = uuid();
    const createdAt = nowIso();
    this.createThread({
      threadId,
      projectId: blob.id,
      title: title.slice(0, 120),
      modelSelection: this.modelPickOfEngine(blob.engine),
      runtimeMode: this.blobRuntimeMode(blob),
      interactionMode: "default",
      agentMode: "swarm",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    const rec = this.threads.get(threadId);
    if (!rec) return null;
    this.emitMessageSent(rec, {
      messageId: `msg_a_${uuid()}`,
      role: "assistant",
      text: markdown,
      turnId: null,
      streaming: false,
      createdAt,
    });
    this.pushThreadShell(rec);
    return threadId;
  }

  private threadRunning(rec: ThreadRecord): boolean {
    const status = rec.session?.status;
    if (status === "running" || status === "starting" || rec.currentAssistant !== null) return true;
    return (this.blobStarting.get(rec.threadId) ?? 0) > Date.now() - 60_000;
  }

  /** How many of a blob's threads are running right now (the SPEC's three-at-once cap). */
  public blobRunningCount(blobId: string, exceptThreadId?: string): number {
    let n = 0;
    for (const rec of this.threads.values()) {
      if (rec.projectId !== blobId || rec.archivedAt || rec.threadId === exceptThreadId) continue;
      if (this.threadRunning(rec)) n += 1;
    }
    return n;
  }

  /** Throws the refusal the user reads; otherwise reserves a running slot for this thread. */
  private assertBlobCanRun(rec: ThreadRecord): void {
    const project = this.projects.get(rec.projectId)?.project;
    if (project?.surface !== "blobs") return;
    const blob = host().blobs?.store.get(rec.projectId) ?? null;
    if (blob?.archivedAt != null)
      throw new Error(`${project.title} is retired. Rehire them to chat again.`);
    // A follow-up into a thread that is already running adds nothing to the count.
    if (this.threadRunning(rec)) return;
    if (this.blobRunningCount(rec.projectId, rec.threadId) >= BLOB_MAX_RUNNING_THREADS)
      throw new Error(
        `${project.title} is already running ${BLOB_MAX_RUNNING_THREADS} threads. Wait for one to finish (or stop one), then send again.`,
      );
    this.blobStarting.set(rec.threadId, Date.now());
  }

  /** Tokens per blob and per thread, from the per-thread leader usage the engine already keeps. */
  public blobUsage(blobId: string): BlobUsage {
    const total = { input: 0, cached: 0, output: 0, turns: 0 };
    const byThread: Array<{
      threadId: string;
      title: string;
      totals: typeof total;
      updatedAt: string;
    }> = [];
    for (const rec of this.threads.values()) {
      if (rec.projectId !== blobId || !rec.leaderUsage) continue;
      const u = rec.leaderUsage;
      total.input += u.input;
      total.cached += u.cached;
      total.output += u.output;
      total.turns += u.turns;
      byThread.push({
        threadId: rec.threadId,
        title: rec.title,
        totals: { input: u.input, cached: u.cached, output: u.output, turns: u.turns },
        updatedAt: rec.updatedAt,
      });
    }
    byThread.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      blobId,
      total,
      byThread: byThread.map(({ threadId, title, totals }) => ({ threadId, title, totals })),
    };
  }

  /** The latest version of card `cardId` in a thread, or null. */
  private latestCard(rec: ThreadRecord, cardId: string): BlobCardPayload | null {
    for (let i = rec.activities.length - 1; i >= 0; i--) {
      const a = rec.activities[i]!;
      if (a.kind !== "blob.card") continue;
      const card = a.payload as BlobCardPayload | null;
      if (card && card.cardId === cardId) return card;
    }
    return null;
  }

  /** One `blob.card` activity row; the client shows the highest `version` per `cardId`. */
  public appendBlobCard(rec: ThreadRecord, card: BlobCardPayload): void {
    this.appendActivity(
      rec,
      "info",
      "blob.card",
      cardSummary(card),
      card,
      (rec.session?.activeTurnId ?? rec.latestTurn?.turnId ?? undefined) as string | undefined,
    );
  }

  private appendRateLimitCard(rec: ThreadRecord, resetsAt: number | undefined): void {
    if (!this.isBlobProject(rec.projectId)) return;
    const at = typeof resetsAt === "number" ? (resetsAt < 1e12 ? resetsAt * 1000 : resetsAt) : null;
    const cardId = `rate-limit:${rec.threadId}`;
    const last = this.latestCard(rec, cardId);
    if (last && last.cardKind === "rate-limit" && last.resetsAt === at) return;
    this.appendBlobCard(rec, {
      cardKind: "rate-limit",
      cardId,
      version: (last?.version ?? 0) + 1,
      engine: rec.modelSelection.instanceId,
      resetsAt: at,
      threadId: rec.threadId,
    });
  }

  /**
   * A blob turn settled: tell the settle listeners (Phase 2 jobs), then — once per assistant message, only when the
   * turn went fine and was a real exchange — hand it to the runtime memory hook and append ONE `blob.card` with the
   * receipts. Fire and forget: a failing extractor never surfaces and never delays the next turn.
   */
  private onBlobTurnSettled(rec: ThreadRecord, status: ChatSessionStatus): void {
    if (!this.isBlobProject(rec.projectId)) return;
    this.memberTaps.get(rec.threadId)?.({ kind: "settled", status });
    for (const cb of this.blobSettledListeners) {
      try {
        cb({
          threadId: rec.threadId,
          koraThreadId: rec.koraThreadId,
          blobId: rec.projectId,
          ok: status === "ready",
        });
      } catch {
        /* a listener must never break the settle */
      }
    }
    this.emitBlobAttention(
      rec,
      status === "ready" ? "settled" : status === "error" ? "failed" : null,
    );
    if (status !== "ready") return;
    // A group member's turn is learned from by `runMemberTurn` (the person's words, not the group framing).
    if (rec.origin?.kind === "group") return;
    const blobs = host().blobs;
    if (!blobs) return;
    const assistantId = rec.latestTurn?.assistantMessageId ?? null;
    const aIdx = assistantId ? rec.messages.findIndex((m) => m.id === assistantId) : -1;
    const assistant = aIdx >= 0 ? rec.messages[aIdx]! : null;
    if (!assistant || !assistant.text.trim() || this.memoryHooked.has(assistant.id)) return;
    let user: ThreadMessage | null = null;
    for (let i = aIdx - 1; i >= 0; i--) {
      if (rec.messages[i]!.role === "user") {
        user = rec.messages[i]!;
        break;
      }
    }
    // A Kora-authored turn (a worker note, a mode notice) and a seed prompt are not the user talking.
    if (!user || user.notice || user.id === rec.seedMessageId) return;
    this.memoryHooked.add(assistant.id);
    const threadId = rec.threadId;
    const blobId = rec.projectId;
    const cardId = `memory:${assistant.id}`;
    // The first message of a thread Kora started is her hand-off brief: Kora's words, not the user's. The user's own
    // follow-ups in that thread are learned from as usual.
    const brief =
      rec.origin?.kind === "kora" && rec.messages.find((m) => m.role === "user")?.id === user.id;
    void Promise.resolve()
      .then(() =>
        blobs.afterTurn({
          blobId,
          threadId,
          messageIds: { user: user!.id, assistant: assistant.id },
          userText: user!.text,
          assistantText: assistant.text,
          at: Date.now(),
          ...(brief ? { brief: true } : {}),
        }),
      )
      .then((raw) => {
        const receipts = (Array.isArray(raw) ? raw : []).map(toWireReceipt).filter((r) => r.id);
        const live = this.threads.get(threadId);
        if (!live || receipts.length === 0) return;
        this.appendBlobCard(live, { cardKind: "memory", cardId, version: 1, receipts });
      })
      .catch((cause) => {
        host().log(
          `[kora-ui] blob memory hook failed for ${threadId}: ${String((cause as Error)?.message ?? cause).slice(0, 200)}`,
        );
      });
  }

  /** Tell the job engine something changed on a blob thread that is not a settled turn (an approval / question opened
   *  or was answered): it re-reads the snapshot and moves its step between "running" and "needs you". */
  private pokeBlobWatchers(rec: ThreadRecord): void {
    if (!this.isBlobProject(rec.projectId)) return;
    for (const cb of this.blobSettledListeners) {
      try {
        cb({
          threadId: rec.threadId,
          koraThreadId: rec.koraThreadId,
          blobId: rec.projectId,
          ok: true,
        });
      } catch {
        /* a listener must never break the event */
      }
    }
  }

  private emitBlobAttention(
    rec: ThreadRecord,
    kind: "settled" | "needs-you" | "failed" | null,
  ): void {
    if (!kind) return;
    // A routine run reports through the routine service (one notification per run, generic text): its thread stays quiet.
    if (rec.origin?.kind === "routine") return;
    // A step Kora delegated finishing is not news for the user: Kora reports it. Needs-you / failure still are.
    if (kind === "settled" && rec.origin?.kind === "kora") return;
    // A group member's hidden session: its replies are the group's business; needs-you / failure point at the GROUP thread.
    if (rec.origin?.kind === "group" && kind === "settled") return;
    const notifyThread =
      rec.origin?.kind === "group" && rec.origin.groupThreadId
        ? rec.origin.groupThreadId
        : rec.threadId;
    for (const cb of this.blobAttentionListeners) {
      try {
        cb({ threadId: notifyThread, blobId: rec.projectId, kind });
      } catch {
        /* advisory */
      }
    }
  }

  /** `BlobEngineBridge`-adjacent: the daemon's notifier subscribes here (settled / needs-you / failed on any blob thread). */
  public onBlobAttention(
    cb: (e: { threadId: string; blobId: string; kind: "settled" | "needs-you" | "failed" }) => void,
  ): () => void {
    this.blobAttentionListeners.add(cb);
    return () => this.blobAttentionListeners.delete(cb);
  }

  /** `BlobEngineBridge.interrupt`: stop a running blob thread (job cancel). */
  public async interruptBlobThread(threadId: string): Promise<void> {
    const rec = this.threads.get(threadId);
    if (!rec || !this.isBlobProject(rec.projectId)) return;
    await this.sessions.interrupt(rec.koraThreadId);
  }

  /** The receipt `receiptId` as the newest memory card shows it, or null (a card from before a restart still counts:
   *  cards are persisted activities). */
  public findMemoryReceipt(receiptId: string): MemoryReceipt | null {
    for (const rec of this.threads.values()) {
      if (!this.isBlobProject(rec.projectId)) continue;
      for (let i = rec.activities.length - 1; i >= 0; i--) {
        const a = rec.activities[i]!;
        const card = a.kind === "blob.card" ? (a.payload as BlobCardPayload | null) : null;
        if (!card || card.cardKind !== "memory" || !card.receipts.some((r) => r.id === receiptId))
          continue;
        const latest = this.latestCard(rec, card.cardId);
        if (latest?.cardKind !== "memory") return null;
        return latest.receipts.find((r) => r.id === receiptId) ?? null;
      }
    }
    return null;
  }

  /** Undo / confirm changed a receipt: re-emit the memory card that carries it, one version up (`undone: true`). */
  public reemitMemoryReceipt(updated: MemoryReceipt, replacesId: string = updated.id): void {
    for (const rec of this.threads.values()) {
      if (!this.isBlobProject(rec.projectId)) continue;
      for (let i = rec.activities.length - 1; i >= 0; i--) {
        const a = rec.activities[i]!;
        const card = a.kind === "blob.card" ? (a.payload as BlobCardPayload | null) : null;
        if (!card || card.cardKind !== "memory" || !card.receipts.some((r) => r.id === replacesId))
          continue;
        const latest = this.latestCard(rec, card.cardId);
        if (!latest || latest.cardKind !== "memory") return;
        this.appendBlobCard(rec, {
          ...latest,
          version: latest.version + 1,
          receipts: latest.receipts.map((r) => (r.id === replacesId ? updated : r)),
        });
        return;
      }
    }
  }

  /** A self-change receipt was undone: re-emit its card one version up with `undone: true`. */
  public markSelfChangeUndone(token: string): void {
    for (const rec of this.threads.values()) {
      if (!this.isBlobProject(rec.projectId)) continue;
      for (let i = rec.activities.length - 1; i >= 0; i--) {
        const a = rec.activities[i]!;
        const card = a.kind === "blob.card" ? (a.payload as BlobCardPayload | null) : null;
        if (!card || card.cardKind !== "self-change" || card.undoToken !== token) continue;
        const latest = this.latestCard(rec, card.cardId);
        if (!latest || latest.cardKind !== "self-change" || latest.undone) return;
        this.appendBlobCard(rec, { ...latest, version: latest.version + 1, undone: true });
        return;
      }
    }
  }

  /** The thread (UI id) behind a runtime thread id. */
  private threadOfKora(koraThreadId: string): ThreadRecord | null {
    const id = this.koraToThread.get(koraThreadId);
    return id ? (this.threads.get(id) ?? null) : null;
  }

  /** Start a fresh thread in a blob's project with `prompt` as the first user message. Shared by delegated work
   *  (`BlobEngineBridge.startThread`) and "continue on a free model". */
  private async spawnBlobThread(p: {
    blob: BlobProfile;
    title: string;
    prompt: string;
    origin: ThreadOrigin;
    engine?: BlobProfile["engine"];
    /** The prompt only seeds the thread: its turn is not learned from. */
    seed?: boolean;
  }): Promise<ThreadRecord> {
    const threadId = uuid();
    const messageId = uuid();
    const createdAt = nowIso();
    const engine = p.engine ?? p.blob.engine;
    const modelSelection = this.modelPickOfEngine(engine);
    const runtimeMode = this.blobRuntimeMode({ ...p.blob, engine });
    this.createThread({
      threadId,
      projectId: p.blob.id,
      title: p.title.trim().slice(0, 120) || "New thread",
      modelSelection,
      runtimeMode,
      interactionMode: "default",
      agentMode: "swarm",
      branch: null,
      worktreePath: null,
      createdAt,
      origin: p.origin,
      ...(p.seed ? { seedMessageId: messageId } : {}),
    });
    await this.startTurn({
      type: "turn.start",
      commandId: uuid(),
      threadId,
      message: { messageId, role: "user", text: p.prompt, attachments: [] },
      modelSelection,
      runtimeMode,
      interactionMode: "default",
      createdAt,
    } as unknown as Extract<ClientChatCommand, { type: "turn.start" }>);
    return this.threads.get(threadId)!;
  }

  /** `BlobEngineBridge.startThread`. */
  public async startBlobThread(p: {
    blobId: string;
    title: string;
    prompt: string;
    origin: ThreadOrigin;
    fromKoraThreadId?: string | null;
  }): Promise<
    { threadId: string; koraThreadId: string } | { refused: "busy" | "archived" | "unknown" }
  > {
    const blob = host().blobs?.store.get(p.blobId) ?? null;
    if (!blob || !this.isBlobProject(p.blobId)) return { refused: "unknown" };
    if (blob.archivedAt != null) return { refused: "archived" };
    if (this.blobRunningCount(p.blobId) >= BLOB_MAX_RUNNING_THREADS) return { refused: "busy" };
    const rec = await this.spawnBlobThread({ blob, ...p });
    return { threadId: rec.threadId, koraThreadId: rec.koraThreadId };
  }

  /** A routine run's execution thread: a normal blob thread (same engine, posture, memory skip) the client never lists.
   *  `hidden` is derived from `origin.kind === "routine"`, so it survives a restart without its own stored field. */
  public async startHiddenBlobThread(p: {
    blobId: string;
    title: string;
    prompt: string;
    origin: ThreadOrigin;
  }): Promise<
    { threadId: string; koraThreadId: string } | { refused: "busy" | "archived" | "unknown" }
  > {
    const blob = host().blobs?.store.get(p.blobId) ?? null;
    if (!blob || !this.isBlobProject(p.blobId) || p.origin.kind !== "routine")
      return { refused: "unknown" };
    if (blob.archivedAt != null) return { refused: "archived" };
    if (this.blobRunningCount(p.blobId) >= BLOB_MAX_RUNNING_THREADS) return { refused: "busy" };
    // seed: the routine prompt is instructions, not the user talking, so memory never learns from it.
    const rec = await this.spawnBlobThread({ blob, ...p, seed: true });
    return { threadId: rec.threadId, koraThreadId: rec.koraThreadId };
  }

  /** The visible thread a routine posts its dated reports into (no turn is started). */
  public async createBlobResultsThread(p: {
    blobId: string;
    title: string;
  }): Promise<{ threadId: string } | null> {
    const blob = host().blobs?.store.get(p.blobId) ?? null;
    if (!blob || !this.isBlobProject(p.blobId) || blob.archivedAt != null) return null;
    const threadId = uuid();
    const createdAt = nowIso();
    this.createThread({
      threadId,
      projectId: blob.id,
      title: p.title.trim().slice(0, 120) || "Routine results",
      modelSelection: this.modelPickOfEngine(blob.engine),
      runtimeMode: this.blobRuntimeMode(blob),
      interactionMode: "default",
      agentMode: "swarm",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    const rec = this.threads.get(threadId);
    if (!rec) return null;
    this.emitMessageSent(rec, {
      messageId: `msg_a_${uuid()}`,
      role: "assistant",
      text: `This is where ${p.title.replace(/ · results$/, "")} reports land. Every run posts a dated card here; Open run shows how it got there.`,
      turnId: null,
      streaming: false,
      createdAt,
    });
    this.pushThreadShell(rec);
    return { threadId };
  }

  /**
   * Retention for routine runs: delete a hidden execution thread once its run is finished. Only a thread whose origin says it
   * is a routine run, that is not running and is not waiting on an approval / question, is ever deleted; a visible thread, a
   * Kora-delegated one or anything unknown is left alone.
   */
  public deleteHiddenBlobThread(threadId: string): boolean {
    const rec = this.threads.get(threadId);
    if (!rec || !this.isBlobProject(rec.projectId) || rec.origin?.kind !== "routine") return false;
    if (this.threadRunning(rec) || this.hasPendingRequest(rec)) return false;
    this.deleteThread(threadId);
    return true;
  }

  public blobThreadExists(threadId: string): boolean {
    const rec = this.threads.get(threadId);
    return !!rec && !rec.archivedAt;
  }

  /** Append a card to a thread by its UI id (a routine report). false = the thread is gone. */
  public postBlobCardToThread(threadId: string, card: BlobCardPayload): boolean {
    const rec = this.threads.get(threadId);
    if (!rec || !this.isBlobProject(rec.projectId)) return false;
    this.appendBlobCard(rec, card);
    this.pushThreadShell(rec);
    return true;
  }

  /** The newest version of a card changed (a confirm card answered): re-emit it in the thread that holds it. */
  public updateBlobCard(card: BlobCardPayload): boolean {
    for (const rec of this.threads.values()) {
      if (!this.isBlobProject(rec.projectId)) continue;
      const latest = this.latestCard(rec, card.cardId);
      if (!latest) continue;
      this.appendBlobCard(rec, card);
      return true;
    }
    return false;
  }

  /** The blob's visible threads, newest first (where a routine's report can go). Routine runs are never listed. */
  public blobThreadChoices(blobId: string): Array<{ id: string; title: string }> {
    const out: Array<{ id: string; title: string; updatedAt: string }> = [];
    for (const rec of this.threads.values()) {
      if (
        rec.projectId !== blobId ||
        rec.archivedAt ||
        rec.origin?.kind === "routine" ||
        rec.origin?.kind === "group"
      )
        continue;
      out.push({ id: rec.threadId, title: rec.title, updatedAt: rec.updatedAt });
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out.slice(0, 60).map(({ id, title }) => ({ id, title }));
  }

  /** `BlobEngineBridge.sendToThread`: a follow-up into a blob thread the runtime started. */
  public async sendToBlobThread(
    threadId: string,
    text: string,
    origin: ThreadOrigin,
    via?: string,
  ): Promise<void> {
    const rec = this.threads.get(threadId);
    if (!rec || !this.isBlobProject(rec.projectId))
      throw new Error(`unknown blob thread ${threadId}`);
    void origin; // the thread keeps the origin it was started with
    await this.startTurn({
      type: "turn.start",
      commandId: uuid(),
      threadId,
      message: { messageId: uuid(), role: "user", text, attachments: [], ...(via ? { via } : {}) },
      modelSelection: rec.modelSelection,
      runtimeMode: rec.runtimeMode,
      interactionMode: rec.interactionMode,
      createdAt: nowIso(),
    } as unknown as Extract<ClientChatCommand, { type: "turn.start" }>);
  }

  /** Is the thread parked on an approval / question / worker pick? */
  private hasPendingRequest(rec: ThreadRecord): boolean {
    const open = this.openRequests(rec);
    return open.approvals + open.userInput > 0;
  }

  /** Open requests by kind: an approval, or a question / worker pick (both wait on the user's answer). */
  private openRequests(rec: ThreadRecord): { approvals: number; userInput: number } {
    const open = new Map<string, "approval" | "input">();
    for (const a of rec.activities) {
      const requestId = (a.payload as { requestId?: unknown } | null)?.requestId;
      if (typeof requestId !== "string") continue;
      if (a.kind === "approval.requested") open.set(requestId, "approval");
      else if (a.kind === "user-input.requested" || a.kind === "worker-picker.requested")
        open.set(requestId, "input");
      else if (REQUEST_RESOLVED_KINDS.has(a.kind)) open.delete(requestId);
    }
    let approvals = 0;
    for (const kind of open.values()) if (kind === "approval") approvals++;
    return { approvals, userInput: open.size - approvals };
  }

  /** `BlobEngineBridge.snapshot`: a blob thread's state, last answer, fresh output files and tokens. */
  public blobThreadSnapshot(threadId: string): {
    state: "running" | "idle" | "needs-you" | "error";
    finalText: string | null;
    outputs: string[];
    tokens: { input: number; cached: number; output: number; turns: number };
    /** The last turn was cut off by a daemon restart: its text is a half-finished answer, not a result. */
    interrupted?: boolean;
  } | null {
    const rec = this.threads.get(threadId);
    if (!rec || !this.isBlobProject(rec.projectId)) return null;
    const running = this.threadRunning(rec);
    const state = this.hasPendingRequest(rec)
      ? "needs-you"
      : running
        ? "running"
        : rec.session?.status === "error"
          ? "error"
          : "idle";
    let finalText: string | null = null;
    if (!running) {
      for (let i = rec.messages.length - 1; i >= 0; i--) {
        const m = rec.messages[i]!;
        if (m.role === "assistant" && !m.streaming && m.text.trim()) {
          finalText = m.text;
          break;
        }
      }
    }
    const root = this.projects.get(rec.projectId)!.project.workspaceRoot;
    const outputs = listBlobFiles(root, Date.parse(rec.createdAt) || null)
      .slice(0, 20)
      .map((f) => f.path);
    const u = rec.leaderUsage ?? { input: 0, cached: 0, output: 0, turns: 0 };
    const interrupted =
      !running &&
      rec.session?.status === "interrupted" &&
      /daemon restarted/i.test(rec.session.lastError ?? "");
    return {
      state,
      finalText,
      outputs,
      tokens: { ...u },
      ...(interrupted ? { interrupted: true } : {}),
    };
  }

  /** `BlobEngineBridge.appendCard`: by the runtime's own thread id. */
  public appendBlobCardByKoraThread(koraThreadId: string, card: BlobCardPayload): void {
    const rec = this.threadOfKora(koraThreadId);
    if (rec) this.appendBlobCard(rec, card);
  }

  /** `BlobEngineBridge.queueNote`: a `[kora] ...` note the thread's agent hears on its next idle moment. */
  public queueBlobNote(koraThreadId: string, text: string): void {
    const rec = this.threadOfKora(koraThreadId);
    if (!rec) return;
    this.queueNote(rec, { kind: "report", paneId: `blob-note-${uuid()}`, text });
  }

  /** `BlobEngineBridge.onSettled`. */
  public onBlobSettled(
    cb: (e: { threadId: string; koraThreadId: string; blobId: string; ok: boolean }) => void,
  ): () => void {
    this.blobSettledListeners.add(cb);
    return () => this.blobSettledListeners.delete(cb);
  }

  /**
   * A provider cannot change mid-thread, so "continue on a free model" starts a NEW thread on the best free OpenCode
   * model with a digest of this one (last six messages + the request still waiting for an answer). The seed turn is
   * not learned from.
   */
  public async continueBlobThreadOnFree(threadId: string): Promise<string> {
    const rec = this.threads.get(threadId);
    if (!rec || !this.isBlobProject(rec.projectId))
      throw new Error(
        "This chat can't be moved to a free model. Start a new chat with the blob instead.",
      );
    const blob = host().blobs?.store.get(rec.projectId) ?? null;
    if (!blob) throw new Error("That blob no longer exists.");
    if (blob.archivedAt != null) throw new Error(`${blob.name} is retired. Rehire them first.`);
    // A rate-limited free model is the one NOT to go back to (its cooldown may not have reached the status yet).
    const limited = rec.modelSelection.instanceId === "opencode" ? [rec.modelSelection.model] : [];
    const free = await pickFreeEngine(limited);
    if (!free)
      throw new Error(
        limited.length
          ? "Every other free model is busy or not set up right now. Try again in a few minutes."
          : "No free model is ready yet. Finish the free-model setup in Settings, or wait for the limit to reset.",
      );
    if (this.blobRunningCount(blob.id) >= BLOB_MAX_RUNNING_THREADS)
      throw new Error(`${blob.name} is already running ${BLOB_MAX_RUNNING_THREADS} threads.`);
    const fresh = await this.spawnBlobThread({
      blob,
      title: `${rec.title} (continued)`,
      prompt: buildContinueSeed({
        messages: rec.messages,
        fromEngine: rec.modelSelection.instanceId,
        toModel: free.model,
      }),
      origin: {
        kind: "continue",
        jobId: rec.origin?.jobId ?? null,
        stepId: rec.origin?.stepId ?? null,
        fromThreadId: rec.threadId,
        fromBlobId: rec.origin?.fromBlobId ?? null,
      },
      engine: free,
      seed: true,
    });
    return fresh.threadId;
  }

  // ── Blobs groups (docs/bots/GROUPS.md; the router and orchestrator live in packages/runtime/src/blobs/groups) ───────
  // A group is a project (`groupId === projectId`, surface "blobs") whose folder is the group's shared folder. Each of its
  // threads is ONE transcript the person sees; every member answers from its OWN hidden provider thread (origin "group"),
  // so its engine, posture, SOUL, memory, skills and tools stay its own. The runtime's GroupOrchestrator decides who answers
  // and drives `runMemberTurn`; this engine turns its events into transcript rows.
  private groupsSvc() {
    return host().blobs?.groups;
  }

  private groupOfProject(projectId: string): KoraGroupJson | null {
    try {
      return this.groupsSvc()?.groups.get(projectId) ?? null;
    } catch {
      return null;
    }
  }

  private isGroupThread(rec: ThreadRecord): boolean {
    return this.groupOfProject(rec.projectId) !== null;
  }

  /** The thread an approval / question answer belongs to: a group thread mirrors its members' cards, the member's session owns them. */
  private requestOwner(threadId: string, requestId: string): ThreadRecord | undefined {
    const rec = this.threads.get(threadId);
    if (rec && this.isGroupThread(rec)) {
      const memberId = this.memberRequests.get(requestId);
      const member = memberId ? this.threads.get(memberId) : undefined;
      if (member) return member;
    }
    return rec;
  }

  /** Create or update the project that mirrors `group`; pushes the change to every client. Idempotent. */
  public upsertGroupProject(group: KoraGroupJson): void {
    if (!isBlobsCwd(group.workspace)) {
      host().log(
        `[kora-ui] group ${group.id} not mirrored: ${group.workspace} is outside the Blobs folder`,
      );
      return;
    }
    const lead = host().blobs?.store.get(group.leadId) ?? null;
    const pick = lead ? this.modelPickOfEngine(lead.engine) : null;
    const existing = this.projects.get(group.id);
    const next: ChatProjectHead = {
      ...(existing?.project ?? {
        scripts: [],
        createdAt: new Date(group.createdAt).toISOString() as ChatProjectHead["createdAt"],
      }),
      id: group.id as ChatProjectHead["id"],
      title: (group.name || group.id) as ChatProjectHead["title"],
      workspaceRoot: group.workspace as ChatProjectHead["workspaceRoot"],
      defaultModelSelection: pick,
      surface: "blobs",
      updatedAt: new Date(group.updatedAt).toISOString() as ChatProjectHead["updatedAt"],
    } as ChatProjectHead;
    if (existing) {
      const before = existing.project;
      if (
        before.title === next.title &&
        before.workspaceRoot === next.workspaceRoot &&
        before.surface === "blobs" &&
        JSON.stringify(before.defaultModelSelection) === JSON.stringify(pick)
      )
        return;
      existing.project = next;
      this.persistProjects();
      this.pushProjectShell(existing);
      return;
    }
    const rec: ProjectRecord = { project: next };
    this.projects.set(group.id, rec);
    this.persistProjects();
    this.pushProjectShell(rec);
  }

  /** Reconcile the project mirror with the group store. A group that was deleted takes its project and threads with it. */
  public syncGroupProjects(): void {
    const svc = this.groupsSvc();
    if (!svc) return;
    let list: KoraGroupJson[];
    try {
      list = svc.groups.list({ includeArchived: true });
    } catch (cause) {
      host().log(
        `[kora-ui] group project sync skipped: ${String((cause as Error)?.message ?? cause)}`,
      );
      return;
    }
    for (const g of list) this.upsertGroupProject(g);
    const known = new Set(list.map((g) => g.id));
    for (const id of [...this.projects.keys()]) {
      if (id.startsWith("group_") && !known.has(id)) this.deleteProject(id);
    }
  }

  /** Boot: re-link member sessions to their group threads, and close any reply bubble a dead daemon left streaming. */
  private rebuildGroupState(): void {
    for (const rec of this.threads.values()) {
      if (rec.origin?.kind === "group" && rec.origin.groupThreadId)
        this.groupMemberThreads.set(
          memberThreadKey(rec.origin.groupThreadId, rec.projectId),
          rec.threadId,
        );
      else if (rec.projectId.startsWith("group_")) {
        rec.messages = rec.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m));
        // a card a dead daemon left open can no longer be answered
        for (const requestId of [
          ...openRequests(rec.activities).approvals,
          ...openRequests(rec.activities).userInputs,
        ])
          this.appendActivity(rec, "info", "approval.resolved", "closed (restart)", {
            requestId,
            decision: "cancel",
          });
      }
    }
  }

  /** The member's hidden provider thread for this group thread (created on its first turn, then kept: it remembers). */
  private ensureMemberThread(group: ThreadRecord, blob: BlobProfile): ThreadRecord {
    const key = memberThreadKey(group.threadId, blob.id);
    const known = this.groupMemberThreads.get(key);
    const existing = known ? this.threads.get(known) : undefined;
    if (existing && !existing.archivedAt) return existing;
    const threadId = uuid();
    const modelSelection = this.modelPickOfEngine(blob.engine);
    this.createThread({
      threadId,
      projectId: blob.id,
      title: `${group.title} · ${blob.name}`.slice(0, 120),
      modelSelection,
      runtimeMode: this.blobRuntimeMode(blob),
      interactionMode: "default",
      agentMode: "swarm",
      branch: null,
      worktreePath: null,
      createdAt: nowIso(),
      origin: {
        kind: "group",
        jobId: null,
        stepId: null,
        fromThreadId: group.threadId,
        fromBlobId: null,
        groupId: group.projectId,
        groupThreadId: group.threadId,
      },
    });
    this.groupMemberThreads.set(key, threadId);
    return this.threads.get(threadId)!;
  }

  /**
   * The runtime's GroupBridge: run `req.prompt` as one turn in the member's own session and answer with what it said.
   * Rejects (never hangs) when the member cannot run, fails, or is stopped; honours `req.signal`.
   */
  public async runMemberTurn(req: KoraMemberTurnRequest): Promise<{ text: string }> {
    const group = this.threads.get(req.threadId);
    if (!group) throw new Error("That group chat is gone.");
    const blob = host().blobs?.store.get(req.blobId) ?? null;
    if (!blob || blob.archivedAt != null) throw new Error("That blob is not on the team any more.");
    if (req.signal.aborted) throw new Error("Stopped.");
    const member = this.ensureMemberThread(group, blob);
    const startIdx = member.messages.length;
    let settle: (s: ChatSessionStatus) => void = () => {};
    const settled = new Promise<ChatSessionStatus>((resolve) => {
      settle = resolve;
    });
    this.memberTaps.set(member.threadId, (e) => {
      if (e.kind === "message") req.onText?.(memberReplyText(member.messages, startIdx));
      else settle(e.status);
    });
    // Both safety timers below are REFERENCED and cleared in `finally`: they are what settles this call when the provider
    // never does, so an unref'd one let an otherwise idle process (a test file, a CLI) exit with the call still pending
    // ("Promise resolution is still pending but the event loop has already resolved": groups.test.ts on Windows).
    let abortGrace: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      void this.sessions.interrupt(member.koraThreadId).catch(() => {});
      // a provider that never answers the interrupt must not pin this call: give it a few seconds, then let go
      abortGrace = setTimeout(() => settle("interrupted"), 5_000);
    };
    req.signal.addEventListener("abort", onAbort, { once: true });
    // A completion event that never arrives must not strand the group: once the member's session is neither working nor
    // waiting on the person, the turn is over whatever the event stream said (launch QA: @all left three bubbles "thinking").
    const startedAt = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - startedAt < 20_000) return;
      const live = this.threads.get(member.threadId);
      if (!live || (!this.threadRunning(live) && !this.hasPendingRequest(live)))
        settle(live?.session?.status ?? "ready");
    }, 5_000);
    try {
      await this.startTurn({
        type: "turn.start",
        commandId: uuid(),
        threadId: member.threadId,
        message: { messageId: uuid(), role: "user", text: req.prompt, attachments: [] },
        modelSelection: member.modelSelection,
        runtimeMode: member.runtimeMode,
        interactionMode: "default",
        createdAt: nowIso(),
      } as unknown as Extract<ClientChatCommand, { type: "turn.start" }>);
      const status = await settled;
      if (req.signal.aborted || status === "interrupted") throw new Error("Stopped.");
      if (status === "error")
        throw new Error(member.session?.lastError || `${blob.name} could not answer.`);
      const text = memberReplyText(member.messages, startIdx);
      if (text) this.learnFromGroupTurn(group, blob, req, text, member);
      return { text };
    } finally {
      clearInterval(watchdog);
      if (abortGrace) clearTimeout(abortGrace);
      this.memberTaps.delete(member.threadId);
      req.signal.removeEventListener("abort", onAbort);
    }
  }

  /** A member learns from a group turn in ITS OWN memory: the person's words and its reply (never the other members' side). */
  private learnFromGroupTurn(
    group: ThreadRecord,
    blob: BlobProfile,
    req: KoraMemberTurnRequest,
    reply: string,
    member: ThreadRecord,
  ): void {
    const blobs = host().blobs;
    const trigger = group.messages[req.triggerSeq - 1];
    // only what the PERSON said is learned from; a teammate's hand-over is not the user talking
    if (!blobs || !trigger || trigger.role !== "user") return;
    const assistantId = member.messages.at(-1)?.id ?? uuid();
    if (this.memoryHooked.has(assistantId)) return;
    this.memoryHooked.add(assistantId);
    void Promise.resolve()
      .then(() =>
        blobs.afterTurn({
          blobId: blob.id,
          threadId: group.threadId,
          messageIds: { user: trigger.id, assistant: assistantId },
          userText: trigger.text,
          assistantText: reply,
          at: Date.now(),
        }),
      )
      .catch((cause) => {
        host().log(
          `[kora-ui] group memory hook failed for ${blob.id}: ${String((cause as Error)?.message ?? cause).slice(0, 200)}`,
        );
      });
  }

  /** A group thread's mirror of a member's approval / question card: the person answers it where they are looking. */
  private mirrorMemberRequest(rec: ThreadRecord, activity: ChatThreadActivity): void {
    if (rec.origin?.kind !== "group") return;
    const kind = String(activity.kind);
    if (
      kind !== "approval.requested" &&
      kind !== "approval.resolved" &&
      kind !== "user-input.requested" &&
      kind !== "user-input.resolved"
    )
      return;
    const group = rec.origin.groupThreadId ? this.threads.get(rec.origin.groupThreadId) : undefined;
    const payload = activity.payload as { requestId?: unknown } | null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (!group || !requestId) return;
    if (kind.endsWith("requested")) this.memberRequests.set(requestId, rec.threadId);
    else this.memberRequests.delete(requestId);
    this.appendActivity(
      group,
      activity.tone,
      kind,
      String(activity.summary),
      {
        ...(payload as Record<string, unknown>),
        authorBlobId: rec.projectId,
        memberThreadId: rec.threadId,
      },
      group.latestTurn?.turnId ?? undefined,
    );
  }

  /** One user message in a group thread: the bubble now, the routing and the replies as the orchestrator reports them. */
  private async startGroupTurn(
    rec: ThreadRecord,
    command: Extract<ClientChatCommand, { type: "turn.start" }>,
    via?: string,
  ): Promise<number> {
    const svc = this.groupsSvc();
    const group = svc?.groups.get(rec.projectId) ?? null;
    if (!svc || !group) throw new Error("That group no longer exists.");
    if (group.archivedAt != null) throw new Error(`${group.name} is archived.`);
    if (!svc.attached) throw new Error("Group chats are not ready yet. Try again in a moment.");
    const text = command.message.text;
    if (!text.trim()) return this.globalSeq;
    const createdAt = command.createdAt;
    const turnId = `group_${uuid()}`;
    this.emitMessageSent(rec, {
      messageId: command.message.messageId,
      role: "user",
      text,
      turnId: null,
      streaming: false,
      createdAt,
      ...(via ? { via } : {}),
    });
    rec.latestTurn = {
      turnId: turnId as ChatLatestTurn["turnId"],
      state: "running",
      requestedAt: createdAt as ChatLatestTurn["requestedAt"],
      startedAt: createdAt as ChatLatestTurn["startedAt"],
      completedAt: null,
      assistantMessageId: null,
    };
    this.groupRuns.set(rec.threadId, (this.groupRuns.get(rec.threadId) ?? 0) + 1);
    this.setSession(rec, "running", turnId, null);
    void this.runGroupMessage(rec, svc, group, command.message.messageId, text);
    return this.globalSeq;
  }

  private async runGroupMessage(
    rec: ThreadRecord,
    svc: NonNullable<ReturnType<ChatEngine["groupsSvc"]>>,
    group: KoraGroupJson,
    userMessageId: string,
    text: string,
  ): Promise<void> {
    let failure: string | null = null;
    try {
      await svc.send({
        groupId: group.id,
        threadId: rec.threadId,
        transcript: this.groupTranscript(rec, userMessageId),
        text,
      });
    } catch (cause) {
      failure = String((cause as Error)?.message ?? cause).slice(0, 300);
      host().log(`[kora-ui] group ${group.id}: ${failure}`);
    } finally {
      const left = (this.groupRuns.get(rec.threadId) ?? 1) - 1;
      if (left > 0) this.groupRuns.set(rec.threadId, left);
      else this.groupRuns.delete(rec.threadId);
      const live = this.threads.get(rec.threadId);
      if (live) {
        if (failure)
          this.emitMessageSent(live, {
            messageId: `msg_n_${uuid()}`,
            role: "system",
            text: `That did not go through: ${failure}`,
            turnId: null,
            streaming: false,
            createdAt: nowIso(),
            kind: "note",
          });
        if (left === 0) {
          this.sealLiveRows(live);
          if (live.latestTurn)
            live.latestTurn = {
              ...live.latestTurn,
              state: "completed",
              completedAt: nowIso() as ChatLatestTurn["completedAt"],
            };
          this.setSession(live, "ready", null, null);
        }
      }
    }
  }

  /** The thread's messages as the orchestrator's shared transcript (see groupThread.ts). */
  private groupTranscript(rec: ThreadRecord, userMessageId: string) {
    const nameOf = (id: string) => host().blobs?.store.get(id)?.name ?? "Former member";
    const asGroupMessage = (
      id: string,
      fallback: Omit<GroupMessageLike, "id" | "seq" | "ts">,
    ): KoraGroupMessage => {
      const idx = rec.messages.findIndex((m) => m.id === id);
      const m = rec.messages[idx];
      return {
        ...fallback,
        id,
        seq: idx >= 0 ? idx + 1 : rec.messages.length,
        ts: m ? Date.parse(m.createdAt) || Date.now() : Date.now(),
      };
    };
    return {
      list: (): KoraGroupMessage[] => groupMessagesOf(rec.messages, nameOf),
      append: (m: {
        authorId: string;
        authorName: string;
        text: string;
        to: string[];
        kind: "message" | "note";
        ts?: number;
      }): KoraGroupMessage => {
        if (m.kind === "note") {
          const id = `msg_n_${uuid()}`;
          this.emitMessageSent(rec, {
            messageId: id,
            role: "system",
            text: m.text,
            turnId: null,
            streaming: false,
            createdAt: nowIso(),
            kind: "note",
          });
          return asGroupMessage(id, {
            authorId: "system",
            authorName: "Kora",
            text: m.text,
            to: [],
            kind: "note",
          });
        }
        if (m.authorId === "user")
          return asGroupMessage(userMessageId, {
            authorId: "user",
            authorName: "You",
            text: m.text,
            to: m.to,
            kind: "message",
          });
        const id = this.sealMemberRow(rec, m.authorId, m.text, m.to);
        return asGroupMessage(id, {
          authorId: m.authorId,
          authorName: m.authorName,
          text: m.text,
          to: m.to,
          kind: "message",
        });
      },
    };
  }

  /** The member's reply is final: top up the streamed bubble to the full text and close it (or make the bubble if none streamed). */
  private sealMemberRow(
    rec: ThreadRecord,
    blobId: string,
    text: string,
    to: readonly string[],
  ): string {
    const key = memberThreadKey(rec.threadId, blobId);
    const live = this.liveMemberRows.get(key);
    this.liveMemberRows.delete(key);
    // A member's reply carries no turn id: several members answer one message at once, and the transcript folds replies that
    // share a turn into one (only the last would show).
    const turnId = null;
    if (!live) {
      const id = `msg_g_${uuid()}`;
      this.emitMessageSent(rec, {
        messageId: id,
        role: "assistant",
        text,
        turnId,
        streaming: false,
        createdAt: nowIso(),
        authorBlobId: blobId,
        ...(to.length ? { to } : {}),
      });
      return id;
    }
    const msg = rec.messages.find((m) => m.id === live.id);
    const shown = msg?.text ?? live.text;
    const rest = text.startsWith(shown) ? text.slice(shown.length) : "";
    this.emitMessageSent(rec, {
      messageId: live.id,
      role: "assistant",
      text: rest,
      turnId,
      streaming: false,
      createdAt: msg?.createdAt ?? nowIso(),
      authorBlobId: blobId,
      ...(to.length ? { to } : {}),
    });
    return live.id;
  }

  /** Close every reply bubble that is still streaming (a stopped run, a timeout, an error). */
  private sealLiveRows(rec: ThreadRecord): void {
    for (const [key, live] of [...this.liveMemberRows]) {
      if (!key.startsWith(`${rec.threadId}\u0000`)) continue;
      this.liveMemberRows.delete(key);
      const msg = rec.messages.find((m) => m.id === live.id);
      if (!msg || !msg.streaming) continue;
      this.emitMessageSent(rec, {
        messageId: live.id,
        role: "assistant",
        text: "",
        turnId: null,
        streaming: false,
        createdAt: msg.createdAt,
      });
    }
  }

  /** The orchestrator's progress as transcript rows: routing label, a streaming bubble per member, notes for what went wrong. */
  private onGroupEvent(e: KoraGroupEvent): void {
    const rec = this.threads.get(e.threadId);
    if (!rec) return;
    const key = "blobId" in e ? memberThreadKey(rec.threadId, e.blobId) : "";
    const nameOf = (id: string) => host().blobs?.store.get(id)?.name ?? "A member";
    const note = (text: string) =>
      this.emitMessageSent(rec, {
        messageId: `msg_n_${uuid()}`,
        role: "system",
        text,
        turnId: null,
        streaming: false,
        createdAt: nowIso(),
        kind: "note",
      });
    switch (e.type) {
      case "routed": {
        const msg = rec.messages[e.messageSeq - 1];
        if (!msg) return;
        // the bubble is already on screen; now it learns who it went to and why
        this.emitMessageSent(rec, {
          messageId: msg.id,
          role: "user",
          text: "",
          turnId: null,
          streaming: false,
          createdAt: msg.createdAt,
          to: e.recipients,
          routeWhy:
            e.decision.reason === "auto-fallback" && e.decision.detail
              ? `auto-fallback:${e.decision.detail}`
              : e.decision.reason === "auto" && e.decision.detail === "keyword"
                ? "auto:keyword"
                : e.decision.reason,
        });
        return;
      }
      case "turn-start": {
        const id = `msg_g_${uuid()}`;
        this.liveMemberRows.set(key, { id, text: "" });
        this.emitMessageSent(rec, {
          messageId: id,
          role: "assistant",
          text: "",
          turnId: null,
          streaming: true,
          createdAt: nowIso(),
          authorBlobId: e.blobId,
        });
        this.pushThreadShell(rec);
        return;
      }
      case "turn-delta": {
        const live = this.liveMemberRows.get(key);
        if (!live || !e.text.startsWith(live.text) || e.text.length === live.text.length) return;
        const delta = e.text.slice(live.text.length);
        live.text = e.text;
        this.emitMessageSent(rec, {
          messageId: live.id,
          role: "assistant",
          text: delta,
          turnId: null,
          streaming: true,
          createdAt: rec.messages.find((m) => m.id === live.id)?.createdAt ?? nowIso(),
          authorBlobId: e.blobId,
        });
        return;
      }
      case "turn-timeout":
      case "turn-aborted":
      case "turn-empty":
      case "turn-error": {
        // whatever the member had streamed stays; the bubble closes. A bubble with nothing in it says why instead of
        // standing there empty (a stop is the person's own decision: that one just goes away, the client hides it).
        const live = this.liveMemberRows.get(key);
        if (live) {
          this.liveMemberRows.delete(key);
          const msg = rec.messages.find((m) => m.id === live.id);
          const bare = !msg?.text.trim();
          const why =
            e.type === "turn-timeout"
              ? "No answer in time."
              : e.type === "turn-empty"
                ? "Nothing to add."
                : e.type === "turn-error"
                  ? "Could not answer."
                  : "";
          if (msg?.streaming)
            this.emitMessageSent(rec, {
              messageId: live.id,
              role: "assistant",
              text: bare ? why : "",
              turnId: null,
              streaming: false,
              createdAt: msg.createdAt,
              authorBlobId: e.blobId,
            });
        }
        // a stop is the person's own decision: no note (the typing bubble just goes away)
        if (e.type === "turn-error")
          note(`${nameOf(e.blobId)} could not answer: ${friendlyMemberError(e.error)}`);
        return;
      }
      default:
        return;
    }
  }

  /** Post a message into a group (outside access `send_to_group`): the group's newest thread, or a fresh one. */
  private async groupSendFromOutside(i: {
    groupId: string;
    text: string;
    via: { client: string; tokenId: string };
  }): Promise<{ ok: boolean; message?: string }> {
    const group = this.groupOfProject(i.groupId);
    if (!group) return { ok: false, message: "That group does not exist." };
    if (group.archivedAt != null) return { ok: false, message: `${group.name} is archived.` };
    let rec = [...this.threads.values()]
      .filter((t) => t.projectId === group.id && !t.archivedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!rec) {
      const threadId = uuid();
      this.createThread({
        threadId,
        projectId: group.id,
        title: i.text.trim().slice(0, 60) || group.name,
        modelSelection: this.defaultModelSelectionFor(group.id),
        runtimeMode: "approval-required",
        interactionMode: "default",
        agentMode: "chat",
        branch: null,
        worktreePath: null,
        createdAt: nowIso(),
      });
      rec = this.threads.get(threadId);
    }
    if (!rec) return { ok: false, message: "Kora could not open that group." };
    try {
      await this.startGroupTurn(
        rec,
        {
          type: "turn.start",
          commandId: uuid(),
          threadId: rec.threadId,
          message: { messageId: uuid(), role: "user", text: i.text, attachments: [] },
          createdAt: nowIso(),
        } as unknown as Extract<ClientChatCommand, { type: "turn.start" }>,
        i.via.client,
      );
      return { ok: true };
    } catch (cause) {
      return { ok: false, message: String((cause as Error)?.message ?? cause) };
    }
  }

  // ── Blobs outside access (docs/bots/OUTSIDE.md): the read side and the "send a message" side `kora mcp --team` may use ────
  private outsideVisible(rec: ThreadRecord): boolean {
    return (
      this.isBlobProject(rec.projectId) &&
      !this.isGroupThread(rec) &&
      !rec.archivedAt &&
      rec.origin?.kind !== "routine" &&
      rec.origin?.kind !== "group"
    );
  }

  private outsideHead(rec: ThreadRecord) {
    const status = this.hasPendingRequest(rec)
      ? ("needs-you" as const)
      : this.threadRunning(rec)
        ? ("running" as const)
        : rec.session?.status === "error"
          ? ("error" as const)
          : ("settled" as const);
    return {
      id: rec.threadId,
      blobId: rec.projectId,
      title: rec.title,
      status,
      updatedAt: Date.parse(rec.updatedAt) || 0,
      messageCount: rec.messages.filter((m) => !m.notice).length,
    };
  }

  /** What `OutsideHost` reads and does through this engine. */
  public outsideEngine(): KoraOutsideEngine {
    return {
      threads: (blobId) =>
        [...this.threads.values()]
          .filter((r) => r.projectId === blobId && this.outsideVisible(r))
          .map((r) => this.outsideHead(r))
          .sort((a, b) => b.updatedAt - a.updatedAt),
      thread: (threadId) => {
        const rec = this.threads.get(threadId);
        return rec && this.outsideVisible(rec) ? this.outsideHead(rec) : null;
      },
      rows: (threadId) => {
        const rec = this.threads.get(threadId);
        if (!rec || !this.outsideVisible(rec)) return [];
        const blob = host().blobs?.store.get(rec.projectId) ?? null;
        return outsideRowsOf({
          messages: rec.messages,
          activities: rec.activities,
          workspace:
            blob?.workspace ?? this.projects.get(rec.projectId)?.project.workspaceRoot ?? rec.cwd,
        }) as unknown as Array<Record<string, unknown>>;
      },
      blobState: (blobId) => {
        let working = false;
        for (const r of this.threads.values()) {
          if (r.projectId !== blobId || !this.outsideVisible(r)) continue;
          if (this.hasPendingRequest(r)) return "needs-you";
          if (this.threadRunning(r)) working = true;
        }
        return working ? "working" : "idle";
      },
      search: (query, blobIds, limit) => {
        const q = query.trim().toLowerCase();
        const ids = new Set(blobIds);
        const hits: ReturnType<KoraOutsideEngine["search"]> = [];
        for (const r of this.threads.values()) {
          if (hits.length >= limit) break;
          if (!ids.has(r.projectId) || !this.outsideVisible(r)) continue;
          if (r.title.toLowerCase().includes(q)) {
            hits.push({
              kind: "thread",
              id: r.threadId,
              blobId: r.projectId,
              title: r.title,
              snippet: r.title,
            });
            continue;
          }
          const m = r.messages.find(
            (x) => !x.notice && x.role !== "system" && x.text.toLowerCase().includes(q),
          );
          if (m) {
            const at = m.text.toLowerCase().indexOf(q);
            const from = Math.max(0, at - 40);
            hits.push({
              kind: "thread",
              id: r.threadId,
              blobId: r.projectId,
              title: r.title,
              snippet: `${from > 0 ? "..." : ""}${m.text.slice(from, at + q.length + 80).replace(/\s+/g, " ")}`,
            });
          }
        }
        return hits;
      },
      models: (instanceId) => modelsOfInstance(instanceId),
      send: async (i) => {
        const text = i.text.trim();
        if (!text) return { refused: "empty" as const };
        const origin: ThreadOrigin = {
          kind: "user",
          jobId: null,
          stepId: null,
          fromThreadId: null,
          fromBlobId: null,
          via: i.via.client,
        };
        if (i.threadId) {
          const rec = this.threads.get(i.threadId);
          if (!rec || !this.outsideVisible(rec)) return { refused: "unknown" as const };
          const blob = host().blobs?.store.get(rec.projectId) ?? null;
          if (!blob) return { refused: "unknown" as const };
          if (blob.archivedAt != null) return { refused: "archived" as const };
          if (
            !this.threadRunning(rec) &&
            this.blobRunningCount(blob.id) >= BLOB_MAX_RUNNING_THREADS
          )
            return { refused: "busy" as const };
          try {
            await this.sendToBlobThread(rec.threadId, text, origin, i.via.client);
          } catch (cause) {
            return {
              refused: "busy" as const,
              message: String((cause as Error)?.message ?? cause),
            };
          }
          return { threadId: rec.threadId, blobId: blob.id };
        }
        const blobId = i.blobId ?? "";
        const r = await this.startBlobThread({
          blobId,
          title: text.replace(/\s+/g, " ").slice(0, 60),
          prompt: text,
          origin,
        });
        if ("refused" in r) return { refused: r.refused };
        return { threadId: r.threadId, blobId };
      },
      interrupt: async (threadId) => {
        const rec = this.threads.get(threadId);
        if (!rec || !this.outsideVisible(rec) || !this.threadRunning(rec)) return false;
        await this.sessions.interrupt(rec.koraThreadId);
        return true;
      },
      groupSend: (i) => this.groupSendFromOutside(i),
    };
  }

  // ── persistence (projects + per-thread projection) ───────────────────────────────────
  /** Load persisted projects + threads on boot so a restart never loses the shell/transcript. */
  private hydrate(): void {
    // A projects.json that exists but cannot be read (a crash or a full disk mid-write, a hand edit) used to read as
    // "no projects": every repo vanished from the sidebar and ensureGeneralProject() overwrote the file a moment
    // later, so nothing could be recovered. Keep the damaged file and rebuild the list from the threads below.
    let projectsDamaged = false;
    try {
      const raw = fs.readFileSync(this.projectsPath, "utf8");
      const projects = JSON.parse(raw) as unknown;
      if (!Array.isArray(projects)) throw new Error("not a list of projects");
      for (const project of projects as ChatProjectHead[]) {
        if (!project || typeof project.id !== "string" || typeof project.workspaceRoot !== "string")
          continue;
        this.projects.set(project.id, {
          project: { ...project, surface: deriveProjectSurface(project.workspaceRoot) },
        });
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        projectsDamaged = true;
        // Unparseable bytes are kept aside (an fs error such as EACCES leaves the file where it is).
        const aside = code ? null : `${this.projectsPath}.damaged-${Date.now()}`;
        if (aside) {
          try {
            fs.renameSync(this.projectsPath, aside);
          } catch {
            /* keep going: the rebuild below still restores the sidebar */
          }
        }
        console.error(
          `[kora-ui] ${this.projectsPath} could not be read (${String((err as Error)?.message ?? err).slice(0, 120)})${aside ? `; kept it as ${aside}` : ""}; rebuilt the project list from the threads`,
        );
      }
    }
    let ids: string[] = [];
    try {
      ids = fs
        .readdirSync(this.threadsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5));
    } catch {
      /* no persisted threads yet */
    }
    let maxSeq = 0;
    // Threads persisted mid-turn: the turn died with the previous daemon process, but the record still says
    // "running", so the client showed a spinner ("Sorting through it for 7h 41m") and a stop button forever.
    const interrupted: ThreadRecord[] = [];
    for (const id of ids) {
      try {
        const rec = JSON.parse(
          fs.readFileSync(path.join(this.threadsDir, `${id}.json`), "utf8"),
        ) as ThreadRecord;
        // normalise the projection (see hydrate.ts). The permission mode and graph freshness at RESUME are the
        // daemon SessionManager's (persisted on the kora thread head / ensureFresh at session start).
        const h = hydrateRecord(rec as any);
        if (h.interrupted) interrupted.push(rec);
        this.threads.set(rec.threadId, rec);
        this.koraToThread.set(rec.koraThreadId, rec.threadId);
        if (h.maxSeq > maxSeq) maxSeq = h.maxSeq;
      } catch (err) {
        // Skip a corrupt record rather than fail the whole boot — but say so, and keep the bytes aside (an fs error
        // leaves the file in place for the next boot): the conversation also lives in the chat store (KORA_HOME/chat).
        const file = path.join(this.threadsDir, `${id}.json`);
        const aside = (err as NodeJS.ErrnoException)?.code ? null : `${file}.damaged-${Date.now()}`;
        if (aside) {
          try {
            fs.renameSync(file, aside);
          } catch {
            /* leave it where it is */
          }
        }
        console.error(
          `[kora-ui] thread ${id} could not be read (${String((err as Error)?.message ?? err).slice(0, 120)})${aside ? `; kept it as ${aside}` : ""}`,
        );
      }
    }
    if (projectsDamaged) this.rebuildProjectsFromThreads();
    // Continue the sequence above anything already handed to a client, so hydrated activities keep
    // their relative order and new live events sort after them.
    this.globalSeq = maxSeq;
    for (const rec of interrupted) {
      if (rec.latestTurn?.state === "running") {
        rec.latestTurn = { ...rec.latestTurn, state: "interrupted", completedAt: nowIso() };
      }
      this.setSession(rec, "interrupted", null, "the daemon restarted while this turn was running");
      // Say so in the thread itself: a blob's chat otherwise just stops, and the roster flips to an unexplained "error".
      if (this.isBlobProject(rec.projectId))
        this.emitMessageSent(rec, {
          messageId: `msg_a_${uuid()}`,
          role: "assistant",
          text: "Kora restarted while I was working, so my answer was cut off. Send your message again and I will pick it up.",
          turnId: rec.latestTurn?.turnId ?? null,
          streaming: false,
          createdAt: nowIso(),
        });
      // Whatever the dead turn was waiting on (an approval, a question, a worker pick) can no longer be answered: close it.
      const stale = openRequests(rec.activities);
      for (const requestId of stale.approvals)
        this.appendActivity(rec, "info", "approval.resolved", "approval cancelled (restart)", {
          requestId,
          decision: "cancel",
        });
      for (const requestId of stale.userInputs)
        this.appendActivity(rec, "info", "user-input.resolved", "question closed (restart)", {
          requestId,
          answers: {},
        });
      for (const requestId of stale.pickers)
        this.appendActivity(rec, "info", "worker-picker.resolved", "workers not picked (restart)", {
          requestId,
          answer: { picks: [], cancelled: true },
        });
      // A blob (Kora, the Chief, included) just gets the cut turn closed so its next message is answered, not the old
      // task; a fleet lead elsewhere must go and look at its workers first.
      if (this.isBlobProject(rec.projectId)) {
        const lastUser = [...rec.messages].reverse().find((m) => m.role === "user" && !m.notice);
        rec.restartNote = restartClosedNote(lastUser?.text ?? null);
      } else if (isFleetAgentMode(rec.agentMode)) rec.restartNote = FLEET_RESTART_NOTE;
      // A blob's thread already says so in plain words above; the second, jargon line is for the Code surface only.
      if (!this.isBlobProject(rec.projectId))
        this.appendActivity(
          rec,
          "info",
          "restart",
          "turn interrupted by a daemon restart — send a new message to continue",
          {},
        );
    }
    if (this.projects.size > 0 || this.threads.size > 0) {
      console.log(
        `[kora-ui] hydrated ${this.projects.size} project(s), ${this.threads.size} thread(s) from ${this.dataDir}`,
      );
    }
  }

  /**
   * projects.json was unreadable: give every thread its project back. A project's folder is the cwd of its threads;
   * the title is the folder name, as "Add project" would name it; a Kora worker worktree is never taken for it.
   * Settings the file held (default model, icon) are lost; the threads and their conversations are not.
   */
  private rebuildProjectsFromThreads(): void {
    const byProject = new Map<string, ThreadRecord[]>();
    for (const rec of this.threads.values()) {
      if (!rec.projectId || this.projects.has(rec.projectId) || !rec.cwd) continue;
      byProject.set(rec.projectId, [...(byProject.get(rec.projectId) ?? []), rec]);
    }
    for (const [projectId, recs] of byProject) {
      const sorted = [...recs].sort((a, b) =>
        String(a.createdAt).localeCompare(String(b.createdAt)),
      );
      const worktrees = path.join(koraHome(), "worktrees");
      const root = (sorted.find((r) => !r.cwd.startsWith(worktrees + path.sep)) ?? sorted[0]!).cwd;
      const createdAt = sorted[0]!.createdAt || nowIso();
      this.projects.set(projectId, {
        project: {
          id: projectId as ChatProjectHead["id"],
          title: (path.basename(root) || root) as ChatProjectHead["title"],
          workspaceRoot: root as ChatProjectHead["workspaceRoot"],
          defaultModelSelection: null,
          surface: deriveProjectSurface(root),
          scripts: [],
          createdAt: createdAt as ChatProjectHead["createdAt"],
          updatedAt: nowIso() as ChatProjectHead["updatedAt"],
        },
      });
    }
    this.persistProjects();
  }

  private writeJsonAtomic(file: string, value: unknown): void {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(value));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error(
        `[kora-ui] persist failed for ${file}:`,
        String((e as Error).message).slice(0, 200),
      );
    }
  }

  private persistProjects(): void {
    this.writeJsonAtomic(
      this.projectsPath,
      [...this.projects.values()].map((p) => p.project),
    );
  }

  /** Persist a thread's projection. `currentAssistant` is transient and never written. */
  private persistThread(rec: ThreadRecord): void {
    const {
      currentAssistant: _drop,
      pendingNotes: _notes,
      attachedPanes: _attached,
      leaderLimit: _limit,
      digestNext: _digest,
      ...persistable
    } = rec;
    void _drop;
    void _notes;
    void _limit;
    void _digest;
    // A human STOP is a decision the lead must hear even if the daemon restarts first (live: the stop note was
    // still pending when the turn died, and the resumed lead respawned the stopped task). Other notes go stale.
    const stops = (rec.pendingNotes ?? []).filter((n) => n.kind === "stopped");
    this.writeJsonAtomic(
      path.join(this.threadsDir, `${rec.threadId}.json`),
      stops.length ? { ...persistable, pendingNotes: stops } : persistable,
    );
  }

  private nextSeq(): number {
    this.globalSeq += 1;
    return this.globalSeq;
  }

  // ── kora notify seam: only chat.event carries a ChatEvent; the rest are head updates ──
  private onKoraNotify(method: string, params: unknown): void {
    if (method !== "chat.event") return;
    const e = params as KoraChatEvent;
    const threadId = this.koraToThread.get(e.threadId);
    if (!threadId) return;
    const rec = this.threads.get(threadId);
    if (!rec) return;
    try {
      this.mapChatEvent(rec, e);
    } catch (err) {
      // A bad event must never tear the turn down; surface it as an error activity.
      this.appendActivity(rec, "error", "runtime", `event mapping failed: ${String(err)}`, {
        event: e,
      });
    }
  }

  // ── ChatEvent → ThreadEvent(s) ───────────────────────────────────────────────
  private mapChatEvent(rec: ThreadRecord, e: KoraChatEvent): void {
    if (rec.currentAssistant && e.type !== "content.delta" && e.type !== "thread.token-usage") {
      rec.currentAssistant.breakPending = true;
    }
    switch (e.type) {
      case "turn.started": {
        const turnId = e.turnId ?? `turn_${rec.threadId}`;
        rec.latestTurn = {
          turnId: turnId as ChatLatestTurn["turnId"],
          state: "running",
          requestedAt: nowIso(),
          startedAt: nowIso(),
          completedAt: null,
          assistantMessageId: null,
        };
        this.blobStarting.delete(rec.threadId);
        this.setSession(rec, "running", turnId, null);
        // A job step that was waiting on the user is working again the moment they answer (not only when the turn settles).
        this.pokeBlobWatchers(rec);
        return;
      }
      case "content.delta": {
        if (e.stream !== "assistant_text" || !e.delta) return; // reasoning deltas skipped in v1
        const turnId = e.turnId ?? rec.currentAssistant?.turnId ?? `turn_${rec.threadId}`;
        if (!rec.currentAssistant || rec.currentAssistant.turnId !== turnId) {
          // Globally-unique id: the kora turnId (`turn_N`) resets when the driver restarts, so
          // deriving the messageId from it alone would collide with a hydrated message on the next
          // turn of a restarted thread and merge two turns' text. A uuid is stable within the turn
          // (tracked on currentAssistant) and unique across turns/restarts.
          rec.currentAssistant = {
            messageId: `msg_a_${uuid()}`,
            text: "",
            turnId,
            createdAt: nowIso(),
            lastItemId: e.itemId,
          };
        }
        // Narrow once into a local: TS can't carry the null-check on `rec.currentAssistant`
        // (a mutable property) across the statements below.
        const current = rec.currentAssistant;
        // A new itemId mid-turn means the driver started a fresh assistant-text block (usually
        // after a tool call). The client concatenates deltas verbatim (thread.message-sent,
        // streaming:true), so without a separator here two blocks run together with no
        // whitespace ("…blocking them.The free swarm…"). Insert a paragraph break, but only once
        // per block boundary and only when the running text doesn't already end in whitespace.
        const isNewBlock =
          current.breakPending === true ||
          (e.itemId !== undefined &&
            current.lastItemId !== undefined &&
            e.itemId !== current.lastItemId);
        current.breakPending = false;
        const needsSeparator = isNewBlock && !/\s$/.test(current.text);
        const delta = needsSeparator ? `\n\n${e.delta}` : e.delta;
        current.text += delta;
        if (e.itemId !== undefined) current.lastItemId = e.itemId;
        this.emitMessageSent(rec, {
          messageId: current.messageId,
          role: "assistant",
          text: delta,
          turnId,
          streaming: true,
          createdAt: current.createdAt,
        });
        return;
      }
      case "plan.proposed": {
        this.proposePlan(
          rec,
          e.markdown ?? "",
          e.turnId ?? rec.currentAssistant?.turnId ?? rec.latestTurn?.turnId ?? null,
        );
        return;
      }
      case "turn.settled": {
        const turnId =
          e.turnId ?? rec.currentAssistant?.turnId ?? rec.session?.activeTurnId ?? null;
        // A plan-mode turn of a harness without a plan tool (Codex, OpenCode, Antigravity): its final answer is the plan.
        if (
          rec.interactionMode === "plan" &&
          e.state === "completed" &&
          rec.providerDriver !== "claude" &&
          rec.currentAssistant &&
          rec.planProposedTurnId !== rec.currentAssistant.turnId &&
          looksLikePlan(rec.currentAssistant.text)
        ) {
          this.proposePlan(rec, rec.currentAssistant.text, rec.currentAssistant.turnId);
        }
        // Seal the streaming assistant message (empty delta, streaming:false).
        if (rec.currentAssistant && (turnId === null || rec.currentAssistant.turnId === turnId)) {
          this.emitMessageSent(rec, {
            messageId: rec.currentAssistant.messageId,
            role: "assistant",
            text: "",
            turnId: rec.currentAssistant.turnId,
            streaming: false,
            createdAt: rec.currentAssistant.createdAt,
          });
          if (rec.latestTurn) {
            rec.latestTurn = {
              ...rec.latestTurn,
              assistantMessageId: rec.currentAssistant
                .messageId as ChatLatestTurn["assistantMessageId"],
            };
          }
          rec.currentAssistant = null;
        }
        const usage = (e as { usage?: TurnUsageLike }).usage;
        if (usage && usage.usageStatus !== "unavailable") {
          const count = (n: unknown) =>
            typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
          const prev = rec.leaderUsage ?? { input: 0, cached: 0, output: 0, turns: 0 };
          rec.leaderUsage = {
            input: prev.input + count(usage.inputTokens),
            cached: prev.cached + count(usage.cachedInputTokens),
            output: prev.output + count(usage.outputTokens),
            turns: prev.turns + 1,
          };
          if (rec.agentMode === "swarm") this.fleet.refresh(rec.threadId);
        }
        const status = settleStatus(e.state);
        if (status !== "interrupted") usageLimits().onTurnSettled(rec.providerDriver);
        if (rec.latestTurn) {
          rec.latestTurn = {
            ...rec.latestTurn,
            state:
              status === "error" ? "error" : status === "interrupted" ? "interrupted" : "completed",
            completedAt: nowIso(),
          };
        }
        this.blobStarting.delete(rec.threadId);
        this.setSession(rec, status, null, e.errorMessage ?? null);
        // Blobs: settle listeners (Phase 2 jobs) and the once-per-turn memory hook.
        this.onBlobTurnSettled(rec, status);
        // A mode notice (a flip made mid-turn — also out of swarm into chat) or worker notes that arrived mid-turn go
        // out now, as ONE next turn. flushPending is a no-op when there is nothing to send.
        const t = setTimeout(() => this.flushPending(rec), 400);
        t.unref();
        return;
      }
      case "usage.rate-limit": {
        // Every thread: the provider's usage view learns it is refusing turns until `resetsAt` (Settings → Usage, the
        // composer's limit banner). Codex/Claude also send usage.limits for it; this one carries the human text.
        const provider = usageAgentOf(rec.providerDriver);
        if (provider) {
          usageLimits().apply(
            provider,
            {
              provider,
              windows: [],
              limited: true,
              ...(typeof e.resetsAt === "number"
                ? { resetsAt: e.resetsAt < 1e12 ? e.resetsAt * 1000 : e.resetsAt }
                : {}),
            },
            typeof e.message === "string" ? e.message : undefined,
          );
        }
        // Blobs: offer to carry on with a free model (blobs.thread.continueOnFree) — one card per reset time.
        this.appendRateLimitCard(rec, e.resetsAt);
        // X4 applies to a leader of workers; a plain chat has nobody working on while the leader waits.
        if (!isFleetAgentMode(rec.agentMode)) return;
        this.markLeaderLimited(rec, e.resetsAt, e.message);
        return;
      }
      case "blob.card": {
        // A card the blob runtime emitted (job / proposal / self-change receipt): one `blob.card` activity row.
        const card = (e as { card?: unknown }).card;
        if (card && typeof card === "object") this.appendBlobCard(rec, card as BlobCardPayload);
        return;
      }
      case "turn.stuck": {
        // The turn is repeating itself: one quiet line in the turn it belongs to; the Stop button is the user's call.
        this.appendActivity(
          rec,
          "info",
          "runtime_warning",
          e.message ?? "This turn looks stuck.",
          {},
          e.turnId,
        );
        return;
      }
      case "model.auto": {
        // Auto model (runtime session/auto-model.ts): say once what the thread runs on and why; the picker overrides it.
        const ev = e as { model?: string; reason?: string; escalated?: boolean };
        const name = (slug: string | undefined) =>
          slug === "default" || !slug
            ? `your Default (${prettyClaudeId(claudeResolvedModels.get("default") ?? null) ?? "Sonnet"})`
            : (prettyClaudeId(slug) ?? slug);
        const why = ev.reason ? ` (${ev.reason})` : "";
        const sonnet = /sonnet/i.test(ev.model ?? "");
        const price = sonnet
          ? "about half of Opus's price per token"
          : "about 1/20 of Sonnet's price per token";
        const text = ev.escalated
          ? `Auto moved this thread up to ${name(ev.model)}${sonnet ? " (high effort)" : ""}${why}.`
          : `Auto runs this thread on ${name(ev.model)}${sonnet ? " at high effort" : ""}${why}: ${price}. Pick a model to override.`;
        this.appendActivity(rec, "info", "runtime_warning", text, {});
        return;
      }
      case "model.switch-cost": {
        const ev = e as {
          contextTokens?: number;
          cacheWarm?: boolean;
          usd?: number | null;
          turns?: number;
        };
        const tokens = typeof ev.contextTokens === "number" ? ev.contextTokens : 0;
        if (!ev.cacheWarm || tokens < 20_000) return; // a cold or tiny context loses nothing worth a line
        const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
        const cost =
          typeof ev.usd === "number" && ev.usd >= 0.01 ? ` (about $${ev.usd.toFixed(2)})` : "";
        const turns =
          typeof ev.turns === "number" && ev.turns >= 2
            ? `, about what ${Math.round(ev.turns)} ordinary messages cost`
            : "";
        this.appendActivity(
          rec,
          "info",
          "runtime_warning",
          `Switching models re-cached about ${k(tokens)} tokens${cost}${turns}. A new thread starts cheaper than switching a long one.`,
          {},
        );
        return;
      }
      case "context.trimmed": {
        // A cold resume (cache expired) continued from a copy with the old tool outputs elided: the same quiet divider row as
        // a compaction, saying what was trimmed.
        const ev = e as { stubbed?: number; tokensSaved?: number; contextBefore?: number };
        const stubbed = typeof ev.stubbed === "number" ? ev.stubbed : 0;
        const saved = typeof ev.tokensSaved === "number" ? ev.tokensSaved : 0;
        const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
        this.appendActivity(
          rec,
          "info",
          "context-compaction",
          `Trimmed ${stubbed} old tool output${stubbed === 1 ? "" : "s"} on resume · about ${k(saved)} tokens`,
          {
            trigger: "auto",
            preTokens: typeof ev.contextBefore === "number" ? ev.contextBefore : null,
            postTokens:
              typeof ev.contextBefore === "number" ? Math.max(0, ev.contextBefore - saved) : null,
          },
        );
        return;
      }
      case "context.compacted": {
        // The one visible trace of `/compact` (or an automatic compaction): the user's "/compact" bubble otherwise
        // gets no answer at all.
        const ev = e as { trigger?: string; preTokens?: number; postTokens?: number };
        const k = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`);
        const sizes =
          typeof ev.preTokens === "number" && typeof ev.postTokens === "number"
            ? ` · ${k(ev.preTokens)} → ${k(ev.postTokens)} tokens of conversation`
            : typeof ev.preTokens === "number"
              ? ` · from ${k(ev.preTokens)} tokens`
              : "";
        this.appendActivity(
          rec,
          "info",
          // The timeline draws this kind as its divider row ("── ⤡ Context compacted ──").
          "context-compaction",
          `${ev.trigger === "auto" ? "Context compacted automatically" : "Context compacted"}${sizes}`,
          {
            trigger: ev.trigger === "auto" ? "auto" : "manual",
            preTokens: typeof ev.preTokens === "number" ? ev.preTokens : null,
            postTokens: typeof ev.postTokens === "number" ? ev.postTokens : null,
          },
          e.turnId,
        );
        return;
      }
      case "usage.limits": {
        const report = (e as { report?: KoraUsageLimitsReport }).report;
        const provider = usageAgentOf(report?.provider);
        if (report && provider && Array.isArray(report.windows))
          usageLimits().apply(provider, report);
        return;
      }
      case "tool.started": {
        this.appendActivity(
          rec,
          "tool",
          e.toolKind ?? "tool",
          e.title ?? e.toolName ?? "tool",
          {
            itemId: e.itemId,
            toolName: e.toolName,
            input: e.input,
          },
          e.turnId,
        );
        return;
      }
      case "tool.result": {
        this.appendActivity(
          rec,
          "tool",
          "tool_result",
          `tool ${e.status ?? "done"}`,
          {
            itemId: e.itemId,
            status: e.status,
            output: e.output,
            changedFiles: e.changedFiles,
            ...(e.bounded &&
            typeof e.bounded.path === "string" &&
            Number.isFinite(e.bounded.offset) &&
            Number.isFinite(e.bounded.limit) &&
            Number.isFinite(e.bounded.total)
              ? {
                  bounded: {
                    path: e.bounded.path,
                    offset: e.bounded.offset,
                    limit: e.bounded.limit,
                    total: e.bounded.total,
                  },
                }
              : {}),
          },
          e.turnId,
        );
        return;
      }
      case "approval.opened": {
        // The client answers via dispatchCommand(thread.approval.respond); requestId rides the payload.
        this.appendActivity(
          rec,
          "approval",
          "approval.requested",
          e.title ?? "Approval required",
          {
            requestId: e.requestId,
            // `requestKind` must be a AgentRequestKind for the banner to classify it;
            // kora speaks the native request type, so send both.
            requestKind: AGENT_REQUEST_KINDS[String(e.requestKind)] ?? "command",
            requestType: e.requestKind,
            options: e.options,
            args: e.args,
            detail: e.detail,
            ...(e.toolName ? { toolName: e.toolName } : {}),
            ...(e.alwaysLabel ? { alwaysLabel: e.alwaysLabel } : {}),
            ...(e.linkTarget ? { linkTarget: e.linkTarget } : {}),
            // A blob's request shows as a card in the transcript (not the composer strip): where it runs and for whom.
            ...(this.isBlobProject(rec.projectId)
              ? { blobThread: true, blobId: rec.projectId, cwd: rec.cwd }
              : {}),
            // A connected-app action asking before it sends / posts: name the app on the approval card.
            ...appApprovalFields(e.args),
          },
          e.turnId,
        );
        this.pokeBlobWatchers(rec);
        this.emitBlobAttention(rec, this.isBlobProject(rec.projectId) ? "needs-you" : null);
        return;
      }
      case "approval.resolved": {
        this.appendActivity(
          rec,
          "info",
          "approval.resolved",
          `approval ${e.decision ?? ""}`.trim(),
          {
            requestId: e.requestId,
            decision: e.decision,
          },
        );
        this.pokeBlobWatchers(rec);
        return;
      }
      case "user-input.requested": {
        // The client answers via dispatchCommand(thread.user-input.respond). `responseMode`
        // stays off "message" so the panel treats it as blocking: the provider is parked on
        // this reply and cannot be dismissed away.
        this.appendActivity(
          rec,
          "approval",
          "user-input.requested",
          "Question",
          {
            requestId: e.requestId,
            questions: e.questions,
            responseMode: "callback",
          },
          e.turnId,
        );
        this.pokeBlobWatchers(rec);
        this.emitBlobAttention(rec, this.isBlobProject(rec.projectId) ? "needs-you" : null);
        return;
      }
      case "worker-picker.requested": {
        // The lead's proposed workers; the client shows the picker and answers through thread.user-input.respond
        // ({ picks, autoApprove? } or a dismiss = declined).
        this.appendActivity(
          rec,
          "approval",
          "worker-picker.requested",
          "Pick the workers",
          { requestId: e.requestId, picks: e.picks, catalog: e.catalog },
          e.turnId,
        );
        return;
      }
      case "worker-picker.resolved": {
        this.appendActivity(rec, "info", "worker-picker.resolved", "workers picked", {
          requestId: e.requestId,
          answer: e.answer,
        });
        return;
      }
      case "user-input.resolved": {
        this.appendActivity(rec, "info", "user-input.resolved", "question answered", {
          requestId: e.requestId,
          answers: e.answers,
        });
        this.pokeBlobWatchers(rec);
        return;
      }
      case "turn.plan": {
        this.appendActivity(
          rec,
          "info",
          "plan",
          "plan updated",
          {
            plan: e.plan,
            explanation: e.explanation,
          },
          e.turnId,
        );
        return;
      }
      case "graph.query": {
        this.appendActivity(
          rec,
          "info",
          "graph_query",
          e.summary ?? `graph ${e.op ?? ""}`.trim(),
          {
            op: e.op,
            subject: e.subject,
          },
          e.turnId,
        );
        return;
      }
      case "graph.result": {
        this.appendActivity(
          rec,
          "info",
          "graph_result",
          "graph result",
          { view: e.view },
          e.turnId,
        );
        return;
      }
      case "context.blast-radius": {
        this.appendActivity(rec, "info", "blast_radius", e.subject ?? "blast radius", {
          subject: e.subject,
        });
        return;
      }
      // Pure telemetry — every turn fires this, and it never carried anything a user acts on.
      // Dropped rather than displayed: the client also hides any already-persisted "usage"
      // activity from older threads (session-logic.ts), so this stops it at the source instead
      // of just hiding what's already there.
      case "thread.token-usage": {
        // Surfaced ONLY as the hidden `context-window.updated` activity the web's context meter and the swarm
        // activity chip read (session-logic hides it from the timeline). Measured context size + the provider's own
        // running cost estimate (Claude) — never a savings figure.
        const u = (e as { usage?: KoraTokenUsage }).usage;
        if (!u || !Number.isFinite(u.usedTokens)) return;
        const n = (v: unknown) =>
          typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
        const int = (v: unknown) => {
          const x = n(v);
          return x === null ? null : Math.round(x);
        };
        this.appendActivity(
          rec,
          "info",
          "context-window.updated",
          "context window",
          {
            usedTokens: Math.round(u.usedTokens),
            maxTokens: int(u.maxTokens),
            inputTokens: int(u.inputTokens),
            cachedInputTokens: int(u.cachedInputTokens),
            outputTokens: int(u.outputTokens),
            totalProcessedTokens: int(u.totalProcessedTokens),
            autoCompactThreshold: int(u.autoCompactThreshold),
            compactsAutomatically:
              typeof u.compactsAutomatically === "boolean" ? u.compactsAutomatically : null,
            costUsd: n(u.costUsd),
            source: u.source === "provider" || u.source === "estimate" ? u.source : null,
          },
          e.turnId,
        );
        return;
      }
      case "worker.attached": {
        if (e.paneId && this.markAttached(rec, e.paneId)) return; // the runtime's notify already produced the row
        this.appendActivity(
          rec,
          "info",
          e.type,
          `spawned ${e.paneId} · ${e.workerAgent ?? "worker"} · ${e.title ?? ""}`.trim(),
          {
            paneId: e.paneId,
            agent: e.workerAgent ?? null,
            title: e.title ?? null,
            account: (e as { account?: string | null }).account ?? null,
          },
          e.turnId,
        );
        return;
      }
      case "worker.status": {
        // Per-flip status is live in the fleet panel; the transcript only records blocked/done (see onWorkerEvent).
        return;
      }
      case "worker.detached": {
        this.appendActivity(
          rec,
          "info",
          e.type,
          `${e.paneId} stopped${e.reason ? ` — ${e.reason}` : ""}`,
          { paneId: e.paneId, reason: e.reason ?? null },
          e.turnId,
        );
        return;
      }
      case "runtime.error": {
        // ONE place says why (see failTurnReply): a reply, not a work-log row AND a banner repeating it.
        const shown = this.failTurnReply(rec, e.message ?? "runtime error", e.turnId ?? null);
        this.setSession(rec, "error", rec.session?.activeTurnId ?? null, shown);
        return;
      }
      case "runtime.warning": {
        // In the turn it belongs to (a "can't reach Claude, retrying" line sits with the turn that is waiting).
        this.appendActivity(rec, "info", "runtime_warning", e.message ?? "warning", {}, e.turnId);
        return;
      }
      case "thread.started":
      case "session.started":
        // Capture the Claude Agent SDK session id so we can locate the transcript for savings.
        if (e.providerThreadId) rec.koraSessionId = e.providerThreadId;
        return;
      default:
        return; // session.state / session.exited: no ThreadEvent needed
    }
  }

  // ── event emission + projection ─────────────────────────────────────────────────────
  private emitEvent(rec: ThreadRecord, event: ThreadEvent): void {
    this.applyProjection(rec, event);
    rec.updatedAt = nowIso();
    // Blobs groups: a member's own thread feeds the group's streaming bubble.
    if (event.type === "threadMessageSent" && event.payload.role === "assistant")
      this.memberTaps.get(rec.threadId)?.({ kind: "message" });
    const item: ThreadStreamItem = { kind: "event", event };
    const listeners = this.threadListeners.get(rec.threadId);
    if (listeners) for (const l of listeners) l(item);
    // Persist the projection on every event EXCEPT streaming assistant deltas: those are frequent
    // and superseded by the final seal (streaming:false), which carries the complete text and is
    // persisted. A crash mid-stream loses only an incomplete assistant message, never a settled one.
    const isStreamingDelta =
      event.type === "threadMessageSent" &&
      event.payload.role === "assistant" &&
      event.payload.streaming === true;
    if (!isStreamingDelta) this.persistThread(rec);
  }

  private base(rec: ThreadRecord): {
    sequence: number;
    eventId: ThreadEvent["eventId"];
    aggregateKind: "thread";
    aggregateId: ThreadEvent["aggregateId"];
    occurredAt: string;
    commandId: null;
    causationEventId: null;
    correlationId: null;
    metadata: Record<string, never>;
  } {
    return {
      sequence: this.nextSeq(),
      eventId: uuid() as ThreadEvent["eventId"],
      aggregateKind: "thread",
      aggregateId: rec.threadId as ThreadEvent["aggregateId"],
      occurredAt: nowIso(),
      metadata: {},
      correlationId: null,
      causationEventId: null,
      commandId: null,
    };
  }

  private emitMessageSent(
    rec: ThreadRecord,
    m: {
      messageId: string;
      role: "user" | "assistant" | "system";
      text: string;
      turnId: string | null;
      streaming: boolean;
      createdAt: string;
      /** A Kora-authored turn (mode notice / fleet notes): rendered as a muted row, never a user bubble. */
      notice?: ThreadMessageNotice;
      /** The records behind the user's inline context chips, so the bubble can render them. */
      context?: ThreadMessageContext;
      /** Stored attachment metadata only — never a dataUrl or a filesystem path. */
      attachments?: MessageAttachment[];
      /** Blobs groups / outside access (see ThreadMessage). */
      authorBlobId?: string;
      to?: readonly string[];
      routeWhy?: string;
      kind?: "note";
      via?: string;
    },
  ): void {
    this.emitEvent(rec, {
      ...this.base(rec),
      type: "threadMessageSent",
      payload: {
        threadId: rec.threadId as ThreadEvent["aggregateId"],
        messageId: m.messageId as ThreadMessage["id"],
        role: m.role,
        text: m.text,
        turnId: (m.turnId as ThreadMessage["turnId"]) ?? null,
        streaming: m.streaming,
        createdAt: m.createdAt,
        updatedAt: nowIso(),
        // JSON-clean (no undefined leaf): the key is present only with a notice.
        ...(m.notice ? { notice: toJsonValue(m.notice) as ThreadMessageNotice } : {}),
        ...(m.context ? { context: toJsonValue(m.context) as ThreadMessageContext } : {}),
        ...(m.attachments && m.attachments.length > 0
          ? { attachments: toJsonValue(m.attachments) as MessageAttachment[] }
          : {}),
        ...(m.authorBlobId ? { authorBlobId: m.authorBlobId } : {}),
        ...(m.to ? { to: [...m.to] } : {}),
        ...(m.routeWhy ? { routeWhy: m.routeWhy } : {}),
        ...(m.kind ? { kind: m.kind } : {}),
        ...(m.via ? { via: m.via } : {}),
      },
    } as ThreadEvent);
  }

  /**
   * A failed turn says why in ONE place: a reply at the end of the turn, the way Claude Code answers its own API
   * errors. The client shows that reply once — calm copy, Retry, Details — and its banner stands down for it
   * (apps/web util/agentErrorCopy `inlineAgentErrorMessageId`). Before, a failure the daemon reported (folder gone,
   * spawn failed, a Codex error) showed as a banner AND one or two "Turn failed: …" rows. Returns the text now shown,
   * which must be the session's lastError for the client to match it. Not repeated when the latest reply already says it.
   */
  private failTurnReply(rec: ThreadRecord, message: string, turnId: string | null): string {
    const text = message.trim() || "The turn failed.";
    const last = [...rec.messages]
      .reverse()
      .find((m) => m.role === "user" || m.role === "assistant");
    if (last?.role === "assistant" && !last.streaming) {
      const said = last.text.trim();
      if (said === text || said.endsWith(text)) return said;
    }
    this.emitMessageSent(rec, {
      messageId: `msg_a_${uuid()}`,
      role: "assistant",
      text,
      turnId,
      streaming: false,
      createdAt: nowIso(),
    });
    return text;
  }

  private setSession(
    rec: ThreadRecord,
    status: ChatSessionStatus,
    activeTurnId: string | null,
    lastError: string | null,
  ): void {
    const session: ChatSession = {
      threadId: rec.threadId as ChatSession["threadId"],
      status,
      // Must equal the advertised provider's DRIVER kind (see config.ts `providers`), not the kora
      // agent name: for a started thread the web client derives its locked provider from
      // `session.providerName` (`deriveThreadAgentLock`) and filters the provider picker to entries
      // whose `driver` matches. A mismatch leaves zero compatible entries and disables the composer.
      providerName: rec.providerDriver as ChatSession["providerName"],
      runtimeMode: rec.runtimeMode,
      activeTurnId: (activeTurnId as ChatSession["activeTurnId"]) ?? null,
      lastError: (lastError as ChatSession["lastError"]) ?? null,
      updatedAt: nowIso(),
    };
    this.emitEvent(rec, {
      ...this.base(rec),
      type: "threadSessionSet",
      payload: { threadId: rec.threadId as ChatSession["threadId"], session },
    } as ThreadEvent);
    this.pushThreadShell(rec);
    // A group member's turn that failed before it could settle (the provider would not start): the group stops waiting for it.
    if (status === "error") this.memberTaps.get(rec.threadId)?.({ kind: "settled", status });
  }

  private appendActivity(
    rec: ThreadRecord,
    tone: ChatThreadActivity["tone"],
    kind: string,
    summary: string,
    payload: unknown,
    turnId?: string,
  ): void {
    const seqBase = this.base(rec);
    // A blob's helpers show up as one quiet row ("Popo used 2 helpers"), never as worker / swarm rows: mark them for the client.
    if (
      kind.startsWith("worker.") &&
      this.isBlobProject(rec.projectId) &&
      payload &&
      typeof payload === "object"
    ) {
      payload = { ...(payload as Record<string, unknown>), blobThread: true };
    }
    const activity: ChatThreadActivity = {
      id: seqBase.eventId,
      tone,
      kind: (kind && kind.trim().length > 0 ? kind : "info") as ChatThreadActivity["kind"],
      summary: (summary && summary.trim().length > 0
        ? summary
        : kind) as ChatThreadActivity["summary"],
      // JSON-sanitize: an `undefined` leaf here dies the wire codec and tears the stream.
      payload: toJsonValue(payload),
      turnId: (turnId as ChatThreadActivity["turnId"]) ?? null,
      sequence: seqBase.sequence,
      createdAt: nowIso(),
    };
    this.emitEvent(rec, {
      ...seqBase,
      type: "threadActivityAppended",
      payload: { threadId: rec.threadId as ThreadEvent["aggregateId"], activity },
    } as ThreadEvent);
    this.mirrorMemberRequest(rec, activity);
    // A request opening or closing changes the head's pending flags: tell the sidebar now, not at the next turn event.
    if (REQUEST_OPENED_KINDS.has(activity.kind) || REQUEST_RESOLVED_KINDS.has(activity.kind))
      this.pushThreadShell(rec);
  }

  private applyProjection(rec: ThreadRecord, event: ThreadEvent): void {
    switch (event.type) {
      case "threadMessageSent": {
        const p = event.payload;
        const existing = rec.messages.find((msg) => msg.id === p.messageId);
        if (existing) {
          // Same messageId → concatenate streamed deltas (the projector's contract).
          const merged: ThreadMessage = {
            ...existing,
            text: existing.text + p.text,
            streaming: p.streaming,
            updatedAt: p.updatedAt,
            // a later frame can add who a message went to (routing is decided after the bubble is shown)
            ...(p.to ? { to: p.to } : {}),
            ...(p.routeWhy ? { routeWhy: p.routeWhy } : {}),
          };
          rec.messages = rec.messages.map((msg) => (msg.id === p.messageId ? merged : msg));
        } else {
          rec.messages.push({
            id: p.messageId,
            role: p.role,
            text: p.text,
            turnId: p.turnId,
            streaming: p.streaming,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            ...(p.notice ? { notice: p.notice } : {}),
            ...(p.context ? { context: p.context } : {}),
            ...(p.attachments ? { attachments: p.attachments } : {}),
            ...(p.authorBlobId ? { authorBlobId: p.authorBlobId } : {}),
            ...(p.to ? { to: p.to } : {}),
            ...(p.routeWhy ? { routeWhy: p.routeWhy } : {}),
            ...(p.kind ? { kind: p.kind } : {}),
            ...(p.via ? { via: p.via } : {}),
          });
        }
        if (p.role === "user") rec.latestUserMessageAt = p.createdAt;
        return;
      }
      case "threadSessionSet":
        rec.session = event.payload.session;
        return;
      case "threadAgentModeSet":
        rec.agentMode = event.payload.agentMode;
        return;
      case "threadRuntimeModeSet":
        rec.runtimeMode = event.payload.runtimeMode;
        return;
      case "threadInteractionModeSet":
        rec.interactionMode = event.payload.interactionMode;
        return;
      case "threadActivityAppended": {
        const activity = event.payload.activity;
        // The meter reads only the latest reading, and a busy turn sends dozens: keep one row (the newest), or the
        // persisted thread grows by a row per API message forever.
        if (activity.kind === "context-window.updated") {
          rec.activities = rec.activities.filter((a) => a.kind !== "context-window.updated");
        }
        rec.activities.push(activity);
        return;
      }
      default:
        return;
    }
  }

  // ── shell projection ────────────────────────────────────────────────────────────────
  private buildThreadShell(rec: ThreadRecord): ChatThreadHead {
    return {
      id: rec.threadId as ChatThreadHead["id"],
      projectId: rec.projectId as ChatThreadHead["projectId"],
      title: rec.title as ChatThreadHead["title"],
      modelSelection: rec.modelSelection,
      runtimeMode: rec.runtimeMode,
      interactionMode: rec.interactionMode,
      agentMode: rec.agentMode,
      branch: rec.branch as ChatThreadHead["branch"],
      worktreePath: rec.worktreePath as ChatThreadHead["worktreePath"],
      pullRequests: [],
      latestTurn: rec.latestTurn,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      archivedAt: rec.archivedAt ?? null,
      settledOverride: null,
      settledAt: null,
      ...(rec.origin ? { origin: rec.origin } : {}),
      ...(rec.origin?.kind === "routine" || rec.origin?.kind === "group" ? { hidden: true } : {}),
      session: rec.session,
      latestUserMessageAt: rec.latestUserMessageAt as ChatThreadHead["latestUserMessageAt"],
      hasActionableProposedPlan: rec.proposedPlans?.at(-1)?.implementedAt === null,
      // The sidebar's "Needs your approval" dot reads these two (ThreadNav.logic.ts).
      ...(() => {
        const open = this.openRequests(rec);
        return { hasPendingUserInput: open.userInput > 0, hasPendingApprovals: open.approvals > 0 };
      })(),
    };
  }

  private buildThreadDetail(rec: ThreadRecord): ChatThreadDetailSnapshot {
    const thread: ChatThread = {
      id: rec.threadId as ChatThread["id"],
      projectId: rec.projectId as ChatThread["projectId"],
      title: rec.title as ChatThread["title"],
      modelSelection: rec.modelSelection,
      runtimeMode: rec.runtimeMode,
      interactionMode: rec.interactionMode,
      agentMode: rec.agentMode,
      branch: rec.branch as ChatThread["branch"],
      worktreePath: rec.worktreePath as ChatThread["worktreePath"],
      pullRequests: [],
      latestTurn: rec.latestTurn,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      archivedAt: rec.archivedAt ?? null,
      settledOverride: null,
      settledAt: null,
      ...(rec.origin ? { origin: rec.origin } : {}),
      ...(rec.origin?.kind === "routine" || rec.origin?.kind === "group" ? { hidden: true } : {}),
      deletedAt: null,
      messages: rec.messages,
      proposedPlans: rec.proposedPlans ?? [],
      activities: rec.activities,
      checkpoints: [],
      session: rec.session,
    };
    return guardEncode(
      ChatThreadDetailSnapshotSchema,
      { seq: this.globalSeq, thread },
      `thread detail ${rec.threadId}`,
    );
  }

  private proposePlan(rec: ThreadRecord, markdown: string, turnId: string | null): void {
    const planMarkdown = markdown.trim();
    if (!planMarkdown) return;
    const at = nowIso();
    const plan = {
      id: uuid(),
      turnId,
      planMarkdown,
      implementedAt: null,
      implementationThreadId: null,
      createdAt: at,
      updatedAt: at,
    } as ChatPlanProposal;
    rec.proposedPlans = [...(rec.proposedPlans ?? []), plan].slice(-20);
    rec.planProposedTurnId = turnId;
    this.emitEvent(rec, {
      ...this.base(rec),
      type: "proposedPlanUpserted",
      payload: {
        threadId: rec.threadId as ThreadEvent["aggregateId"],
        proposedPlan: toJsonValue(plan),
      },
    } as ThreadEvent);
    this.pushThreadShell(rec);
  }

  /** The plan a turn implements is marked implemented (the card leaves; the plan stays in the thread). */
  private markPlanImplemented(
    source: { threadId: string; planId: string } | undefined,
    implementationThreadId: string,
  ): void {
    const rec = source && this.threads.get(source.threadId);
    const plan = rec?.proposedPlans?.find((p) => p.id === source!.planId);
    if (!rec || !plan || plan.implementedAt) return;
    const at = nowIso();
    const done = {
      ...plan,
      implementedAt: at,
      implementationThreadId,
      updatedAt: at,
    } as ChatPlanProposal;
    rec.proposedPlans = rec.proposedPlans!.map((p) => (p.id === plan.id ? done : p));
    this.emitEvent(rec, {
      ...this.base(rec),
      type: "proposedPlanUpserted",
      payload: {
        threadId: rec.threadId as ThreadEvent["aggregateId"],
        proposedPlan: toJsonValue(done),
      },
    } as ThreadEvent);
    this.pushThreadShell(rec);
  }

  private pushThreadShell(rec: ThreadRecord): void {
    const item: ThreadIndexItem = {
      kind: "thread-upserted",
      sequence: this.nextSeq(),
      thread: this.buildThreadShell(rec),
    };
    for (const l of this.shellListeners) l(item);
  }

  private pushProjectShell(proj: ProjectRecord): void {
    const item: ThreadIndexItem = {
      kind: "project-upserted",
      sequence: this.nextSeq(),
      project: proj.project,
    };
    for (const l of this.shellListeners) l(item);
  }

  private shellSnapshot(): ThreadIndexSnapshot {
    return guardEncode(
      ThreadIndexSnapshotSchema,
      {
        seq: this.globalSeq,
        projects: [...this.projects.values()].map((p) => p.project),
        threads: [...this.threads.values()]
          .filter((r) => !r.archivedAt)
          .map((r) => this.buildThreadShell(r)),
        updatedAt: nowIso(),
      },
      "shell snapshot",
    );
  }

  /** getArchivedShellSnapshot: the archived threads (and their projects), same shape as the shell snapshot. */
  archivedShellSnapshot(): ThreadIndexSnapshot {
    const threads = [...this.threads.values()].filter((r) => !!r.archivedAt);
    const projectIds = new Set(threads.map((r) => r.projectId));
    return guardEncode(
      ThreadIndexSnapshotSchema,
      {
        seq: this.globalSeq,
        projects: [...this.projects.values()]
          .map((p) => p.project)
          .filter((p) => projectIds.has(p.id)),
        threads: threads.map((r) => this.buildThreadShell(r)),
        updatedAt: nowIso(),
      },
      "archived shell snapshot",
    );
  }

  // ── command handling ────────────────────────────────────────────────────────────────
  async dispatch(command: ClientChatCommand): Promise<number> {
    // A thread id names files under Kora's home: refuse a malformed one up front, as the clean "Invalid thread id."
    // the client shows, for every command (not only thread.create). Ids already in the store stay addressable.
    const threadId = (command as { threadId?: unknown }).threadId;
    if (
      threadId !== undefined &&
      (typeof threadId !== "string" ||
        (!SAFE_THREAD_ID.test(threadId) && !this.threads.has(threadId)))
    )
      throw new Error("Invalid thread id.");
    switch (command.type) {
      case "createProject": {
        assertProjectFolder(command.workspaceRoot, command.createWorkspaceRootIfMissing === true);
        const workspaceRoot = command.workspaceRoot;
        const project: ChatProjectHead = {
          id: command.projectId,
          title: command.title,
          workspaceRoot,
          defaultModelSelection: null,
          surface: deriveProjectSurface(workspaceRoot),
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        };
        const rec: ProjectRecord = { project };
        this.projects.set(command.projectId, rec);
        this.persistProjects();
        this.pushProjectShell(rec);
        return this.globalSeq;
      }
      case "createThread": {
        // A blob's thread starts in its profile's posture (Ask / Auto / Full resolved for its engine), whatever the
        // composer's default said; the user can still change it afterwards.
        this.createThread({
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: this.initialRuntimeMode(
            command.projectId,
            command.modelSelection.instanceId,
            command.runtimeMode,
          ),
          interactionMode: command.interactionMode,
          agentMode: command.agentMode ?? "chat",
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
        });
        return this.globalSeq;
      }
      case "setThreadAgentMode": {
        const rec = this.threads.get(command.threadId);
        if (!rec) return this.globalSeq;
        // A blob's threads have no Chat|Orchestrator|Swarm toggle (the Helpers switch is on the blob): guard server-side
        // too (a stale tab, an old client) rather than let a blob thread change mode.
        if (isBlobsCwd(rec.cwd)) return this.globalSeq;
        await this.setAgentMode(rec, command.agentMode);
        return this.globalSeq;
      }
      case "setThreadRuntimeMode": {
        const rec = this.threads.get(command.threadId);
        if (!rec) return this.globalSeq;
        // A blob thread: this is the user's own choice in its permission menu - remember it, so the blob's profile no
        // longer decides this thread (and a profile change does not undo it).
        if (this.isBlobProject(rec.projectId)) {
          rec.runtimeModeSetByUser = true;
          this.persistThread(rec);
        }
        // Always re-assert the mode, even when the record already agrees: the session manager can
        // have lost it (daemon restart) while this record still says full-access, and the old
        // `!==` guard then made re-picking the same mode a no-op with no way to heal from the UI.
        this.sessions.setPermissionMode(rec.koraThreadId, toPermissionMode(command.runtimeMode));
        if (rec.runtimeMode !== command.runtimeMode) {
          rec.runtimeMode = command.runtimeMode;
          this.emitEvent(rec, {
            ...this.base(rec),
            type: "threadRuntimeModeSet",
            payload: {
              threadId: rec.threadId as ThreadEvent["aggregateId"],
              runtimeMode: command.runtimeMode,
              updatedAt: nowIso(),
            },
          } as ThreadEvent);
          this.pushThreadShell(rec);
        }
        return this.globalSeq;
      }
      case "setThreadInteractionMode": {
        const rec = this.threads.get(command.threadId);
        if (!rec) return this.globalSeq;
        if (rec.interactionMode !== command.interactionMode) {
          rec.interactionMode = command.interactionMode;
          this.emitEvent(rec, {
            ...this.base(rec),
            type: "threadInteractionModeSet",
            payload: {
              threadId: rec.threadId as ThreadEvent["aggregateId"],
              interactionMode: command.interactionMode,
              updatedAt: nowIso(),
            },
          } as ThreadEvent);
          this.pushThreadShell(rec);
        }
        return this.globalSeq;
      }
      case "turn.start": {
        // bootstrap can create the thread (and its worktree) in the same command.
        if (!this.threads.has(command.threadId) && command.bootstrap?.createThread) {
          const c = command.bootstrap.createThread;
          this.createThread({
            threadId: command.threadId,
            projectId: c.projectId,
            title: c.title,
            modelSelection: c.modelSelection,
            runtimeMode: this.initialRuntimeMode(
              c.projectId,
              c.modelSelection.instanceId,
              c.runtimeMode,
            ),
            interactionMode: c.interactionMode,
            agentMode: c.agentMode ?? "chat",
            branch: c.branch,
            worktreePath: c.worktreePath,
            createdAt: c.createdAt,
          });
        }
        return await this.startTurn(command);
      }
      case "turn.interrupt": {
        const rec = this.threads.get(command.threadId);
        // Blobs groups: Stop in a group thread ends every member turn of that thread (and no other thread's).
        if (rec && this.isGroupThread(rec)) {
          this.groupsSvc()?.stop(rec.threadId);
          return this.globalSeq;
        }
        if (rec) this.stopSwarmOnInterrupt(rec);
        if (rec) await this.sessions.interrupt(rec.koraThreadId, command.turnId);
        return this.globalSeq;
      }
      case "user-input.respond": {
        const rec = this.requestOwner(command.threadId, command.requestId);
        if (rec)
          await this.sessions.respondUserInput(
            rec.koraThreadId,
            command.requestId,
            command.answers,
          );
        return this.globalSeq;
      }
      case "user-input.dismiss": {
        // The provider is parked on the reply, so a dismiss still has to answer it —
        // an empty answer set releases the turn instead of stranding it.
        const rec = this.requestOwner(command.threadId, command.requestId);
        if (rec) await this.sessions.respondUserInput(rec.koraThreadId, command.requestId, {});
        return this.globalSeq;
      }
      case "approval.respond": {
        const rec = this.requestOwner(command.threadId, command.requestId);
        if (rec)
          await this.sessions.respondApproval(
            rec.koraThreadId,
            command.requestId,
            command.decision,
          );
        return this.globalSeq;
      }
      case "deleteThread": {
        this.deleteThread(command.threadId);
        return this.globalSeq;
      }
      case "updateThreadMeta": {
        // Rename (the sidebar's "Rename" and the composer's title edit). Was an accepted no-op: the new title
        // showed until the next snapshot, then the old one came back. The composer's model / effort change rides
        // here too (before the next turn) — it was dropped, so the picker said Sonnet while Haiku kept answering.
        const rec = this.threads.get(command.threadId);
        if (rec && command.modelSelection)
          await this.applyModelSelection(rec, command.modelSelection);
        if (!rec || command.title === undefined || command.title === rec.title)
          return this.globalSeq;
        rec.title = command.title;
        this.emitEvent(rec, {
          ...this.base(rec),
          type: "threadMetaUpdated",
          payload: {
            threadId: rec.threadId as ThreadEvent["aggregateId"],
            title: command.title,
            updatedAt: nowIso(),
          },
        } as ThreadEvent);
        this.pushThreadShell(rec);
        return this.globalSeq;
      }
      case "archiveThread":
      case "unarchiveThread": {
        const rec = this.threads.get(command.threadId);
        if (!rec) return this.globalSeq;
        const archive = command.type === "archiveThread";
        if (!!rec.archivedAt === archive) return this.globalSeq;
        const at = nowIso();
        rec.archivedAt = archive ? at : null;
        this.emitEvent(rec, {
          ...this.base(rec),
          type: archive ? "threadArchived" : "threadUnarchived",
          payload: {
            threadId: rec.threadId as ThreadEvent["aggregateId"],
            ...(archive ? { archivedAt: at } : {}),
            updatedAt: at,
          },
        } as ThreadEvent);
        this.pushThreadShell(rec); // archivedAt on the head: clients drop it from the sidebar / bring it back
        // The runtime's chat store kept archived:false, so `kora` and anything reading its index listed it as active.
        try {
          if (archive) this.sessions.archive?.(rec.koraThreadId);
          else this.sessions.unarchive?.(rec.koraThreadId);
          // An archived thread keeps no process: the Claude session (~200 MB) and the dock shell stayed alive until
          // Delete (aud1 S3-4). Its workers are left to finish; unarchiving resumes the session on the next turn.
          if (archive) {
            void this.sessions.stop?.(rec.koraThreadId)?.catch(() => {
              /* already stopped */
            });
            this.fleet.close(rec.threadId, undefined);
          }
        } catch (cause) {
          host().log(`[kora-ui] archive mirror failed for ${rec.koraThreadId}: ${String(cause)}`);
        }
        return this.globalSeq;
      }
      case "deleteProject": {
        // Was an accepted no-op: the sidebar's delete looked like it worked and the project came back on the
        // next boot. Delete the project's threads (killing any workers they still own), then the project.
        this.deleteProject(command.projectId);
        return this.globalSeq;
      }
      case "updateProjectMeta": {
        // Was an accepted no-op: a rename or a new icon looked saved and was gone after a reload. The project's name
        // and icon persist here; a blob's project mirrors its profile (rename the blob instead), so it is refused.
        const proj = this.projects.get(command.projectId);
        if (!proj) throw new Error(`no such project: ${command.projectId}`);
        if (proj.project.surface === "blobs")
          throw new Error("rename an assistant from its own settings");
        const patch: { -readonly [K in keyof ChatProjectHead]?: ChatProjectHead[K] } = {};
        if (command.title !== undefined && command.title.trim() !== proj.project.title)
          patch.title = command.title.trim() as ChatProjectHead["title"];
        if (command.projectIcon !== undefined) patch.projectIcon = command.projectIcon;
        if (command.faviconPath !== undefined) patch.faviconPath = command.faviconPath;
        if (Object.keys(patch).length === 0) return this.globalSeq;
        proj.project = {
          ...proj.project,
          ...patch,
          updatedAt: nowIso() as ChatProjectHead["updatedAt"],
        };
        this.persistProjects();
        this.pushProjectShell(proj);
        return this.globalSeq;
      }
      default:
        // thread.pin/settle/snooze, etc.: accepted no-ops for the chat-turn slice. They advance the cursor without
        // emitting events.
        return this.globalSeq;
    }
  }

  /** Delete a project's threads (killing any workers they still own), then the project, for every client. */
  private deleteProject(projectId: string): void {
    for (const rec of [...this.threads.values()])
      if (rec.projectId === projectId) this.deleteThread(rec.threadId);
    const removed = this.projects.get(projectId)?.project;
    if (this.projects.delete(projectId)) {
      // Kora's CLAUDE.md/AGENTS.md block, hooks and folder trust in the repo go with the project (aud1 S2-2). Skipped
      // when another project still uses the same folder, and for a blob's assistant folder (no repo footprint).
      const root = removed?.workspaceRoot;
      if (
        root &&
        removed?.surface !== "blobs" &&
        ![...this.projects.values()].some((p) => p.project.workspaceRoot === root)
      ) {
        host()
          .removeRepoFootprint?.(root)
          ?.then(
            (r) =>
              host().log(
                `[kora-ui] removed project ${projectId}: ${r.removed.length} Kora entr${r.removed.length === 1 ? "y" : "ies"} cleaned in ${r.root}${r.trustRevoked ? ", folder trust revoked" : ""}`,
              ),
            (cause) => host().log(`[kora-ui] repo cleanup failed for ${root}: ${String(cause)}`),
          );
      }
      this.persistProjects();
      try {
        dropProjectPrefs(projectId);
      } catch (cause) {
        host().log(
          `[kora-ui] could not drop settings of removed project ${projectId}: ${String(cause)}`,
        );
      }
      const item: ThreadIndexItem = {
        kind: "project-removed",
        sequence: this.nextSeq(),
        projectId: projectId as ChatProjectHead["id"],
      };
      for (const l of this.shellListeners) l(item);
    }
  }

  /** Remove a thread everywhere: its workers (if it was an orchestrator), its chat-store session, the in-memory
   *  record and maps, the persisted file, and every client's sidebar (a `thread-removed` shell item). */
  private deleteThread(threadId: string): void {
    const rec = this.threads.get(threadId);
    if (!rec) return;
    const orchestratorId = `chat:${rec.koraThreadId}`;
    const runtime = this.runtime as unknown as KoraRuntimeLike & {
      killPane?: (id: string) => void;
    };
    for (const p of runtime.panes.values()) {
      if (p.orchestratorId === orchestratorId && !p.exited) {
        try {
          runtime.killPane?.(p.id);
        } catch {
          /* already gone */
        }
      }
    }
    // The runtime's chat store holds the thread's event log; without this it outlived the UI's delete.
    void this.sessions.delete(rec.koraThreadId).catch(() => {
      /* already gone */
    });
    // Blobs groups: a group thread takes its members' hidden sessions with it; a member's session forgets its link.
    for (const [key, memberId] of [...this.groupMemberThreads]) {
      if (key.startsWith(`${threadId}\u0000`)) {
        this.groupMemberThreads.delete(key);
        this.deleteThread(memberId);
      } else if (memberId === threadId) this.groupMemberThreads.delete(key);
    }
    this.threads.delete(threadId);
    this.koraToThread.delete(rec.koraThreadId);
    this.threadListeners.delete(threadId);
    try {
      fs.unlinkSync(path.join(this.threadsDir, `${threadId}.json`));
    } catch {
      /* not persisted yet */
    }
    const item: ThreadIndexItem = {
      kind: "thread-removed",
      sequence: this.nextSeq(),
      threadId: threadId as ChatThreadHead["id"],
    };
    for (const l of this.shellListeners) l(item);
  }

  private createThread(input: {
    threadId: string;
    projectId: string;
    title: string;
    modelSelection: ModelPick;
    runtimeMode: ChatThread["runtimeMode"];
    interactionMode: ChatThread["interactionMode"];
    agentMode: ChatThread["agentMode"];
    branch: string | null;
    worktreePath: string | null;
    createdAt: string;
    /** Blobs: delegated / routine / continued threads say where they came from. */
    origin?: ThreadOrigin | null;
    seedMessageId?: string;
  }): void {
    if (this.threads.has(input.threadId)) return;
    // The id names files: `<threads>/<id>.json` (written, and unlinked on delete) and `<attachments>/<id>/…`. The wire
    // schema only says "non-blank", so a client-chosen `../../x` would write and delete outside Kora's home.
    if (!SAFE_THREAD_ID.test(input.threadId)) throw new Error("Invalid thread id.");
    const cwd =
      input.worktreePath ??
      this.projects.get(input.projectId)?.project.workspaceRoot ??
      os.homedir();
    const route = routeAgent(input.modelSelection.instanceId);
    // A blob's thread is always swarm (its quiet helpers; the blob's Helpers switch decides whether the tools are wired) -
    // the client never shows the Chat|Orchestrator|Swarm toggle there, but a stale draft or an old client could still
    // send something else.
    const requestedAgentMode: ChatThread["agentMode"] = isBlobsCwd(cwd) ? "swarm" : input.agentMode;
    // Swarm and Orchestrator need a leader with the fleet bridge; a draft remembered in either mode on a driver with
    // none starts as chat. A blob takes any leader.
    const noBridge = !isBlobsCwd(cwd) && !FLEET_BRIDGE_DRIVERS.has(route.driver);
    const agentMode: ChatThread["agentMode"] =
      noBridge && requestedAgentMode !== "chat" ? "chat" : requestedAgentMode;
    const account = accountOf(input.modelSelection.instanceId);
    const koraThread = this.sessions.create({
      agent: route.koraAgent,
      ...(account ? { account } : {}),
      cwd,
      model: { model: input.modelSelection.model, effort: effortOf(input.modelSelection) },
      title: input.title,
      isOrchestrator: isFleetAgentMode(agentMode),
      agentMode,
    });
    this.sessions.setPermissionMode(koraThread.id, toPermissionMode(input.runtimeMode));
    const rec: ThreadRecord = {
      threadId: input.threadId,
      koraThreadId: koraThread.id,
      worktreePath: input.worktreePath,
      branch: input.branch,
      agentMode,
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modelSelection: input.modelSelection,
      title: input.title,
      cwd,
      projectId: input.projectId,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      messages: [],
      activities: [],
      session: null,
      latestTurn: null,
      latestUserMessageAt: null,
      currentAssistant: null,
      koraSessionId: null,
      providerDriver: route.driver,
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.seedMessageId ? { seedMessageId: input.seedMessageId } : {}),
    };
    this.threads.set(input.threadId, rec);
    this.koraToThread.set(koraThread.id, input.threadId);
    this.persistThread(rec);
    noteSkillCwd(rec.cwd, rec.providerDriver);
    this.pushThreadShell(rec);
    if (noBridge && requestedAgentMode !== "chat")
      this.appendActivity(
        rec,
        "error",
        "runtime_error",
        `${requestedAgentMode === "swarm" ? "Swarm" : "Orchestrator"} isn't available for this model yet — this thread started as a plain chat.`,
        { agentMode: requestedAgentMode, providerDriver: route.driver },
      );
  }

  /**
   * The composer's Chat | Orchestrator | Swarm toggle. The runtime persists the mode and the notice; here the
   * divider (`agent-mode.switched`) lands at once, even mid-turn, and flushPending delivers the notice when the
   * thread is idle (or it rides on the next user turn). Leaving swarm for chat stops the swarm workers in the
   * runtime (decision D-a: the web asks first; "keep them" dispatches orchestrator instead).
   */
  /**
   * The composer's model / effort for an existing thread. The provider is fixed when the thread starts (a Claude or
   * a Codex process), so a selection from another provider is ignored; anything else is stored, announced to
   * clients and handed to the session, which restarts before its next turn when the effort changed.
   */
  private async applyModelSelection(rec: ThreadRecord, next: ModelPick): Promise<void> {
    const cur = rec.modelSelection;
    if (
      cur.instanceId === next.instanceId &&
      cur.model === next.model &&
      effortOf(cur) === effortOf(next)
    )
      return;
    if (routeAgent(next.instanceId).driver !== rec.providerDriver) return;
    rec.modelSelection = next;
    try {
      await this.sessions.changeModel(rec.koraThreadId, {
        model: next.model,
        ...(effortOf(next) ? { effort: effortOf(next) as string } : {}),
      });
    } catch (err) {
      this.appendActivity(rec, "error", "runtime_error", `model switch failed: ${String(err)}`, {
        model: next.model,
        error: String(err),
      });
    }
    this.emitEvent(rec, {
      ...this.base(rec),
      type: "threadMetaUpdated",
      payload: {
        threadId: rec.threadId as ThreadEvent["aggregateId"],
        modelSelection: next,
        updatedAt: nowIso(),
      },
    } as ThreadEvent);
    this.pushThreadShell(rec);
  }

  private async setAgentMode(rec: ThreadRecord, mode: ChatThread["agentMode"]): Promise<void> {
    if (rec.agentMode === mode) return;
    const from = rec.agentMode;
    if (mode !== "chat" && !FLEET_BRIDGE_DRIVERS.has(rec.providerDriver ?? "")) {
      this.appendActivity(
        rec,
        "error",
        "runtime_error",
        `${mode === "swarm" ? "Swarm" : "Orchestrator"} isn't available for this model yet — pick a Claude, Codex or OpenCode model to use it.`,
        { agentMode: mode, providerDriver: rec.providerDriver },
      );
      return;
    }
    try {
      await this.sessions.setAgentMode(rec.koraThreadId, mode);
    } catch (err) {
      this.appendActivity(rec, "error", "runtime_error", `mode switch failed: ${String(err)}`, {
        agentMode: mode,
        error: String(err),
      });
      return;
    }
    this.emitEvent(rec, {
      ...this.base(rec),
      type: "threadAgentModeSet",
      payload: {
        threadId: rec.threadId as ThreadEvent["aggregateId"],
        agentMode: mode,
        updatedAt: nowIso(),
      },
    } as ThreadEvent);
    this.appendActivity(
      rec,
      "info",
      "agent-mode.switched",
      mode === "swarm"
        ? "Stretch on"
        : from === "swarm"
          ? "Stretch off"
          : `Switched from ${from} to ${mode}`,
      { from, to: mode },
      rec.session?.activeTurnId ?? undefined,
    );
    this.pushThreadShell(rec);
    this.flushPending(rec);
  }

  /**
   * Write every freshly-uploaded attachment (one with a `dataUrl`) to
   * `<KORA_HOME>/attachments/<threadId>/<id>/<sanitized name>` (plus a `meta.json` sidecar for the HTTP
   * route) and resolve every already-stored one (no `dataUrl`: a retried/edited message re-sending a prior
   * attachment) to the same path by id. Returns both the persisted metadata for the bubble and the
   * absolute-path shape the session drivers take.
   */
  private async resolveAttachments(
    threadId: string,
    attachments: ReadonlyArray<{
      type: string;
      id?: string | undefined;
      sizeBytes: number;
      mimeType: string;
      name: string;
      dataUrl?: string | undefined;
    }>,
  ): Promise<{ stored: MessageAttachment[]; runtime: RuntimeAttachment[] }> {
    const stored: MessageAttachment[] = [];
    const runtime: RuntimeAttachment[] = [];
    for (const a of attachments) {
      const safeName = sanitizeAttachmentName(a.name);
      if (a.dataUrl) {
        const id = a.id && ATTACHMENT_ID_PATTERN.test(a.id) ? a.id : NodeCrypto.randomUUID();
        const dir = path.join(this.attachmentsDir, threadId, id);
        const filePath = path.join(dir, safeName);
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(filePath, decodeDataUrl(a.dataUrl));
        await fs.promises.writeFile(
          path.join(dir, "meta.json"),
          JSON.stringify({ name: a.name, mimeType: a.mimeType }),
        );
        stored.push({
          type: a.type,
          id,
          name: a.name,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
        } as MessageAttachment);
        if (a.type === "image" || a.type === "file") {
          runtime.push({ type: a.type, path: filePath, mimeType: a.mimeType, name: a.name });
        }
      } else {
        // Already stored (no dataUrl): resolve by id — the file was written on an earlier turn. An id
        // that is not a safe path segment can only be forged, never one this engine wrote: skip it.
        const id = a.id ?? "";
        if (!ATTACHMENT_ID_PATTERN.test(id)) continue;
        const filePath = path.join(this.attachmentsDir, threadId, id, safeName);
        stored.push({
          type: a.type,
          id,
          name: a.name,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
        } as MessageAttachment);
        if (a.type === "image" || a.type === "file") {
          runtime.push({ type: a.type, path: filePath, mimeType: a.mimeType, name: a.name });
        }
      }
    }
    return { stored, runtime };
  }

  private async startTurn(
    command: Extract<ClientChatCommand, { type: "turn.start" }>,
  ): Promise<number> {
    const rec = this.threads.get(command.threadId);
    if (!rec) throw new Error(`unknown thread ${command.threadId}`);
    // Blobs groups: a group thread's message fans out to its members' own sessions (never to a provider session of its own).
    if (this.isGroupThread(rec)) return await this.startGroupTurn(rec, command);
    // The command's own runtimeMode is never read (the thread's is authoritative); a blob thread the user has not
    // changed by hand also picks up its blob's current posture, which heals threads that predate it.
    this.followBlobPosture(rec);
    // Blobs: a blob runs at most three threads at once. Refused up front (a toast with the reason) so nothing is
    // half-started and the draft stays in the composer.
    this.assertBlobCanRun(rec);
    const createdAt = command.createdAt;
    const text = command.message.text;
    const context = command.message.context;
    // The composer sends chips as inline links plus their records (terminal lines, file comments, browser
    // picks). The agent needs the payloads, not just the link labels: expand them into the prompt.
    const promptText =
      context && context.records.length > 0
        ? projectContextChipForAgent({ text, records: context.records })
        : text;
    // Decode/store uploads (or resolve already-stored ones) BEFORE anything else: a turn must never go out
    // missing the media its bubble claims to carry. A failure here surfaces exactly like a failed sendTurn
    // (error activity + session error) and the turn never starts.
    let attachments: { stored: MessageAttachment[]; runtime: RuntimeAttachment[] };
    try {
      attachments = await this.resolveAttachments(rec.threadId, command.message.attachments);
    } catch (err) {
      this.appendActivity(rec, "error", "runtime_error", `attachment failed: ${String(err)}`, {
        error: String(err),
      });
      this.blobStarting.delete(rec.threadId);
      this.setSession(rec, "error", null, String(err));
      return this.globalSeq;
    }
    // Claude/Codex both need some prompt text to act on; an attachments-only turn gets a stand-in FOR THE
    // AGENT ONLY — the bubble (below) always shows the user's real (possibly empty) text.
    const agentText = rewriteSkillMentions(
      !promptText.trim() && attachments.runtime.length > 0
        ? "See the attached file(s)."
        : promptText,
      rec.providerDriver,
      skillsFor(rec.providerDriver, rec.cwd),
    );
    noteSkillCwd(rec.cwd, rec.providerDriver);
    // 0) a mode notice the agent has not heard rides on this turn, ahead of the prompt — for the agent only: the
    //    bubble shows the user's text (the divider was appended at toggle time). Taken BEFORE the bubble so a
    //    flushPending racing the settle can never send it a second time.
    const notice = this.takeNotice(rec);
    const restart = [this.takeRestartNote(rec), this.takeStopNote(rec)]
      .filter((t): t is string => !!t)
      .join("\n\n");
    const koraNotice = [notice?.text, restart].filter((t): t is string => !!t).join("\n\n");
    // Outside access: a message that came in through `kora mcp --team` says which client sent it.
    const via =
      (command.message as { via?: string }).via ??
      this.viaByMessage.get(command.message.messageId) ??
      (rec.messages.length === 0 ? (rec.origin?.via ?? undefined) : undefined);
    this.viaByMessage.delete(command.message.messageId);
    // 1) the user bubble.
    this.emitMessageSent(rec, {
      messageId: command.message.messageId,
      role: "user",
      text,
      turnId: null,
      streaming: false,
      createdAt,
      ...(via ? { via } : {}),
      ...(context && context.records.length > 0 ? { context } : {}),
      ...(attachments.stored.length > 0 ? { attachments: attachments.stored } : {}),
    });
    // The composer's Plan/Build toggle rides on every turn: the driver enters (or leaves) its native plan mode.
    if (command.interactionMode && rec.interactionMode !== command.interactionMode) {
      rec.interactionMode = command.interactionMode;
      this.emitEvent(rec, {
        ...this.base(rec),
        type: "threadInteractionModeSet",
        payload: {
          threadId: rec.threadId as ThreadEvent["aggregateId"],
          interactionMode: command.interactionMode,
          updatedAt: nowIso(),
        },
      } as ThreadEvent);
    }
    this.markPlanImplemented(command.sourceProposedPlan, rec.threadId);
    // 2) turn-start-requested.
    this.emitEvent(rec, {
      ...this.base(rec),
      type: "turnStartRequested",
      payload: {
        threadId: rec.threadId as ThreadEvent["aggregateId"],
        messageId: command.message.messageId as ThreadMessage["id"],
        runtimeMode: rec.runtimeMode,
        interactionMode: rec.interactionMode,
        createdAt,
      },
    } as ThreadEvent);
    this.pushThreadShell(rec);
    // 3) drive kora — FIRE AND FORGET. `dispatchCommand` is event-sourced: it returns the cursor
    //    the instant the turn is accepted, and ALL turn progress (assistant deltas, tool activity,
    //    settle) is delivered over the separate `subscribeThread` stream. We must NOT await the whole
    //    turn here: `sendTurn` only resolves when the entire turn (tool round-trips + post-tool model
    //    response) completes, which routinely exceeds the Kora client's per-request timeout on
    //    `dispatchCommand`. A timed-out dispatch makes the client tear down and reconnect the whole
    //    `/ws`, interrupting the live thread subscription — so every event after the first tool was
    //    emitted to zero listeners and the turn appeared to hang. (Tool-free turns settled inside the
    //    timeout, which is why only tool-using turns hung.) Errors surface as an error activity +
    //    error session state on the thread's stream, exactly where the client is listening.
    // The composer's mode is what the user sees, so it is authoritative for the turn. Thread heads from before the
    // daemon persisted the mode carry none, and their sessions silently started in approval-required behind a
    // "Full access" pill (then asked for approvals nobody expected). Synchronous, so it lands before the session starts.
    this.sessions.setPermissionMode(rec.koraThreadId, toPermissionMode(rec.runtimeMode));
    // Same for the model: what the picker shows is what answers this turn.
    if (command.modelSelection) await this.applyModelSelection(rec, command.modelSelection);
    void this.sessions
      .sendTurn({
        threadId: rec.koraThreadId,
        text: agentText,
        interactionMode: rec.interactionMode,
        ...(koraNotice ? { koraNotice } : {}),
        ...(rec.origin ? { blobOrigin: rec.origin } : {}),
        ...(attachments.runtime.length > 0 ? { attachments: attachments.runtime } : {}),
      })
      .catch((err) => {
        this.blobStarting.delete(rec.threadId);
        const r = this.threads.get(rec.threadId);
        if (!r) return;
        // The message only: "turn failed: Error: …" read as a crash to the user. The driver may already have said
        // the same failure (its "failed to start Claude: …"): failTurnReply keeps that one.
        const message = err instanceof Error ? err.message : String(err);
        const shown = this.failTurnReply(r, message, r.latestTurn?.turnId ?? null);
        this.setSession(r, "error", null, shown);
      });
    return this.globalSeq;
  }

  // ── subscriptions (Effect streams) ────────────────────────────────────────────────────
  /**
   * The HTTP snapshot fetch backing `GET /api/chat/threads/:threadId`.
   * The Kora client loads thread detail over HTTP FIRST and only marks the thread
   * "live" once that data lands (`threads.ts` `canResume` path); without this the
   * socket-only resume can leave a just-finished turn wedged on "Syncing
   * messages…" instead of flipping to live. Returns null for an unknown thread
   * so the route answers 404 (which the client treats as "defer to the socket").
   */
  getThreadDetail(threadId: string): ChatThreadDetailSnapshot | null {
    const rec = this.threads.get(threadId);
    if (!rec) return null;
    return this.buildThreadDetail(rec);
  }

  /**
   * The HTTP attachment fetch backing `GET /api/attachments/:threadId/:attachmentId`. Both ids must already
   * be validated against the safe id pattern (the route rejects anything else before calling this) — this
   * only reads the `meta.json` sidecar `resolveAttachments` wrote, then hands back the sibling data file's
   * absolute path for the route to stream. Returns null for an unknown thread/attachment pair (404).
   */
  async getAttachment(
    threadId: string,
    attachmentId: string,
  ): Promise<{ filePath: string; mimeType: string; name: string } | null> {
    const dir = path.join(this.attachmentsDir, threadId, attachmentId);
    let meta: { name?: unknown; mimeType?: unknown };
    try {
      meta = JSON.parse(await fs.promises.readFile(path.join(dir, "meta.json"), "utf8"));
    } catch {
      return null;
    }
    const name = typeof meta.name === "string" ? meta.name : "file";
    const mimeType = typeof meta.mimeType === "string" ? meta.mimeType : "application/octet-stream";
    const filePath = path.join(dir, sanitizeAttachmentName(name));
    try {
      await fs.promises.access(filePath);
    } catch {
      return null;
    }
    return { filePath, mimeType, name };
  }

  subscribeThread(threadId: string): Stream.Stream<ThreadStreamItem> {
    const rec = this.threads.get(threadId);
    if (!rec) return Stream.never; // unknown thread: hold open rather than tear the connection down
    const self = this;
    return Stream.callback<ThreadStreamItem>((queue) =>
      Effect.gen(function* () {
        // Register the live listener FIRST, then capture the snapshot sequence and build the
        // snapshot — both synchronous, so no live event can interleave between them. Live items
        // at/below the snapshot sequence are filtered (they are already in the snapshot).
        const snapshotSeq = self.globalSeq;
        const listener: ThreadListener = (item) => {
          if (item.kind === "event" && item.event.sequence <= snapshotSeq) return;
          Queue.offerUnsafe(queue, item);
        };
        self.addThreadListener(threadId, listener);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => self.removeThreadListener(threadId, listener)),
        );
        Queue.offerUnsafe(queue, { kind: "snapshot", snapshot: self.buildThreadDetail(rec) });
        Queue.offerUnsafe(queue, { kind: "synchronized" });
        return yield* Effect.never;
      }),
    );
  }

  subscribeShell(): Stream.Stream<ThreadIndexItem> {
    const self = this;
    return Stream.callback<ThreadIndexItem>((queue) =>
      Effect.gen(function* () {
        const snapshotSeq = self.globalSeq;
        const listener: ShellListener = (item) => {
          if (
            item.kind !== "snapshot" &&
            item.kind !== "synchronized" &&
            item.sequence <= snapshotSeq
          ) {
            return;
          }
          Queue.offerUnsafe(queue, item);
        };
        self.shellListeners.add(listener);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            self.shellListeners.delete(listener);
          }),
        );
        Queue.offerUnsafe(queue, { kind: "snapshot", snapshot: self.shellSnapshot() });
        Queue.offerUnsafe(queue, { kind: "synchronized" });
        return yield* Effect.never;
      }),
    );
  }

  private addThreadListener(threadId: string, listener: ThreadListener): void {
    let set = this.threadListeners.get(threadId);
    if (!set) {
      set = new Set();
      this.threadListeners.set(threadId, set);
    }
    set.add(listener);
  }
  private removeThreadListener(threadId: string, listener: ThreadListener): void {
    const set = this.threadListeners.get(threadId);
    if (set) {
      set.delete(listener);
      if (set.size === 0) this.threadListeners.delete(threadId);
    }
  }
}

/** The single in-process chat engine, constructed lazily on first use. */
let engine: ChatEngine | undefined;
export function chatEngine(): ChatEngine {
  if (!engine) engine = new ChatEngine();
  return engine;
}
export type { ChatEngine };

/** An agent's "do you trust this folder?" start-up dialog (Claude: "Quick safety check: Is this a project you created or
 *  one you trust?", "Do you trust the files in this folder?"; Codex: "allow Codex to work in this folder"). */
export function isFolderTrustPrompt(blocker: string | null | undefined): boolean {
  if (!blocker) return false;
  return (
    /\btrust\b/i.test(blocker) && /\b(folder|project|files|directory|workspace)\b/i.test(blocker)
  );
}
