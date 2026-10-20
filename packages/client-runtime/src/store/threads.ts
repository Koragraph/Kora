import {
  type ThreadStreamItem,
  type ThreadId,
  type HostId,
  type DaemonConfig,
  type ChatThreadDetailSnapshot,
  type ChatThreadDetailPage,
  type ChatThread,
  CHAT_METHODS,
} from "@kora/contracts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import { Atom } from "effect/unstable/reactivity";

import { errorLogFields } from "../failures/logFields.ts";
import { linkProjectionPhase } from "../link/model.ts";
import type { HostRegistry } from "../link/registry.ts";
import * as HostSupervisor from "../link/supervisor.ts";
import { LinkWakeups, shouldResubscribeAfterWakeup } from "../link/wakeups.ts";
import { HostCacheStore } from "../embedder/hostCache.ts";
import { subscribeDynamic } from "../wire/client.ts";
import type { RpcSession } from "../wire/session.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { followStreamInHost } from "./runtime.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { THREAD_SNAPSHOT_IDLE_TTL_MS } from "./threadRetention.ts";
import { ThreadSnapshotFetcher } from "./threadSnapshotHttp.ts";
import {
  type HostThreadState,
  type HostThreadPageState,
  EMPTY_HOST_THREAD_STATE,
} from "./threadState.ts";

export const INITIAL_THREAD_USER_TURN_LIMIT = 10;
const OLDER_THREAD_TURN_LIMIT = 20;
const PERSIST_DEBOUNCE = Duration.millis(500);
const RETRY_AFTER = "250 millis";
const DEFECT_RETRY_AFTER = "1 second";
const SYNC_FAILURE_TEXT = "Could not synchronize the thread.";

// ---- Asking a live machine for older turns -------------------------------------------------

type OlderTurnHandlers = Map<string, () => void>;

const sharedOlderTurnHandlers: OlderTurnHandlers = new Map();

class ThreadOlderTurnRequests extends Context.Reference<OlderTurnHandlers>(
  "@kora/client-runtime/state/threads/ThreadOlderTurnRequests",
  { defaultValue: () => sharedOlderTurnHandlers },
) {}

/** Whether a live thread machine exists to take the request. */
export function requestOlderThreadTurns(hostId: HostId, threadId: ThreadId): boolean {
  const handler = sharedOlderTurnHandlers.get(threadKey({ hostId, threadId }));
  if (handler === undefined) return false;
  handler();
  return true;
}

// ---- Resume cache -----------------------------------------------------------------------------

/** What a machine last settled on, kept so remounting a thread can start warm. */
type CommittedThread = Readonly<{
  /** Whether the on-disk copy matches this state. */
  persisted: boolean;
  sequence: number;
  state: HostThreadState;
}>;

type ThreadResumeCache = {
  /** The machine allowed to write `snapshot` and touch the on-disk cache. */
  owner?: object | undefined;
  snapshot?: CommittedThread | undefined;
};

const threadOf = (state: HostThreadState): ChatThread | null => Option.getOrNull(state.data);

const idleStatus = (hasData: boolean): "cached" | "empty" => (hasData ? "cached" : "empty");

/** A remembered state seen again after unmounting: nothing is loading or failing any more. */
const cachedThreadState = (state: HostThreadState): HostThreadState => ({
  data: state.data,
  status:
    state.status === "deleted" || (state.status === "live" && Option.isSome(state.data))
      ? state.status
      : idleStatus(Option.isSome(state.data)),
  error: Option.none(),
  page: Option.map(state.page, (page) => ({ ...page, loadingOlder: false })),
});

const isActive = (thread: ChatThread): boolean =>
  thread.session?.status === "starting" || thread.session?.status === "running";

const pageStateOf = (page: ChatThreadDetailPage | undefined): Option.Option<HostThreadPageState> =>
  page === undefined
    ? Option.none()
    : Option.some({ beforeCursor: page.beforeCursor, hasMore: page.hasMore, loadingOlder: false });

