import * as Arr from "effect/Array";
import * as O from "effect/Order";
import type {
  ChatCheckpointSummary,
  ChatLatestTurn,
  ChatSession,
  ChatThread,
  ChatThreadActivity,
  ItemId,
  ThreadEvent,
  ThreadMergeRequestLink,
  ThreadMessage,
  TurnId,
} from "@kora/contracts";
import { compareDateTimeStrings } from "@kora/shared/isoTimes";
import { threadMergeRequestKeysEqual } from "@kora/shared/threadMergeRequests";

export type ThreadDetailReducerResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "deleted" }
  | { readonly kind: "updated"; readonly thread: ChatThread };

type EventOf<Type extends ThreadEvent["type"]> = Extract<ThreadEvent, { type: Type }>;
type Handler<Type extends ThreadEvent["type"]> = (
  thread: ChatThread,
  event: EventOf<Type>,
) => ThreadDetailReducerResult;
type Plan = ChatThread["proposedPlans"][number];

const UNCHANGED: ThreadDetailReducerResult = { kind: "unchanged" };

/** The thread with `patch` applied and its `updatedAt` moved to `updatedAt`. */
const updated = (
  thread: ChatThread,
  patch: Partial<ChatThread>,
  updatedAt: string,
): ThreadDetailReducerResult => ({ kind: "updated", thread: { ...thread, ...patch, updatedAt } });

/** The entries of `source` named in `keys` whose value is not `undefined`. */
function definedFields<Source extends object, Key extends keyof Source>(
  source: Source,
  keys: ReadonlyArray<Key>,
): { [K in Key]?: Exclude<Source[K], undefined> } {
  const picked: { [K in Key]?: Exclude<Source[K], undefined> } = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) picked[key] = value as Exclude<Source[Key], undefined>;
  }
  return picked;
}

/** Copy the named fields of `source`, as they are. */
function pick<Source extends object, Key extends keyof Source>(
  source: Source,
  keys: ReadonlyArray<Key>,
): Pick<Source, Key> {
  return Object.fromEntries(keys.map((key) => [key, source[key]])) as Pick<Source, Key>;
}

// ── Orderings ────────────────────────────────────────────────────────

const byCreatedThenId = O.combine<Plan>(
  O.mapInput(O.String, (plan) => plan.createdAt),
  O.mapInput(O.String, (plan) => plan.id),
);

const byTurnCount: O.Order<ChatCheckpointSummary> = O.mapInput(
  O.Number,
  (checkpoint) => checkpoint.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER,
);

/** Sequence first (rows without one go last), then creation time, then id. */
const activityOrder: O.Order<ChatThreadActivity> = (left, right) =>
  O.Number(left.sequence ?? Number.MAX_SAFE_INTEGER, right.sequence ?? Number.MAX_SAFE_INTEGER) ||
  O.String(left.createdAt, right.createdAt) ||
  O.String(left.id, right.id);

// Ids per activities array this reducer produced, so an in-order live append can reject a
// re-delivered id without rescanning. Membership also vouches that the array is already in
// activityOrder, which a snapshot-loaded array (database order) need not be.
const knownActivityIds = new WeakMap<
  ReadonlyArray<ChatThreadActivity>,
  Set<ChatThreadActivity["id"]>
>();

// ── Pull request links ───────────────────────────────────────────────

/** Replace the link list; the legacy single link survives only while a visible link still has its URL. */
function withPullRequests(
  thread: ChatThread,
  pullRequests: ReadonlyArray<ThreadMergeRequestLink>,
  updatedAt: string,
): ThreadDetailReducerResult {
  const legacy = thread.linkedPullRequest;
  const legacyStillShown =
    legacy != null &&
    pullRequests.some((link) => link.url === legacy.url && link.source !== "stack-dismissed");
  return updated(
    thread,
    { pullRequests, linkedPullRequest: legacyStillShown ? legacy : null },
    updatedAt,
  );
}

// ── Turns ────────────────────────────────────────────────────────────

