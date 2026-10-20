/**
 * Subagents of native providers, read back from a thread's persisted `task.*` and `tool.*`
 * activities, plus the panel model every client renders from them.
 *
 * Bridge code: once a typed subagent projection exists for a thread, `deriveAgentPanelModel`
 * takes it instead (`v2Projection`) and this fold is skipped; the file goes away with the v1
 * orchestrator. Field names and transitions mirror that projection so the swap stays mechanical.
 *
 * Rules below come from bugs that shipped: a reusable identity can be activated many times;
 * idle is a real, non-terminal state; usage merges differ per provider; the first terminal
 * timestamp wins; reactivation wipes the old run's terminal detail; and folding is robust to
 * order (a completion may create an agent, a late start only fills in metadata).
 */
import type { ChatThreadActivity } from "@kora/contracts";

// ── Public types ─────────────────────────────────────────────────────

type SettledStatus = "completed" | "failed" | "cancelled" | "interrupted";
type LiveStatus = "pending" | "running" | "waiting";
export type RuntimeSubagentStatus = LiveStatus | "idle" | SettledStatus;

type UsageCounter =
  | "inputTokens"
  | "cachedInputTokens"
  | "outputTokens"
  | "reasoningOutputTokens"
  | "toolUses"
  | "durationMs";
export type SubagentUsage = { readonly totalTokens: number } & {
  readonly [Counter in UsageCounter]?: number;
};

export type SubagentActivityEntry = Readonly<{ at: string; summary: string }>;
export type SubagentWorkflowPhase = Readonly<{ index: number; title: string }>;
export type SubagentRunHandles = Readonly<
  Partial<Record<"runId" | "scriptPath" | "transcriptDir" | "sessionUrl", string>>
>;

type AgentKind = "subagent" | "subagent_batch" | "workflow" | "workflow_agent";

/** Optional text facts about an agent; null until some row tells us. */
type AgentFacts = Record<
  | "role"
  | "model"
  | "effort"
  | "progress"
  | "lastToolName"
  | "result"
  | "error"
  | "outputFile"
  | "parentAgentId"
  | "phaseTitle"
  | "workflowName",
  string | null
> &
  Record<"agentIndex" | "phaseIndex" | "attempt", number | null>;

type AgentState = AgentFacts & {
  id: string;
  kind: AgentKind;
  title: string;
  /** First retained observation, used as the roster's stable display order. */
  firstSeenAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  status: RuntimeSubagentStatus;
  activationCount: number;
  recentActivity: ReadonlyArray<SubagentActivityEntry>;
  phases: ReadonlyArray<SubagentWorkflowPhase>;
  runHandles: SubagentRunHandles | null;
  usage: SubagentUsage | null;
};

export type RuntimeSubagent = Readonly<AgentState>;

// ── Status classes ───────────────────────────────────────────────────

const SETTLED: ReadonlySet<RuntimeSubagentStatus> = new Set<SettledStatus>([
  "interrupted",
  "failed",
  "completed",
  "cancelled",
]);
const LIVE: ReadonlySet<RuntimeSubagentStatus> = new Set<LiveStatus>([
  "pending",
  "running",
  "waiting",
]);

export const isTerminalSubagentStatus = (status: RuntimeSubagentStatus): boolean =>
  SETTLED.has(status);

/** Live = the user may still need to care. Idle is resumable but not live; waiting needs the user, so it is live. */
export const isActiveSubagentStatus = (status: RuntimeSubagentStatus): boolean => LIVE.has(status);

const ALL_STATUSES: ReadonlySet<string> = new Set([...SETTLED, ...LIVE, "idle"]);

const readStatus = (value: unknown): RuntimeSubagentStatus | undefined =>
  typeof value === "string" && ALL_STATUSES.has(value)
    ? (value as RuntimeSubagentStatus)
    : undefined;

// A Map, not an object: payloads are not schema-checked on read, and a status such as
// "toString" must miss rather than find an inherited function.
const COMPLETION_STATUS = new Map<string, RuntimeSubagentStatus>([
  ["stopped", "interrupted"],
  ["failed", "failed"],
  ["completed", "completed"],
]);

