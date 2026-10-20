import { RPC_METHODS, type WorkerFeedItem, type WorkerFeedStreamEvent } from "@kora/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import {
  createHostRpcCommand,
  createHostRpcQueryAtomFamily,
  createHostRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { HostRegistry } from "../link/registry.ts";
import type { HostSubscriptionRpcTag, SubscriptionOptions } from "../wire/client.ts";

/**
 * Fleet feeds must outlive a failed or crashed subscription: keep the last value on screen and
 * re-subscribe with backoff instead of leaving the grid broken until the atom unmounts.
 */
const durableFleetSubscription = <T extends HostSubscriptionRpcTag>(
  method: T,
): SubscriptionOptions<T> => ({
  onExpectedFailure: (cause) =>
    Effect.logWarning("Fleet subscription failed; retrying.", {
      method,
      cause: Cause.pretty(cause),
    }),
  retryExpectedFailureAfter: "1 second",
  retryDefectAfter: "1 second",
});

/**
 * Fleet atoms: the orchestrator thread's live worker roster (a snapshot-only stream) and the
 * human actions on it (steer a worker as the human, kill it, graph-verify / merge its worktree).
 * Worker terminals themselves ride the ordinary terminal atoms (`terminal.attach` on
 * `worker:<paneId>`); a GUI worker's box body rides `workerFeed` (`fleet.subscribeWorker`).
 */
export function createFleetHostAtoms<R, E>(runtime: Atom.AtomRuntime<HostRegistry | R, E>) {
  return {
    snapshot: createHostRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:fleet:snapshot",
      tag: RPC_METHODS.fleetSubscribe,
      idleTtlMs: 60_000,
      subscription: durableFleetSubscription(RPC_METHODS.fleetSubscribe),
    }),
    steer: createHostRpcCommand(runtime, {
      label: "environment-data:fleet:steer",
      tag: RPC_METHODS.fleetSteer,
    }),
    kill: createHostRpcCommand(runtime, {
      label: "environment-data:fleet:kill",
      tag: RPC_METHODS.fleetKill,
    }),
    /** Swarm worker: stop this attempt and restart the same task on a different model. */
    retry: createHostRpcCommand(runtime, {
      label: "environment-data:fleet:retry",
      tag: RPC_METHODS.fleetRetry,
    }),
    /** Swarm worker: postpone the watchdog's nudge/reassign deadlines by N minutes. */
    extend: createHostRpcCommand(runtime, {
      label: "environment-data:fleet:extend",
      tag: RPC_METHODS.fleetExtend,
    }),
    mergeVerify: createHostRpcCommand(runtime, {
      label: "environment-data:fleet:merge-verify",
      tag: RPC_METHODS.fleetMergeVerify,
    }),
    merge: createHostRpcCommand(runtime, {
      label: "environment-data:fleet:merge",
      tag: RPC_METHODS.fleetMerge,
    }),
    /** One worker's activity feed, folded to its items (oldest first). */
    workerFeed: createHostRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:fleet:worker-feed",
      tag: RPC_METHODS.fleetSubscribeWorker,
      idleTtlMs: 30_000,
      subscription: durableFleetSubscription(RPC_METHODS.fleetSubscribeWorker),
      // The fold starts from an empty feed on every (re)subscription; the daemon re-sends a snapshot first.
      transform: (stream) =>
        Stream.suspend(() =>
          stream.pipe(
            Stream.scan(
              EMPTY_WORKER_FEED as ReadonlyArray<WorkerFeedItem>,
              applyWorkerFeedStreamEvent,
            ),
          ),
        ),
    }),
    /** Answer a GUI worker's open approval from its box. */
    respondApproval: createHostRpcCommand(runtime, {
      label: "environment-data:fleet:respond-approval",
      tag: RPC_METHODS.fleetRespondApproval,
    }),
    /** A swarm worker's report text (`fleet.readReport`); refresh to re-read after the report changes. */
    readReport: createHostRpcQueryAtomFamily(runtime, {
      label: "environment-data:fleet:read-report",
      tag: RPC_METHODS.fleetReadReport,
    }),
  };
}

const EMPTY_WORKER_FEED: ReadonlyArray<WorkerFeedItem> = [];

/**
 * Folds `fleet.subscribeWorker` events: a snapshot replaces the feed, an upsert replaces the item with the same id in
 * place (a streaming message or a running tool keeps its position) or appends a new one.
 */
export function applyWorkerFeedStreamEvent(
  items: ReadonlyArray<WorkerFeedItem>,
  event: WorkerFeedStreamEvent,
): ReadonlyArray<WorkerFeedItem> {
  if (event.type === "snapshot") return event.items;
  // Search from the end: the item being re-sent is almost always one of the last few.
  const index = items.findLastIndex((item) => item.id === event.item.id);
  if (index === -1) return [...items, event.item];
  const next = items.slice();
  next[index] = event.item;
  return next;
}