/** How a running turn ends when its session moves to `status`; null while it is still going. */
function turnEndForSession(
  status: ChatSession["status"],
): "completed" | "interrupted" | "error" | null {
  if (status === "starting" || status === "running") return null;
  if (status === "error") return "error";
  if (status === "interrupted" || status === "stopped") return "interrupted";
  return "completed";
}

/** A checkpoint that errored marks its turn as errored; ready and missing both read as done. */
const turnStateFromCheckpoint = (status: "ready" | "missing" | "error"): ChatLatestTurn["state"] =>
  status === "error" ? "error" : "completed";

const TURN_KEYS = [
  "turnId",
  "state",
  "requestedAt",
  "startedAt",
  "completedAt",
  "assistantMessageId",
] as const;

/**
 * `before` when `after` carries the same values, else `after`. Streaming recomputes the
 * latest turn on every delta; keeping the old object lets memoised selectors skip work.
 */
function keepSameTurn(
  before: ChatLatestTurn | null,
  after: ChatLatestTurn | null,
): ChatLatestTurn | null {
  if (before === null || after === null) return after;
  const same =
    TURN_KEYS.every((key) => before[key] === after[key]) &&
    before.sourceProposedPlan?.threadId === after.sourceProposedPlan?.threadId &&
    before.sourceProposedPlan?.planId === after.sourceProposedPlan?.planId;
  return same ? before : after;
}

/** Point the checkpoint of `turnId` at `messageId`; the same array back when nothing changes. */
function bindCheckpointMessage(
  checkpoints: ReadonlyArray<ChatCheckpointSummary>,
  turnId: TurnId,
  messageId: ItemId,
): ReadonlyArray<ChatCheckpointSummary> {
  const stale = (entry: ChatCheckpointSummary) =>
    entry.turnId === turnId && entry.assistantMessageId !== messageId;
  if (!checkpoints.some(stale)) return checkpoints;
  return checkpoints.map((entry) =>
    entry.turnId === turnId ? { ...entry, assistantMessageId: messageId } : entry,
  );
}

// ── Messages ─────────────────────────────────────────────────────────

/** Optional message fields copied through whenever an event carries them. */
const OPTIONAL_MESSAGE_KEYS = [
  "attachments",
  "context",
  // A Kora-authored turn (mode notice / fleet notes): the timeline renders it as a row, not a bubble.
  "notice",
  // Blobs groups / outside access: author, recipients, routing note, kind and the client it came through.
  "authorBlobId",
  "to",
  "routeWhy",
  "kind",
  "via",
] as const satisfies ReadonlyArray<keyof ThreadMessage>;

function messageFromEvent(payload: EventOf<"threadMessageSent">["payload"]): ThreadMessage {
  const core = pick(payload, ["createdAt", "updatedAt", "role", "streaming", "text", "turnId"]);
  return { id: payload.messageId, ...core, ...definedFields(payload, OPTIONAL_MESSAGE_KEYS) };
}

/** Fold an incoming copy of a message into the stored one (a delta appends, a final copy replaces). */
function mergeMessage(stored: ThreadMessage, incoming: ThreadMessage): ThreadMessage {
  let text = stored.text;
  if (incoming.streaming) text = stored.text + incoming.text;
  else if (incoming.text !== "") text = incoming.text;
  return {
    ...stored,
    text,
    streaming: incoming.streaming,
    ...(incoming.turnId === undefined ? {} : { turnId: incoming.turnId }),
    ...(incoming.streaming ? {} : { updatedAt: incoming.updatedAt }),
    ...definedFields(incoming, OPTIONAL_MESSAGE_KEYS),
  };
}