interface PersistRequest {
  readonly sequence: number;
  readonly thread: ChatThread;
  readonly page: { readonly beforeCursor: string | null; readonly hasMore: boolean } | null;
}

const requestOf = (state: HostThreadState, sequence: number): PersistRequest | null => {
  const thread = threadOf(state);
  if (thread === null) return null;
  const page = Option.getOrNull(state.page);
  return {
    sequence,
    thread,
    page: page === null ? null : { beforeCursor: page.beforeCursor, hasMore: page.hasMore },
  };
};

const samePersisted = (committed: CommittedThread, request: PersistRequest): boolean => {
  const mine = requestOf(committed.state, committed.sequence);
  return (
    mine !== null &&
    mine.sequence === request.sequence &&
    mine.thread === request.thread &&
    mine.page?.beforeCursor === request.page?.beforeCursor &&
    mine.page?.hasMore === request.page?.hasMore
  );
};

const snapshotFor = (request: PersistRequest): ChatThreadDetailSnapshot => ({
  seq: request.sequence,
  thread: request.thread,
  ...(request.page === null
    ? {}
    : {
        page: {
          beforeCursor: request.page.beforeCursor,
          hasMore: request.page.hasMore,
          seq: request.sequence,
        },
      }),
});

const idsOf = <T>(rows: readonly T[], key: (row: T) => string): Set<string> =>
  new Set(rows.map(key));

/** Older rows (not already loaded) first, then the loaded rows. */
const prependOlder = <T>(
  older: readonly T[],
  loaded: readonly T[],
  key: (row: T) => string,
): T[] => {
  const have = idsOf(loaded, key);
  return [...older.filter((row) => !have.has(key(row))), ...loaded];
};

const mergeOlderThread = (loaded: ChatThread, older: ChatThread): ChatThread => ({
  ...loaded,
  messages: prependOlder(older.messages, loaded.messages, (row) => row.id),
  activities: prependOlder(older.activities, loaded.activities, (row) => row.id),
  proposedPlans: prependOlder(older.proposedPlans, loaded.proposedPlans, (row) => row.id),
  checkpoints: prependOlder(older.checkpoints, loaded.checkpoints, (row) => row.turnId),
});

// ---- The per-thread machine -------------------------------------------------------------------

type ThreadEventItem = Extract<ThreadStreamItem, { kind: "event" }>;

