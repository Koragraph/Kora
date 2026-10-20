import type {
  HostThreadRef,
  ChatThreadActivity,
  ChatThread,
  ChatSession,
  ChatPlanProposal,
  ThreadMessage,
  ChatLatestTurn,
  ChatCheckpointSummary,
} from "@kora/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { HostThread, HostThreadShell } from "./models.ts";
import { scopeThread } from "./models.ts";
import { EMPTY_HOST_THREAD_STATE, type HostThreadState } from "./threadState.ts";
import { parseThreadKey, threadKey } from "./entities.ts";

const EMPTY_MESSAGES: ReadonlyArray<ThreadMessage> = Object.freeze([]);
const EMPTY_ACTIVITIES: ReadonlyArray<ChatThreadActivity> = Object.freeze([]);
const EMPTY_PROPOSED_PLANS: ReadonlyArray<ChatPlanProposal> = Object.freeze([]);
const EMPTY_CHECKPOINTS: ReadonlyArray<ChatCheckpointSummary> = Object.freeze([]);

/**
 * Combine detail-only collections with the shell's authoritative thread metadata.
 *
 * Shell and detail subscriptions are intentionally independent. A cached detail can
 * therefore briefly outlive a newer shell snapshot after reconnecting. Workspace
 * consumers must use the shell branch/worktree/project fields so they do not target
 * a stale checkout while retaining messages, activities, plans, and checkpoints
 * from the detail subscription.
 */
/** The thread metadata the shell owns; everything else on the detail comes from the detail. */
const SHELL_OWNED = [
  "session",
  "pinOrderKey",
  "pinnedAt",
  "snoozedAt",
  "snoozedUntil",
  "activeOrderKey",
  "unsettledAt",
  "settledAt",
  "settledOverride",
  "archivedAt",
  "updatedAt",
  "createdAt",
  "latestTurn",
  "worktreePath",
  "branch",
  "agentMode",
  "interactionMode",
  "runtimeMode",
  "modelSelection",
  "title",
  "projectId",
  "id",
  "hostId",
] as const satisfies ReadonlyArray<keyof HostThreadShell & keyof HostThread>;

export function mergeHostThread(
  detail: HostThread | null,
  shell: HostThreadShell | null,
): HostThread | null {
  const sameThread =
    detail !== null && shell !== null && detail.id === shell.id && detail.hostId === shell.hostId;
  if (!sameThread) return detail;
  const merged: Record<string, unknown> = { ...detail };
  for (const field of SHELL_OWNED) merged[field] = shell[field];
  return merged as unknown as HostThread;
}

export function createHostThreadDetailAtoms<E>(
  threadStateAtom: (
    hostId: HostThreadRef["hostId"],
    threadId: HostThreadRef["threadId"],
  ) => Atom.Atom<AsyncResult.AsyncResult<HostThreadState, E>>,
) {
  /** A short-lived keyed atom labelled `environment-thread-<name>:<key>`. */
  const keyed = <A>(name: string, read: (key: string) => (get: Atom.AtomContext) => A) =>
    Atom.family((key: string) =>
      Atom.make(read(key)).pipe(
        Atom.withLabel(`environment-thread-${name}:${key}`),
        Atom.setIdleTTL(0),
      ),
    );

  const stateFamily = keyed("state-value", (key) => {
    const { hostId, threadId } = parseThreadKey(key);
    const source = threadStateAtom(hostId, threadId);
    return (get) => {
      const loaded = AsyncResult.value(get(source));
      return Option.isSome(loaded) ? loaded.value : EMPTY_HOST_THREAD_STATE;
    };
  });

  // Re-scoping is memoised on the source thread so an unchanged thread keeps its identity.
  const detailFamily = keyed("detail", (key) => {
    const { hostId } = parseThreadKey(key);
    const memo: { source: ChatThread | null; value: HostThread | null } = {
      source: null,
      value: null,
    };
    return (get) => {
      const source = Option.getOrNull(get(stateFamily(key)).data);
      if (memo.source !== source) {
        memo.value = source && scopeThread(hostId, source);
        memo.source = source;
      }
      return memo.value;
    };
  });

  const fromState = <A>(name: string, pickFrom: (state: HostThreadState) => A) =>
    keyed(name, (key) => (get) => pickFrom(get(stateFamily(key))));
  const fromDetail = <A>(
    name: string,
    pickFrom: (thread: HostThread) => A | undefined,
    fallback: A,
  ) =>
    keyed(name, (key) => (get): A => {
      const thread = get(detailFamily(key));
      return (thread === null ? undefined : pickFrom(thread)) ?? fallback;
    });

  const statusFamily = fromState("status", (state) => state.status);
  const errorFamily = fromState("error", (state) => Option.getOrNull(state.error));
  const latestTurnFamily = fromDetail<ChatLatestTurn | null>(
    "latest-turn",
    (t) => t.latestTurn,
    null,
  );
  const sessionFamily = fromDetail<ChatSession | null>("session", (t) => t.session, null);
  const checkpointsFamily = fromDetail<ReadonlyArray<ChatCheckpointSummary>>(
    "checkpoints",
    (t) => t.checkpoints,
    EMPTY_CHECKPOINTS,
  );
  const plansFamily = fromDetail<ReadonlyArray<ChatPlanProposal>>(
    "proposed-plans",
    (t) => t.proposedPlans,
    EMPTY_PROPOSED_PLANS,
  );
  const activitiesFamily = fromDetail<ReadonlyArray<ChatThreadActivity>>(
    "activities",
    (t) => t.activities,
    EMPTY_ACTIVITIES,
  );
  const messagesFamily = fromDetail<ReadonlyArray<ThreadMessage>>(
    "messages",
    (t) => t.messages,
    EMPTY_MESSAGES,
  );

  const byRef =
    <A>(family: (key: string) => A) =>
    (ref: HostThreadRef) =>
      family(threadKey(ref));

  return {
    latestTurnAtom: byRef(latestTurnFamily),
    sessionAtom: byRef(sessionFamily),
    checkpointsAtom: byRef(checkpointsFamily),
    proposedPlansAtom: byRef(plansFamily),
    activitiesAtom: byRef(activitiesFamily),
    messagesAtom: byRef(messagesFamily),
    errorAtom: byRef(errorFamily),
    statusAtom: byRef(statusFamily),
    detailAtom: byRef(detailFamily),
    stateAtom: byRef(stateFamily),
  };
}