/** After a revert: keep messages of retained turns, topping each role up to `turnCount` with turnless ones. */
function messagesKeptByRevert(
  messages: ReadonlyArray<ThreadMessage>,
  keptTurns: ReadonlySet<string>,
  turnCount: number,
): ThreadMessage[] {
  const keep = new Set<string>(
    messages
      .filter((m) => m.role === "system" || (m.turnId !== null && keptTurns.has(m.turnId)))
      .map((m) => m.id),
  );
  const earliestFirst = (left: ThreadMessage, right: ThreadMessage) =>
    compareDateTimeStrings(left.createdAt, right.createdAt) || left.id.localeCompare(right.id);

  for (const role of ["user", "assistant"] as const) {
    const alreadyKept = messages.reduce(
      (count, m) => (m.role === role && keep.has(m.id) ? count + 1 : count),
      0,
    );
    const room = Math.max(0, turnCount - alreadyKept);
    if (room === 0) continue;
    // `.sort()` on the fresh `.filter()` result, not `.toSorted()`: mobile runs Hermes,
    // which has no ES2023 array methods.
    const candidates = messages
      .filter(
        (m) => m.role === role && !keep.has(m.id) && (m.turnId === null || keptTurns.has(m.turnId)),
      )
      .sort(earliestFirst);
    for (const m of candidates.slice(0, room)) keep.add(m.id);
  }
  return messages.filter((m) => keep.has(m.id));
}

// ── Activities ───────────────────────────────────────────────────────

/**
 * Same validity rule as `latestContextWindowSnapshot` and the server's
 * `dropStaleContextWindowActivities`: only a finite, non-negative `usedTokens` counts, so a
 * malformed row never displaces an earlier usable one.
 */
function isUsableContextWindow(activity: ChatThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") return false;
  const payload = activity.payload;
  if (payload === null || typeof payload !== "object") return false;
  const usedTokens = (payload as { usedTokens?: unknown }).usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}

// ── Handlers ─────────────────────────────────────────────────────────

const ignore = () => UNCHANGED;

const META_KEYS = [
  "title",
  "titleState",
  "titleRegeneration",
  "modelSelection",
  "branch",
  "worktreePath",
  "linkedPullRequest",
  "branchPullRequest",
  "activeOrderKey",
] as const;

/** What thread.created carries over as-is. */
const CREATED_THREAD_KEYS = [
  "projectId",
  "title",
  "createdAt",
  "updatedAt",
  "branch",
  "worktreePath",
  "modelSelection",
  "agentMode",
  "interactionMode",
  "runtimeMode",
] as const;

/** A turn-diff payload is a checkpoint summary plus its thread id. */
const CHECKPOINT_KEYS = [
  "turnId",
  "status",
  "files",
  "checkpointRef",
  "checkpointTurnCount",
  "assistantMessageId",
  "completedAt",
] as const;