export const makeHostThreadState = Effect.fn("HostThreadState.make")(function* (
  threadId: ThreadId,
  resumeCache?: ThreadResumeCache,
) {
  const supervisor = yield* HostSupervisor.HostSupervisor;
  const cache = yield* HostCacheStore;
  const snapshotLoader = yield* ThreadSnapshotFetcher;
  const wakeups = yield* Effect.serviceOption(LinkWakeups);
  const olderRequests = yield* ThreadOlderTurnRequests;
  const hostId = supervisor.target.hostId;
  const key = threadKey({ hostId, threadId });

  const token = {};
  if (resumeCache !== undefined) resumeCache.owner = token;
  const isOwner = () => resumeCache === undefined || resumeCache.owner === token;

  // -- Initial state: a warm remount, else whatever is on disk.
  const retained = resumeCache?.snapshot;
  let committed: CommittedThread;
  if (retained !== undefined) {
    committed = {
      state: cachedThreadState(retained.state),
      sequence: retained.sequence,
      persisted: retained.persisted,
    };
  } else {
    const onDisk = yield* cache.loadThread(hostId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not load cached thread.", {
          hostId,
          threadId,
          ...errorLogFields(error),
        }).pipe(Effect.as(Option.none<ChatThreadDetailSnapshot>())),
      ),
    );
    const snapshot = Option.getOrUndefined(onDisk);
    committed = {
      state:
        snapshot === undefined
          ? EMPTY_HOST_THREAD_STATE
          : {
              data: Option.some(snapshot.thread),
              status: "cached",
              error: Option.none(),
              page: pageStateOf(snapshot.page),
            },
      sequence: snapshot?.seq ?? 0,
      persisted: true,
    };
  }

  const state = yield* SubscriptionRef.make<HostThreadState>(committed.state);
  const applyLock = Semaphore.makeUnsafe(1);

  let lastSequence = committed.sequence;
  let historyEpoch = 0;
  let paginationSupported = false;
  let awaitingCompletion = false;
  // The first subscription after a warm live remount keeps showing "live" until something arrives.
  let resumingLive = retained !== undefined && committed.state.status === "live";
  // Bumped by every (re)subscription: a parked page remembers the one it was read under.
  let subscription = 0;
  let parkedOlderPage:
    | {
        readonly snapshot: ChatThreadDetailSnapshot;
        readonly epoch: number;
        readonly subscription: number;
      }
    | undefined;

  const remember = (current: HostThreadState): void => {
    const request = requestOf(current, lastSequence);
    const stillPersisted =
      committed.persisted && request !== null && samePersisted(committed, request);
    committed = { state: current, sequence: lastSequence, persisted: stillPersisted };
    if (resumeCache !== undefined && isOwner()) resumeCache.snapshot = committed;
  };
  const rememberNow = SubscriptionRef.get(state).pipe(Effect.map(remember));
  if (resumeCache !== undefined && isOwner()) resumeCache.snapshot = committed;

  // -- Persistence trails the state: the newest write request goes out after 500 ms of quiet.
  const persist = (request: PersistRequest) =>
    Effect.gen(function* () {
      if (!isOwner()) return;
      if (committed.persisted && samePersisted(committed, request)) return;
      yield* cache.saveThread(hostId, snapshotFor(request)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (!samePersisted(committed, request)) return;
            committed = { ...committed, persisted: true };
            if (resumeCache !== undefined && isOwner()) resumeCache.snapshot = committed;
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("Could not persist the thread cache.", {
            hostId,
            threadId,
            ...errorLogFields(error),
          }),
        ),
      );
    });

  const persistQueue = yield* Queue.sliding<PersistRequest>(1);
  yield* Stream.fromQueue(persistQueue).pipe(
    Stream.debounce(PERSIST_DEBOUNCE),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (!isOwner() || committed.persisted) return;
      const request = requestOf(committed.state, committed.sequence);
      if (request !== null && !isActive(request.thread)) yield* persist(request);
    }),
  );

  const removeFromCache = Effect.gen(function* () {
    if (!isOwner()) return;
    yield* cache.removeThread(hostId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.", {
          hostId,
          threadId,
          ...errorLogFields(error),
        }),
      ),
    );
  });

  // -- State writes. Callers hold `applyLock` where ordering matters.
  const update = (change: (current: HostThreadState) => HostThreadState) =>
    SubscriptionRef.update(state, change);

  const setThread = (thread: ChatThread, page: Option.Option<HostThreadPageState> | "keep") =>
    Effect.gen(function* () {
      yield* update((current) => ({
        data: Option.some(thread),
        // Late values buffered behind a failure must not clear the error.
        status: Option.isSome(current.error)
          ? "cached"
          : awaitingCompletion
            ? "synchronizing"
            : "live",
        error: current.error,
        page: page === "keep" ? current.page : page,
      }));
      if (!isActive(thread)) {
        const current = yield* SubscriptionRef.get(state);
        const request = requestOf(current, lastSequence);
        if (request !== null) Queue.offerUnsafe(persistQueue, request);
      }
    });

  const setDeleted = Effect.gen(function* () {
    awaitingCompletion = false;
    historyEpoch += 1;
    parkedOlderPage = undefined;
    yield* SubscriptionRef.set(state, {
      page: Option.none(),
      error: Option.none(),
      status: "deleted",
      data: Option.none(),
    });
    yield* rememberNow;
    yield* removeFromCache;
  });

  const clearLoadingOlder = update((current) => ({
    ...current,
    page: Option.map(current.page, (page) => ({ ...page, loadingOlder: false })),
  }));

  const mergeOlderPage = (snapshot: ChatThreadDetailSnapshot) =>
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);
      const loaded = threadOf(current);
      if (loaded === null) return;
      yield* setThread(
        mergeOlderThread(loaded, snapshot.thread),
        Option.some({
          beforeCursor: snapshot.page?.beforeCursor ?? null,
          hasMore: snapshot.page?.hasMore ?? false,
          loadingOlder: false,
        }),
      );
    });

  /** A parked older page merges once live events have caught up to the thread watermark. */
  const settleParkedPage = Effect.gen(function* () {
    const parked = parkedOlderPage;
    if (parked === undefined) return;
    if (parked.epoch !== historyEpoch) {
      parkedOlderPage = undefined;
      yield* clearLoadingOlder;
      return;
    }
    const watermark = parked.snapshot.page?.threadSequence;
    if (watermark !== undefined && watermark > lastSequence) return;
    parkedOlderPage = undefined;
    yield* mergeOlderPage(parked.snapshot);
  });

  /** Gives up on a parked page the live feed will not catch up to, so the spinner clears. */
  const dropParkedPage = Effect.gen(function* () {
    if (parkedOlderPage === undefined) return;
    parkedOlderPage = undefined;
    yield* clearLoadingOlder;
  });

  const applyEvent = (item: ThreadEventItem) =>
    Effect.gen(function* () {
      const event = item.event;
      if (event.sequence <= lastSequence) return;
      lastSequence = event.sequence;

      const current = yield* SubscriptionRef.get(state);
      const thread = threadOf(current);
      if (thread === null) {
        if (event.type === "threadDeleted") yield* setDeleted;
        return;
      }
      if (event.type === "threadReverted") historyEpoch += 1;
      const result = applyThreadDetailEvent(thread, event);
      if (result.kind === "updated") yield* setThread(result.thread, "keep");
      else if (result.kind === "deleted") yield* setDeleted;
      yield* settleParkedPage;
    });

  const applyOne = (item: ThreadStreamItem) =>
    Effect.gen(function* () {
      switch (item.kind) {
        case "synchronized": {
          awaitingCompletion = false;
          // Caught up: a page still ahead of the feed now will never settle from events. Only for the subscription
          // the page was read under — after a resubscribe this marker says nothing about it, and its events may follow.
          yield* settleParkedPage;
          if (parkedOlderPage?.subscription === subscription) yield* dropParkedPage;
          yield* update((current) =>
            Option.isSome(current.data) &&
            current.status !== "deleted" &&
            Option.isNone(current.error)
              ? { ...current, status: "live", error: Option.none() }
              : current,
          );
          return;
        }
        case "snapshot": {
          historyEpoch += 1;
          lastSequence = item.snapshot.seq;
          yield* setThread(item.snapshot.thread, pageStateOf(item.snapshot.page));
          yield* settleParkedPage;
          return;
        }
        case "event":
          yield* applyEvent(item);
          return;
      }
    });

  const applyItem = (item: ThreadStreamItem) =>
    applyLock.withPermits(1)(applyOne(item).pipe(Effect.andThen(rememberNow)));

  const applyItems = (items: ReadonlyArray<ThreadStreamItem>) =>
    applyLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        const thread = threadOf(current);
        const plain =
          thread !== null &&
          parkedOlderPage === undefined &&
          items.every(
            (item) =>
              item.kind === "synchronized" ||
              (item.kind === "event" &&
                item.event.type !== "threadReverted" &&
                item.event.type !== "threadDeleted"),
          );

        if (!plain) {
          for (const item of items) yield* applyOne(item);
        } else {
          // Fold the whole batch over one thread value, then write once.
          let folded: ChatThread = thread;
          let reachedSequence = lastSequence;
          let sawSynchronized = false;
          for (const item of items) {
            if (item.kind === "synchronized") {
              sawSynchronized = true;
              continue;
            }
            if (item.kind !== "event" || item.event.sequence <= reachedSequence) continue;
            reachedSequence = item.event.sequence;
            const result = applyThreadDetailEvent(folded, item.event);
            if (result.kind === "updated") folded = result.thread;
          }
          lastSequence = reachedSequence;
          if (folded !== thread) yield* setThread(folded, "keep");
          if (sawSynchronized) yield* applyOne({ kind: "synchronized" });
        }
        yield* rememberNow;
      }),
    );

  // -- Older turns.
  const loadOlderTurns = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    const page = Option.getOrUndefined(current.page);
    if (
      !paginationSupported ||
      page === undefined ||
      !page.hasMore ||
      page.beforeCursor === null ||
      page.loadingOlder
    ) {
      return;
    }
    const prepared = Option.getOrUndefined(yield* SubscriptionRef.get(supervisor.prepared));
    if (prepared === undefined) return;

    const beforeCursor = page.beforeCursor;
    const epoch = historyEpoch;
    yield* update((s) => ({
      ...s,
      page: Option.map(s.page, (p) => ({ ...p, loadingOlder: true })),
    }));

    const fetched = yield* snapshotLoader.load(prepared, threadId, {
      turnLimit: OLDER_THREAD_TURN_LIMIT,
      beforeCursor,
    });

    yield* applyLock.withPermits(1)(
      Effect.gen(function* () {
        const result = Option.getOrUndefined(fetched);
        if (result === undefined || epoch !== historyEpoch || result.seq < lastSequence) {
          yield* clearLoadingOlder;
          return;
        }
        const watermark = result.page?.threadSequence;
        if (watermark !== undefined && watermark > lastSequence) {
          parkedOlderPage = { snapshot: result, epoch, subscription };
          return;
        }
        yield* mergeOlderPage(result);
        yield* rememberNow;
      }),
    );
  });

  const olderQueue = yield* Queue.sliding<void>(1);
  yield* Stream.fromQueue(olderQueue).pipe(
    Stream.runForEach(() => loadOlderTurns),
    Effect.forkScoped,
  );
  const handler = () => {
    Queue.offerUnsafe(olderQueue, undefined);
  };
  olderRequests.set(key, handler);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (olderRequests.get(key) === handler) olderRequests.delete(key);
    }),
  );

  // -- The link decides the status while no feed is flowing.
  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.map(linkProjectionPhase),
    Stream.changes,
    Stream.runForEach((phase) =>
      update((current): HostThreadState => {
        switch (phase) {
          case "synchronizing":
            return current.status === "deleted" || Option.isSome(current.error)
              ? current
              : { ...current, status: "synchronizing" };
          case "ready":
            return current.status === "deleted" ||
              current.status === "live" ||
              Option.isSome(current.error)
              ? current
              : { ...current, status: "synchronizing" };
          case "disconnected":
            awaitingCompletion = false;
            paginationSupported = false;
            return current.status === "deleted"
              ? current
              : { ...current, status: idleStatus(Option.isSome(current.data)) };
        }
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  // -- The subscription.
  const makeInput = (session: RpcSession) =>
    Effect.gen(function* () {
      const config = yield* session.initialConfig.pipe(
        Effect.orElseSucceed(() => ({}) as Partial<DaemonConfig>),
      );
      const supportsMarker = config.threadResumeCompletionMarker === true;
      subscription += 1;
      paginationSupported = config.threadSnapshotPagination === true;
      awaitingCompletion = supportsMarker;

      if (resumingLive) resumingLive = false;
      else {
        yield* update((current) =>
          current.status === "deleted"
            ? current
            : { ...current, status: "synchronizing", error: Option.none() },
        );
      }

      // A windowed copy resumed against a server that cannot page would never reach older turns.
      const before = yield* SubscriptionRef.get(state);
      if (!paginationSupported && Option.isSome(before.page)) {
        historyEpoch += 1;
        lastSequence = 0;
        yield* SubscriptionRef.set(state, {
          page: Option.none(),
          error: Option.none(),
          status: "empty",
          data: Option.none(),
        });
      }

      const current = yield* SubscriptionRef.get(state);
      if (Option.isNone(current.data) && current.status !== "deleted") {
        const prepared = yield* SubscriptionRef.changes(supervisor.prepared).pipe(
          Stream.filter(Option.isSome),
          Stream.runHead,
        );
        const link = Option.flatten(prepared);
        if (Option.isSome(link)) {
          const loaded = paginationSupported
            ? yield* snapshotLoader.load(link.value, threadId, {
                turnLimit: INITIAL_THREAD_USER_TURN_LIMIT,
              })
            : yield* snapshotLoader.load(link.value, threadId);
          if (Option.isSome(loaded)) yield* applyItem({ kind: "snapshot", snapshot: loaded.value });
        }
      }

      const resumed = yield* SubscriptionRef.get(state);
      const hasData = Option.isSome(resumed.data);
      if (!supportsMarker && hasData) {
        yield* update((s) =>
          s.status === "deleted" ? s : { ...s, status: "live", error: Option.none() },
        );
      }
      const request: {
        threadId: typeof threadId;
        afterSequence?: number;
        requestCompletionMarker?: true;
        turnLimit?: number;
      } = { threadId };
      if (paginationSupported) request.turnLimit = INITIAL_THREAD_USER_TURN_LIMIT;
      if (supportsMarker) request.requestCompletionMarker = true;
      if (hasData) request.afterSequence = lastSequence;
      return request;
    });

  const failWith = (message: string) => {
    awaitingCompletion = false;
    return applyLock
      .withPermits(1)(dropParkedPage)
      .pipe(
        Effect.andThen(
          update((current) =>
            current.status === "deleted"
              ? current
              : {
                  ...current,
                  status: idleStatus(Option.isSome(current.data)),
                  error: Option.some(message),
                },
          ),
        ),
      );
  };

  yield* subscribeDynamic(CHAT_METHODS.subscribeThread, makeInput, {
    onDefect: () => failWith(SYNC_FAILURE_TEXT),
    onExpectedFailure: (cause) => {
      const failure: unknown = Option.getOrUndefined(Cause.findErrorOption(cause));
      const message =
        failure instanceof Error && failure.message !== "" ? failure.message : SYNC_FAILURE_TEXT;
      return failWith(message);
    },
    retryExpectedFailureAfter: RETRY_AFTER,
    retryDefectAfter: DEFECT_RETRY_AFTER,
    ...(Option.isSome(wakeups)
      ? { resubscribe: wakeups.value.changes.pipe(Stream.filter(shouldResubscribeAfterWakeup)) }
      : {}),
  }).pipe(
    Stream.runForEachArray((items) =>
      items.length === 1 ? applyItem(items[0]!) : applyItems(items),
    ),
    Effect.forkScoped,
  );

  return state;
});

// ---- Atoms ---------------------------------------------------------------------------------------

export function createHostThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<HostRegistry | HostCacheStore | ThreadSnapshotFetcher | R, E>,
) {
  // Recently viewed threads keep their last state for a while so navigating back is instant.
  const resumeAtom = Atom.family((key: string) =>
    Atom.make((): ThreadResumeCache => ({ snapshot: undefined, owner: undefined })).pipe(
      Atom.setIdleTTL(THREAD_SNAPSHOT_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-resume:${key}`),
    ),
  );

  const liveAtom = Atom.family((key: string) => {
    const { hostId, threadId } = parseThreadKey(key);
    return runtime
      .atom(
        (get) => {
          const resume = get(resumeAtom(key));
          const warm = resume.snapshot;
          return followStreamInHost(
            hostId,
            Stream.unwrap(
              Effect.gen(function* () {
                const machine = yield* makeHostThreadState(threadId, resume);
                const changes = SubscriptionRef.changes(machine);
                return warm === undefined
                  ? changes
                  : Stream.concat(Stream.make(cachedThreadState(warm.state)), changes);
              }),
            ),
          );
        },
        { initialValue: EMPTY_HOST_THREAD_STATE },
      )
      .pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-state:${key}`));
  });

  return {
    stateAtom: (hostId: HostId, threadId: ThreadId) => liveAtom(threadKey({ hostId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./models.ts";
export * from "./promptPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadFeedback.ts";
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./threadState.ts";