/**
 * True when the payload is not an agent and stays off the Agents surface. The server stamps
 * `agentKind` once at ingestion (classifyTaskAgentKind); the client only reads the stamp. Rows
 * without one (legacy threads, older servers) are background work and render in the ordinary
 * work log, exactly as before this feature.
 */
export function isBackgroundTaskActivity(payload: Record<string, unknown>): boolean {
  return payload.agentKind !== "agent";
}

// ── Payload readers ──────────────────────────────────────────────────

const MAX_RECENT = 6;
const MAX_SUMMARY = 180;
const MAX_ROSTER = 100;

type Payload = Record<string, unknown>;

/** Trimmed, non-empty text or undefined. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** A finite, non-negative number or undefined. */
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const clip = (value: string): string =>
  value.length > MAX_SUMMARY ? value.slice(0, MAX_SUMMARY - 1) + "…" : value;

/** Ring buffer of recent activity; a repeat of the newest summary is dropped. */
function withRecent(
  recent: ReadonlyArray<SubagentActivityEntry>,
  at: string,
  summary: string,
): ReadonlyArray<SubagentActivityEntry> {
  const entry = { at, summary: clip(summary) };
  if (recent.at(-1)?.summary === entry.summary) return recent;
  return [...recent, entry].slice(-MAX_RECENT);
}

const COUNTERS: ReadonlyArray<UsageCounter> = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "toolUses",
  "durationMs",
];

function readUsage(value: unknown): SubagentUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Payload;
  const totalTokens = count(raw.totalTokens);
  if (totalTokens === undefined) return undefined;
  const usage: { totalTokens: number } & { [Counter in UsageCounter]?: number } = { totalTokens };
  for (const counter of COUNTERS) {
    const amount = count(raw[counter]);
    if (amount !== undefined) usage[counter] = amount;
  }
  return usage;
}

/**
 * Field-wise maximum. Providers report usage either cumulatively or as a final total, so the
 * larger value is always the better one, and a counter one side lacks keeps the other's value.
 */
function maxUsage(known: SubagentUsage | null, reported?: SubagentUsage): SubagentUsage | null {
  if (reported === undefined || known === null) return reported ?? known;
  const current = known;
  const incoming = reported;
  const merged: { totalTokens: number } & { [Counter in UsageCounter]?: number } = {
    totalTokens: Math.max(current.totalTokens, incoming.totalTokens),
  };
  for (const counter of COUNTERS) {
    const values = [current[counter], incoming[counter]].filter(
      (amount): amount is number => amount !== undefined,
    );
    if (values.length > 0) merged[counter] = Math.max(...values);
  }
  return merged;
}

function readPhases(value: unknown): SubagentWorkflowPhase[] {
  if (!Array.isArray(value)) return [];
  const phases: SubagentWorkflowPhase[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const index = count((entry as Payload).index);
    const title = text((entry as Payload).title);
    if (index !== undefined && title !== undefined) phases.push({ index, title });
  }
  return phases.sort((left, right) => left.index - right.index);
}