const handlers: { [Type in ThreadEvent["type"]]: Handler<Type> } = {
  // Project events do not touch a thread's detail.
  projectCreated: ignore,
  projectMetaUpdated: ignore,
  projectDeleted: ignore,

  threadCreated: (_thread, { payload }) => ({
    kind: "updated",
    thread: {
      id: payload.threadId,
      ...pick(payload, CREATED_THREAD_KEYS),
      ...{ session: null, latestTurn: null, branchPullRequest: null, activeOrderKey: null },
      ...{ archivedAt: null, deletedAt: null, settledAt: null, settledOverride: null },
      ...{ unsettledAt: null, snoozedAt: null, snoozedUntil: null },
      ...{ messages: [], activities: [], checkpoints: [], proposedPlans: [], pullRequests: [] },
    },
  }),
  threadDeleted: () => ({ kind: "deleted" }),

  threadArchived: (thread, { payload }) =>
    updated(thread, { archivedAt: payload.archivedAt, titleRegeneration: null }, payload.updatedAt),
  threadUnarchived: (thread, { payload }) =>
    updated(thread, { archivedAt: null }, payload.updatedAt),

  threadSettled: (thread, { payload }) =>
    updated(
      thread,
      {
        activeOrderKey: null,
        unsettledAt: null,
        settledAt: payload.settledAt,
        settledOverride: "settled",
      },
      payload.updatedAt,
    ),
  threadUnsettled: (thread, { payload }) =>
    updated(
      thread,
      {
        // A thread already pinned active keeps its re-entry stamp: the activity reset that
        // clears the pin must not reorder the list.
        unsettledAt:
          thread.settledOverride === "active" ? (thread.unsettledAt ?? null) : payload.updatedAt,
        settledAt: null,
        settledOverride: payload.reason === "user" ? "active" : null,
      },
      payload.updatedAt,
    ),

  threadSnoozed: (thread, { payload }) =>
    updated(
      thread,
      { snoozedAt: payload.snoozedAt, snoozedUntil: payload.snoozedUntil },
      payload.updatedAt,
    ),
  threadUnsnoozed: (thread, { payload }) =>
    updated(thread, { snoozedAt: null, snoozedUntil: null }, payload.updatedAt),

  threadPinned: (thread, { payload }) =>
    updated(
      thread,
      { pinnedAt: payload.pinnedAt, ...definedFields(payload, ["pinOrderKey"] as const) },
      payload.updatedAt,
    ),
  threadUnpinned: (thread, { payload }) =>
    updated(thread, { pinnedAt: null, pinOrderKey: null }, payload.updatedAt),
  threadPinReordered: (thread, { payload }) =>
    updated(thread, { pinOrderKey: payload.orderKey }, payload.updatedAt),

  threadMetaUpdated: (thread, { payload }) =>
    updated(thread, definedFields(payload, META_KEYS), payload.updatedAt),

  pullRequestLinked: (thread, { payload }) => {
    const rest = thread.pullRequests.filter(
      (link) => !threadMergeRequestKeysEqual(link, payload.link),
    );
    return withPullRequests(thread, [...rest, payload.link], payload.updatedAt);
  },
  pullRequestUnlinked: (thread, { payload }) =>
    withPullRequests(
      thread,
      thread.pullRequests.filter((link) => !threadMergeRequestKeysEqual(link, payload)),
      payload.updatedAt,
    ),
  pullRequestSynced: (thread, { payload }) => {
    const matches = (link: ThreadMergeRequestLink) => threadMergeRequestKeysEqual(link, payload);
    if (!thread.pullRequests.some(matches)) return UNCHANGED;
    const refreshed = thread.pullRequests.map((link) =>
      matches(link) ? { ...link, snapshot: payload.snapshot, stack: payload.stack } : link,
    );
    return withPullRequests(thread, refreshed, payload.updatedAt);
  },

  threadRuntimeModeSet: (thread, { payload }) =>
    updated(thread, { runtimeMode: payload.runtimeMode }, payload.updatedAt),
  threadInteractionModeSet: (thread, { payload }) =>
    updated(thread, { interactionMode: payload.interactionMode }, payload.updatedAt),
  threadAgentModeSet: (thread, { payload }) =>
    updated(thread, { agentMode: payload.agentMode }, payload.updatedAt),

  turnStartRequested: (thread, { payload, occurredAt }) =>
    updated(
      thread,
      {
        ...definedFields(payload, ["modelSelection"] as const),
        runtimeMode: payload.runtimeMode,
        interactionMode: payload.interactionMode,
      },
      occurredAt,
    ),

  turnInterruptRequested: (thread, { payload, occurredAt }) => {
    const current = thread.latestTurn;
    if (payload.turnId === undefined || current === null || current.turnId !== payload.turnId) {
      return UNCHANGED;
    }
    const latestTurn: ChatLatestTurn = {
      ...current,
      state: "interrupted",
      startedAt: current.startedAt ?? payload.createdAt,
      completedAt: current.completedAt ?? payload.createdAt,
    };
    return updated(thread, { latestTurn }, occurredAt);
  },

  threadMessageSent: (thread, { payload, occurredAt }) => {
    const incoming = messageFromEvent(payload);
    let merged = false;
    const messages = thread.messages.map((stored) => {
      if (stored.id !== incoming.id) return stored;
      merged = true;
      return mergeMessage(stored, incoming);
    });
    if (!merged) messages.push(incoming);

    const isAssistantTurnMessage = payload.role === "assistant" && payload.turnId !== null;
    const previous = thread.latestTurn;
    const sameTurn = previous !== null && previous.turnId === payload.turnId;

    // A finished assistant message settles the turn only once the session stops running it:
    // providers send several assistant messages per turn (commentary between tool calls).
    const sessionStillOnTurn =
      payload.turnId !== null &&
      thread.session?.status === "running" &&
      thread.session.activeTurnId === payload.turnId;
    const settles = !payload.streaming && !sessionStillOnTurn;

    let nextTurn: ChatLatestTurn | null = previous;
    if (isAssistantTurnMessage && (previous === null || sameTurn)) {
      const endState =
        previous?.state === "interrupted" || previous?.state === "error"
          ? previous.state
          : "completed";
      nextTurn = {
        turnId: payload.turnId!,
        state: settles ? endState : "running",
        requestedAt: sameTurn ? previous.requestedAt : payload.createdAt,
        startedAt: sameTurn ? (previous.startedAt ?? payload.createdAt) : payload.createdAt,
        completedAt: settles ? payload.updatedAt : sameTurn ? (previous.completedAt ?? null) : null,
        assistantMessageId: payload.messageId,
      };
    }

    const checkpoints = isAssistantTurnMessage
      ? bindCheckpointMessage(thread.checkpoints, payload.turnId!, payload.messageId)
      : thread.checkpoints;

    return updated(
      thread,
      { messages, checkpoints, latestTurn: keepSameTurn(previous, nextTurn) },
      occurredAt,
    );
  },

  threadSessionSet: (thread, { payload, occurredAt }) => {
    const { session } = payload;
    const previous = thread.latestTurn;
    let nextTurn = previous;

    if (session.status === "running" && session.activeTurnId !== null) {
      const sameTurn = previous?.turnId === session.activeTurnId;
      nextTurn = {
        turnId: session.activeTurnId,
        state: "running",
        requestedAt: sameTurn ? previous!.requestedAt : session.updatedAt,
        startedAt: sameTurn ? (previous!.startedAt ?? session.updatedAt) : session.updatedAt,
        completedAt: null,
        assistantMessageId: sameTurn ? previous!.assistantMessageId : null,
      };
    } else {
      // Leaving "running" is the turn-end signal. A running turn's completedAt can only be a
      // mid-turn checkpoint placeholder, so the session's time is the real end.
      const end = turnEndForSession(session.status);
      if (previous !== null && previous.state === "running" && end !== null) {
        nextTurn = { ...previous, state: end, completedAt: session.updatedAt };
      }
    }

    return updated(thread, { session, latestTurn: keepSameTurn(previous, nextTurn) }, occurredAt);
  },

  sessionStopRequested: (thread, { payload, occurredAt }) => {
    if (thread.session === null) return UNCHANGED;
    const session: ChatSession = {
      ...thread.session,
      updatedAt: payload.createdAt,
      ...{ activeTurnId: null, status: "stopped" as const },
    };
    return updated(thread, { session }, occurredAt);
  },

  proposedPlanUpserted: (thread, { payload, occurredAt }) => {
    const plan = payload.proposedPlan;
    const proposedPlans = Arr.sort(
      [...thread.proposedPlans.filter((entry) => entry.id !== plan.id), plan],
      byCreatedThenId,
    );
    return updated(thread, { proposedPlans }, occurredAt);
  },

  turnDiffCompleted: (thread, { payload, occurredAt }) => {
    const checkpoint: ChatCheckpointSummary = pick(payload, CHECKPOINT_KEYS);
    const prior = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
    // A missing checkpoint never replaces one that exists.
    if (checkpoint.status === "missing" && prior !== undefined && prior.status !== "missing") {
      return UNCHANGED;
    }
    const checkpoints = Arr.sort(
      [...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId), checkpoint],
      byTurnCount,
    );

    // Mid-turn diffs arrive as placeholders: record them, but leave a turn its session is
    // still running unsettled.
    const previous = thread.latestTurn;
    const sessionStillOnTurn =
      thread.session?.status === "running" && thread.session.activeTurnId === payload.turnId;
    const latestTurn: ChatLatestTurn | null =
      sessionStillOnTurn || (previous !== null && previous.turnId !== payload.turnId)
        ? previous
        : {
            turnId: payload.turnId,
            state:
              previous?.state === "interrupted"
                ? "interrupted"
                : turnStateFromCheckpoint(payload.status),
            requestedAt: previous?.requestedAt ?? payload.completedAt,
            startedAt: previous?.startedAt ?? payload.completedAt,
            completedAt: payload.completedAt,
            assistantMessageId: payload.assistantMessageId,
          };
    return updated(thread, { checkpoints, latestTurn }, occurredAt);
  },

  threadReverted: (thread, { payload, occurredAt }) => {
    const { turnCount } = payload;
    const checkpoints = Arr.sort(
      thread.checkpoints.filter(
        (entry) =>
          entry.checkpointTurnCount !== undefined && entry.checkpointTurnCount <= turnCount,
      ),
      byTurnCount,
    );
    const keptTurns = new Set<string>(checkpoints.map((entry) => entry.turnId));
    const inKeptTurn = (entry: { turnId: TurnId | null }) =>
      entry.turnId === null || keptTurns.has(entry.turnId);
    const last = checkpoints.at(-1);
    const latestTurn: ChatLatestTurn | null =
      last === undefined
        ? null
        : {
            turnId: last.turnId,
            state: turnStateFromCheckpoint(last.status as "ready" | "missing" | "error"),
            requestedAt: last.completedAt,
            startedAt: last.completedAt,
            completedAt: last.completedAt,
            assistantMessageId: last.assistantMessageId ?? null,
          };
    return updated(
      thread,
      {
        checkpoints,
        messages: messagesKeptByRevert(thread.messages, keptTurns, turnCount),
        proposedPlans: thread.proposedPlans.filter(inKeptTurn),
        activities: thread.activities.filter(inKeptTurn),
        latestTurn,
      },
      occurredAt,
    );
  },

  threadActivityAppended: (thread, { payload, occurredAt }) => {
    const incoming = payload.activity;
    // A usable context-window reading replaces earlier usable readings of the same turn:
    // consumers only read the newest (walking backwards), and providers stream these
    // continuously, so keeping them all would grow a long thread by thousands of rows.
    // Same rule as the server's dropStaleContextWindowActivities; kept per turn so a revert
    // that drops turns can still find a reading in the surviving ones.
    const replacesReadings = isUsableContextWindow(incoming);

    // Fast path for live, in-order streams on an array this reducer built: append without
    // re-sorting the whole history. The id set moves on to the new array.
    const seen = knownActivityIds.get(thread.activities);
    const tail = thread.activities.at(-1);
    const appendsInOrder =
      seen !== undefined &&
      !seen.has(incoming.id) &&
      (tail === undefined || activityOrder(tail, incoming) <= 0);
    if (!replacesReadings && appendsInOrder) {
      const activities = [...thread.activities, incoming];
      knownActivityIds.delete(thread.activities);
      seen.add(incoming.id);
      knownActivityIds.set(activities, seen);
      return updated(thread, { activities }, occurredAt);
    }

    const superseded = (entry: ChatThreadActivity) =>
      entry.id === incoming.id ||
      (replacesReadings && entry.turnId === incoming.turnId && isUsableContextWindow(entry));
    const activities = Arr.sort(
      [...thread.activities.filter((entry) => !superseded(entry)), incoming],
      activityOrder,
    );
    knownActivityIds.set(activities, new Set(activities.map((entry) => entry.id)));
    return updated(thread, { activities }, occurredAt);
  },

  // Requests the server acts on; the resulting events carry the state change.
  approvalResponseRequested: ignore,
  userInputResponseRequested: ignore,
  checkpointRevertRequested: ignore,
};

/**
 * Apply one chat event to a `ChatThread`: the updated thread, a deletion signal, or
 * "unchanged" when the event does not affect it.
 *
 * Pure, on contract types. UI-side mapping (attachment preview URLs, model slug
 * normalisation, host-scoped fields like `hostId`) is the caller's job.
 */
export function applyThreadDetailEvent(
  thread: ChatThread,
  event: ThreadEvent,
): ThreadDetailReducerResult {
  // Forward compatible: a type this build does not know changes nothing.
  const handle = (handlers as Partial<Record<string, Handler<ThreadEvent["type"]>>>)[event.type];
  return handle === undefined ? UNCHANGED : handle(thread, event as never);
}