function readRunHandles(value: unknown): SubagentRunHandles {
  if (value === null || typeof value !== "object") return {};
  const raw = value as Payload;
  const handles: { -readonly [Key in keyof SubagentRunHandles]: SubagentRunHandles[Key] } = {};
  for (const key of ["runId", "scriptPath", "transcriptDir"] as const) {
    const found = text(raw[key]);
    if (found !== undefined) handles[key] = found;
  }
  // Belt and braces: the adapter sanitises, but payloads are not schema-checked on read.
  const sessionUrl = text(raw.sessionUrl);
  if (sessionUrl !== undefined && /^https?:\/\//i.test(sessionUrl)) handles.sessionUrl = sessionUrl;
  return handles;
}

// ── Agent state ──────────────────────────────────────────────────────

function kindOf(payload: Payload, id: string): AgentKind {
  if (payload.taskType === "subagent_batch") return "subagent_batch";
  if (text(payload.taskType) === "local_workflow") return "workflow";
  return payload.parentAgentId !== undefined || id.includes(":wf:") ? "workflow_agent" : "subagent";
}

/** Facts nobody has reported yet, and a run that has not started. */
const BLANK = {
  outputFile: null,
  error: null,
  result: null,
  lastToolName: null,
  progress: null,
  usage: null,
  runHandles: null,
  completedAt: null,
  startedAt: null,
} as const;

function newAgent(id: string, payload: Payload, at: string): AgentState {
  const orNull = <T>(value: T | undefined): T | null => (value === undefined ? null : value);
  const textOrNull = (key: string) => orNull(text(payload[key]));
  const countOrNull = (key: string) => orNull(count(payload[key]));
  return {
    ...BLANK,
    id,
    kind: kindOf(payload, id),
    title: text(payload.title) ?? text(payload.detail) ?? id,
    firstSeenAt: at,
    updatedAt: at,
    activationCount: 0,
    status: "pending",
    phases: [],
    recentActivity: [],
    effort: textOrNull("effort"),
    model: textOrNull("model"),
    role: textOrNull("role"),
    workflowName: textOrNull("workflowName"),
    parentAgentId: textOrNull("parentAgentId"),
    phaseTitle: textOrNull("phaseTitle"),
    attempt: countOrNull("attempt"),
    phaseIndex: countOrNull("phaseIndex"),
    agentIndex: countOrNull("agentIndex"),
  };
}

/** Text facts any row may refine; a missing value never erases a known one. */
const REFINABLE_TEXT = ["title", "role", "model", "effort", "workflowName", "phaseTitle"] as const;

/** Learn what a row says about the agent. Never downgrades a known value to null. */
function absorbMetadata(agent: AgentState, payload: Payload): void {
  if (payload.taskType === "subagent_batch") agent.kind = "subagent_batch";
  for (const key of REFINABLE_TEXT) {
    const found = text(payload[key]);
    if (found !== undefined) agent[key] = found;
  }
  const parent = text(payload.parentAgentId);
  if (parent !== undefined) {
    agent.parentAgentId = parent;
    if (agent.kind === "subagent") agent.kind = "workflow_agent";
  }
  if (text(payload.taskType) === "local_workflow") agent.kind = "workflow";

  for (const key of ["agentIndex", "phaseIndex"] as const) {
    const found = count(payload[key]);
    if (found !== undefined) agent[key] = found;
  }

  const attempt = count(payload.attempt);
  if (attempt !== undefined) {
    // A higher attempt on a workflow slot reactivates the same identity: drop the old
    // attempt's terminal detail so the move back to running reads as a fresh run. The
    // activation count is bumped only in moveTo (bumping here as well counted retries twice).
    if (agent.attempt !== null && attempt > agent.attempt) wipeRunOutcome(agent);
    agent.attempt = attempt;
  }

  const outputFile = text(payload.outputFile);
  if (outputFile !== undefined) agent.outputFile = outputFile;

  const phases = readPhases(payload.phases);
  if (phases.length > 0) agent.phases = phases;

  const handles = readRunHandles(payload.runHandles);
  if (Object.keys(handles).length > 0) agent.runHandles = { ...agent.runHandles, ...handles };
}

function wipeRunOutcome(agent: AgentState): void {
  Object.assign(agent, { completedAt: null, error: null, result: null });
}

/** Status transition with the activation, start and end bookkeeping that goes with it. */
function moveTo(agent: AgentState, next: RuntimeSubagentStatus, at: string): void {
  const fromSettled = SETTLED.has(agent.status);
  const toSettled = SETTLED.has(next);
  // A second terminal event changes nothing: the first one wins and its time stays put.
  if (fromSettled && toSettled) return;

  const restarting =
    (fromSettled || agent.status === "idle") && (next === "running" || next === "pending");
  if (restarting) {
    // Same identity, new run: never show the previous run's outcome on a live card.
    agent.activationCount += 1;
    wipeRunOutcome(agent);
    if (next === "running") agent.startedAt = at;
  }
  if (next === "running") agent.startedAt ??= at;
  if (toSettled) agent.completedAt ??= at;
  agent.status = next;
}

/** Record a run's outcome text: errors on failure, otherwise the result. */
function recordOutcome(agent: AgentState, summary: string, overwriteResult: boolean): void {
  if (agent.status === "failed") agent.error ??= clip(summary);
  else agent.result = overwriteResult ? clip(summary) : (agent.result ?? clip(summary));
}

// ── Fold ─────────────────────────────────────────────────────────────

type Roster = Map<string, AgentState>;

/** The agent a task row is about, created on first sight unless the row is background work. */
function agentFor(
  roster: Roster,
  payload: Payload,
  at: string,
  stickyMembership: boolean,
): AgentState | undefined {
  const id = text(payload.taskId);
  if (id === undefined) return undefined;
  const known = roster.get(id);
  // Membership is decided on the first row and then sticks: later rows (terminal ones often
  // carry just taskId + status) inherit it instead of being judged again.
  if (known !== undefined && stickyMembership) {
    absorbMetadata(known, payload);
    return known;
  }
  if (isBackgroundTaskActivity(payload)) return undefined;
  const agent = known ?? newAgent(id, payload, at);
  roster.set(id, agent);
  absorbMetadata(agent, payload);
  return agent;
}

const ensureActivated = (agent: AgentState) => {
  if (agent.activationCount === 0) agent.activationCount = 1;
};

type Step = (roster: Roster, payload: Payload, at: string) => void;

const STEPS = new Map<string, Step>([
  [
    "task.started",
    (roster, payload, at) => {
      // Only real agents join; shells, monitors and plan-mode tasks are background work for
      // the ordinary work log (a 12 s shell stall is not a subagent).
      const agent = agentFor(roster, payload, at, false);
      if (agent === undefined) return;
      // A start arriving after the run settled is a late delivery: metadata only, it must not
      // reopen the run. Reactivation comes only from explicit status changes. Guard on status,
      // not activationCount: an agent first seen settled has zero activations.
      if (agent.activationCount === 0 && !SETTLED.has(agent.status)) {
        agent.activationCount = 1;
        agent.startedAt ??= at;
        agent.status = "running";
      } else if (agent.status === "idle") {
        moveTo(agent, "running", at);
      }
      const detail = text(payload.detail);
      if (detail !== undefined && agent.title === agent.id) agent.title = detail;
      agent.updatedAt = at;
    },
  ],
  [
    "task.progress",
    (roster, payload, at) => {
      const isNew = !roster.has(text(payload.taskId) ?? "");
      const agent = agentFor(roster, payload, at, true);
      if (agent === undefined) return;
      ensureActivated(agent);
      const explicit = readStatus(payload.status);
      if (explicit !== undefined) {
        moveTo(agent, explicit, at);
      } else {
        const quietSnapshot = payload.usageSnapshot === true && !isNew;
        if (!quietSnapshot && !SETTLED.has(agent.status) && agent.status !== "idle") {
          moveTo(agent, "running", at);
        }
      }
      const summary = text(payload.summary);
      if (summary !== undefined) {
        agent.progress = clip(summary);
        agent.recentActivity = withRecent(agent.recentActivity, at, summary);
      }
      const tool = text(payload.lastToolName);
      if (tool !== undefined) {
        agent.lastToolName = tool;
        if (summary === undefined)
          agent.recentActivity = withRecent(agent.recentActivity, at, `▸ ${tool}`);
      }
      const error = text(payload.error);
      if (error !== undefined) agent.error = clip(error);
      agent.usage = maxUsage(agent.usage, readUsage(payload.typedUsage));
      agent.updatedAt = at;
    },
  ],
  [
    "task.updated",
    (roster, payload, at) => {
      const agent = agentFor(roster, payload, at, true);
      if (agent === undefined) return;
      const detail = text(payload.detail);
      if (detail !== undefined) agent.progress = clip(detail);
      // First seen through an update (its start aged out): it has run at least once, and
      // zero would read as "run 0" and let a late start treat it as never started.
      ensureActivated(agent);
      const settledBefore = SETTLED.has(agent.status);
      const status = readStatus(payload.status);
      if (status !== undefined) moveTo(agent, status, at);
      const error = text(payload.error);
      if (error !== undefined) agent.error = clip(error);
      // The provider's end time beats ingestion time for the transition that settled the run.
      const endedAt = text(payload.endedAt);
      if (endedAt !== undefined && !settledBefore && SETTLED.has(agent.status)) {
        agent.completedAt = endedAt;
      }
      agent.updatedAt = at;
    },
  ],
  [
    "task.completed",
    (roster, payload, at) => {
      const agent = agentFor(roster, payload, at, true);
      if (agent === undefined) return;
      ensureActivated(agent);
      const summary = text(payload.summary) ?? text(payload.detail);
      const usage = readUsage(payload.typedUsage);
      if (SETTLED.has(agent.status)) {
        // Status and times are frozen, but the completion still enriches: Claude often sends a
        // terminal update first, and only the completion has the result and final usage.
        // Fill-if-missing keeps a duplicate completion from replacing the first result.
        if (summary !== undefined) recordOutcome(agent, summary, false);
        agent.usage = maxUsage(agent.usage, usage);
        return;
      }
      moveTo(agent, COMPLETION_STATUS.get(text(payload.status) ?? "") ?? "completed", at);
      if (summary !== undefined) recordOutcome(agent, summary, true);
      agent.usage = maxUsage(agent.usage, usage);
      agent.updatedAt = at;
    },
  ],
  [
    "tool.progress",
    (roster, payload, at) => {
      // Heartbeat from an agent's own tool use: what it is doing right now.
      const agent = roster.get(text(payload.taskId) ?? "");
      if (agent === undefined) return;
      const tool = text(payload.toolName);
      if (tool !== undefined) {
        agent.lastToolName = tool;
        agent.recentActivity = withRecent(agent.recentActivity, at, `▸ ${tool}`);
      }
      agent.updatedAt = at;
    },
  ],
]);

/**
 * Members of a settled workflow that never got their own terminal row cannot still be in
 * flight: give them the coordinator's outcome so they do not read as working forever.
 */
function settleOrphanedMembers(roster: Roster): void {
  for (const coordinator of roster.values()) {
    if (coordinator.kind !== "workflow" || !SETTLED.has(coordinator.status)) continue;
    for (const member of roster.values()) {
      const open = !SETTLED.has(member.status) && member.status !== "idle";
      if (member.parentAgentId !== coordinator.id || !open) continue;
      member.status = coordinator.status === "completed" ? "completed" : "interrupted";
      member.completedAt ??= coordinator.completedAt ?? coordinator.updatedAt;
      member.updatedAt = coordinator.updatedAt;
    }
  }
}

/**
 * Fold a thread's activities into subagent state. Tolerant: a malformed row is skipped on its
 * own and unknown kinds are ignored. Pure; memoise on the activity array at the atom layer.
 *
 * `sessionLive: false` means the provider session is gone, and background tasks die with it:
 * agents whose terminal rows were lost (restart, crash) become interrupted instead of
 * "working" forever. Idle is kept, since a resumable Codex child stays resumable.
 */
export function foldSubagentActivities(
  activities: ReadonlyArray<ChatThreadActivity>,
  options?: { readonly sessionLive?: boolean },
): ReadonlyArray<RuntimeSubagent> {
  const roster: Roster = new Map();
  for (const { kind, payload, createdAt } of activities) {
    if (payload === null || typeof payload !== "object") continue;
    STEPS.get(kind)?.(roster, payload as Payload, createdAt);
  }

  settleOrphanedMembers(roster);

  // Mirrors the server's liveness registry clearing on session exit, so the panel and the
  // sidebar always agree.
  if (options?.sessionLive === false) {
    for (const agent of roster.values()) {
      if (!LIVE.has(agent.status)) continue;
      agent.status = "interrupted";
      agent.completedAt ??= agent.updatedAt;
    }
  }

  let kept = [...roster.values()];
  if (kept.length > MAX_ROSTER) {
    // Live first, then idle, then the most recently updated settled ones.
    const tier = (agent: AgentState) =>
      LIVE.has(agent.status) ? 0 : agent.status === "idle" ? 1 : 2;
    kept = kept
      .sort(
        (left, right) => tier(left) - tier(right) || right.updatedAt.localeCompare(left.updatedAt),
      )
      .slice(0, MAX_ROSTER);
  }
  return kept.map((agent) => ({ ...agent }));
}

// ── Panel model ──────────────────────────────────────────────────────

type PanelPhase = Readonly<{
  index: number;
  title: string;
  members: ReadonlyArray<RuntimeSubagent>;
  /** done = every member settled (success or error); running = any active. */
  state: "pending" | "running" | "done";
  activeCount: number;
  settledCount: number;
}>;

export interface AgentPanelWorkflowGroup {
  readonly workflow: RuntimeSubagent;
  readonly phases: ReadonlyArray<PanelPhase>;
  /** Members with no resolvable phase (orphans render under the workflow). */
  readonly unphasedMembers: ReadonlyArray<RuntimeSubagent>;
}

type PanelCounts = Record<
  "runningCount" | "waitingCount" | "idleCount" | "settledCount" | "totalTokens" | "liveCount",
  number
>;

export interface AgentPanelModel extends Readonly<PanelCounts> {
  readonly workflows: ReadonlyArray<AgentPanelWorkflowGroup>;
  readonly directAgents: ReadonlyArray<RuntimeSubagent>;
  readonly hasAgents: boolean;
}

const zeroCounts = (): PanelCounts => ({
  liveCount: 0,
  settledCount: 0,
  idleCount: 0,
  waitingCount: 0,
  runningCount: 0,
  ...{ totalTokens: 0 },
});

const NO_AGENTS: AgentPanelModel = {
  ...zeroCounts(),
  hasAgents: false,
  directAgents: [],
  workflows: [],
};

export function emptyAgentPanelModel(): AgentPanelModel {
  return NO_AGENTS;
}

/** Stable display order: first seen, then id. Updates must never reshuffle visible rows. */
const byFirstSeen = (left: RuntimeSubagent, right: RuntimeSubagent) =>
  left.firstSeenAt.localeCompare(right.firstSeenAt) || left.id.localeCompare(right.id);
const bySlot = (left: RuntimeSubagent, right: RuntimeSubagent) =>
  (left.agentIndex ?? 0) - (right.agentIndex ?? 0);

/** The workflow's declared phases, or the phases its members mention (titled "Phase N" if unnamed). */
function phasesOf(
  workflow: RuntimeSubagent,
  members: ReadonlyArray<RuntimeSubagent>,
): ReadonlyArray<SubagentWorkflowPhase> {
  if (workflow.phases.length > 0) return workflow.phases;
  const seen = new Map<number, string>();
  for (const { phaseIndex, phaseTitle } of members) {
    if (phaseIndex === null || seen.has(phaseIndex)) continue;
    seen.set(phaseIndex, phaseTitle ?? `Phase ${phaseIndex + 1}`);
  }
  return [...seen].map(([index, title]) => ({ index, title })).sort((a, b) => a.index - b.index);
}

function panelPhase(
  phase: SubagentWorkflowPhase,
  members: ReadonlyArray<RuntimeSubagent>,
): PanelPhase {
  const inPhase = members.filter((member) => member.phaseIndex === phase.index).sort(bySlot);
  // An idle member keeps its phase open: a resumable Codex member has not finished it.
  const activeCount = inPhase.filter(({ status }) => LIVE.has(status) || status === "idle").length;
  const settledCount = inPhase.filter(({ status }) => SETTLED.has(status)).length;
  let state: PanelPhase["state"] = "pending";
  if (activeCount > 0) state = "running";
  else if (inPhase.length > 0 && settledCount === inPhase.length) state = "done";
  return {
    index: phase.index,
    title: phase.title,
    members: inPhase,
    state,
    activeCount,
    settledCount,
  };
}

function workflowGroup(
  workflow: RuntimeSubagent,
  members: ReadonlyArray<RuntimeSubagent>,
): AgentPanelWorkflowGroup {
  const phases = phasesOf(workflow, members);
  const known = new Set(phases.map(({ index }) => index));
  // A member whose phase row was lost must still show up, so unknown indices land here too.
  const unphasedMembers = members
    .filter(({ phaseIndex }) => phaseIndex === null || !known.has(phaseIndex))
    .sort(bySlot);
  return { workflow, phases: phases.map((phase) => panelPhase(phase, members)), unphasedMembers };
}

/**
 * Source-neutral view model. A typed projection for the thread (`v2Projection`) replaces the
 * fold outright; the two are never merged (that duplicated agents). Until it exists callers
 * pass null and the native fold is used.
 */
export function deriveAgentPanelModel(sources: {
  readonly v2Projection?: ReadonlyArray<RuntimeSubagent> | null;
  readonly agents: ReadonlyArray<RuntimeSubagent>;
}): AgentPanelModel {
  const all = sources.v2Projection ?? sources.agents;
  if (all.length === 0) return NO_AGENTS;

  const workflows = all.filter(({ kind }) => kind === "workflow").sort(byFirstSeen);
  const workflowIds = new Set(workflows.map(({ id }) => id));
  const membersByWorkflow = new Map<string, RuntimeSubagent[]>();
  const direct: RuntimeSubagent[] = [];
  for (const agent of all) {
    if (agent.kind === "workflow") continue;
    const parent = agent.parentAgentId;
    if (parent === null || !workflowIds.has(parent)) {
      // Members whose coordinator aged out fall back to the direct list.
      direct.push(agent);
      continue;
    }
    const list = membersByWorkflow.get(parent);
    if (list === undefined) membersByWorkflow.set(parent, [agent]);
    else list.push(agent);
  }

  const counts = zeroCounts();
  for (const agent of all) {
    // A coordinator with members is only their container: it reports running for the whole
    // run and some providers roll their usage into it, so counting it would add a phantom
    // worker and double the tokens.
    if (agent.kind === "workflow" && (membersByWorkflow.get(agent.id)?.length ?? 0) > 0) continue;
    const bucket: keyof PanelCounts =
      agent.status === "running" || agent.status === "pending"
        ? "runningCount"
        : agent.status === "waiting"
          ? "waitingCount"
          : agent.status === "idle"
            ? "idleCount"
            : "settledCount";
    counts[bucket] += 1;
    counts.totalTokens += agent.usage?.totalTokens ?? 0;
  }
  counts.liveCount = counts.runningCount + counts.waitingCount;

  return {
    ...counts,
    hasAgents: true,
    workflows: workflows.map((workflow) =>
      workflowGroup(workflow, membersByWorkflow.get(workflow.id) ?? []),
    ),
    directAgents: direct.sort(byFirstSeen),
  };
}

// ── Labels ───────────────────────────────────────────────────────────

/**
 * Short model chip: drops a `claude-` prefix and a date or `-latest` suffix
 * ("claude-opus-4-20250514" → "opus-4", "claude-sonnet-5[1m]" → "sonnet-5[1m]"); unknown ids
 * pass through. An effort is appended as "· high".
 */
export function formatSubagentModelLabel(
  modelId: string | null,
  effort: string | null,
): string | null {
  if (!modelId) return null;
  let short = modelId.startsWith("claude-") ? modelId.slice("claude-".length) : modelId;
  for (const suffix of [/-\d{8}$/, /-latest$/]) short = short.replace(suffix, "");
  return effort ? `${short} · ${effort}` : short;
}

export function formatSubagentTokenCount(totalTokens: number): string {
  if (totalTokens < 1_000) return String(totalTokens);
  if (!(totalTokens < 1_000_000)) return `${(totalTokens / 1_000_000).toFixed(1)}M`;
  const thousands = totalTokens / 1_000;
  return `${thousands < 100 ? thousands.toFixed(1) : Math.round(thousands)}k`;
}
