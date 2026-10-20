import { describe, expect, it } from "@effect/vitest";
import {
  AgentProfileId,
  CHAT_METHODS,
  EventId,
  HostId,
  ProjectId,
  ThreadId,
  TurnId,
  type ChatThread,
  type ChatThreadDetailSnapshot,
  type ThreadStreamItem,
} from "@kora/contracts";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_LINK_STATE,
  LocalLinkTarget,
  type PreparedLink,
  type SupervisorLinkState,
} from "../link/model.ts";
import * as HostSupervisor from "../link/supervisor.ts";
import * as LinkWakeups from "../link/wakeups.ts";
import * as Persistence from "../embedder/hostCache.ts";
import type { KoraRpcClient } from "../wire/protocol.ts";
import * as RpcSession from "../wire/session.ts";
import {
  EMPTY_HOST_THREAD_STATE,
  makeHostThreadState,
  ThreadSnapshotFetcher,
  type HostThreadState,
} from "./threads.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TARGET = new LocalLinkTarget({
  wsBaseUrl: "wss://threads-host.test",
  httpBaseUrl: "https://threads-host.test",
  label: "Env under test",
  hostId: HostId.make("environment-1"),
});
const THREAD_ID = ThreadId.make("thread-a");
const CACHED_SEQ = 7;
const PREPARED: PreparedLink = {
  target: TARGET,
  httpAuthorization: null,
  socketUrl: TARGET.wsBaseUrl,
  httpBaseUrl: TARGET.httpBaseUrl,
  label: TARGET.label,
  hostId: TARGET.hostId,
};

const T0 = "2026-05-02T00:00:00.000Z";
const T1 = "2026-05-02T00:01:00.000Z";

const BASE_THREAD: ChatThread = {
  ...{ archivedAt: null, deletedAt: null, settledAt: null, settledOverride: null },
  ...{ latestTurn: null, session: null, worktreePath: null },
  ...{ activities: [], checkpoints: [], messages: [], proposedPlans: [], pullRequests: [] },
  updatedAt: T0,
  createdAt: T0,
  branch: "main",
  agentMode: "chat",
  interactionMode: "default",
  runtimeMode: "full-access",
  modelSelection: { model: "gpt-5.5", instanceId: AgentProfileId.make("codex") },
  title: "Warm thread",
  projectId: ProjectId.make("project-a"),
  id: THREAD_ID,
};

const TURN_A = TurnId.make("turn-a");
const RUNNING_THREAD: ChatThread = {
  ...BASE_THREAD,
  session: {
    updatedAt: T1,
    lastError: null,
    activeTurnId: TURN_A,
    providerName: "codex",
    runtimeMode: "full-access",
    status: "running",
    threadId: THREAD_ID,
  },
  latestTurn: {
    assistantMessageId: null,
    completedAt: null,
    startedAt: T1,
    requestedAt: T1,
    state: "running",
    turnId: TURN_A,
  },
};

type Frame = ThreadStreamItem | Error;
type ResumeCache = NonNullable<Parameters<typeof makeHostThreadState>[1]>;

const freshResumeCache = (): ResumeCache => ({ snapshot: undefined, owner: undefined });

const sessionOver = (
  client: KoraRpcClient,
  options?: { readonly completionMarker?: boolean },
): RpcSession.RpcSession => {
  const config = options?.completionMarker === true ? { threadResumeCompletionMarker: true } : {};
  return {
    closed: Effect.never,
    probe: Effect.void,
    ready: Effect.void,
    subscribeDaemonConfig: (input) => client.subscribeDaemonConfig(input),
    initialConfig: Effect.succeed(config as never),
    client,
  };
};

const nextWhere = (
  observed: Queue.Queue<HostThreadState>,
  predicate: (s: HostThreadState) => boolean,
) => Queue.take(observed).pipe(Effect.repeat({ until: predicate }));

const hasTitle = (title: string) => (state: HostThreadState) =>
  Option.getOrNull(state.data)?.title === title;

const liveWithTitle = (title: string) => (state: HostThreadState) =>
  state.status === "live" && hasTitle(title)(state);

const isLive = (state: HostThreadState) => state.status === "live";

// ---------------------------------------------------------------------------
// Harness: a thread state wired to scripted stream / cache / HTTP fakes
// ---------------------------------------------------------------------------

type HarnessOptions = Partial<{
  readonly saveThread: Persistence.HostCacheStore["Service"]["saveThread"];
  readonly loadCached: Effect.Effect<Option.Option<ChatThreadDetailSnapshot>>;
  readonly resumeCache: ResumeCache;
  readonly completionMarker: boolean;
  readonly httpSnapshot: Option.Option<ChatThreadDetailSnapshot>;
  readonly cached: ChatThread;
}>;

const counter = () => Ref.make(0);
const bump = (ref: Ref.Ref<number>) => Ref.update(ref, (n) => n + 1);
const append = <A>(ref: Ref.Ref<ReadonlyArray<A>>, item: A) =>
  Ref.update(ref, (list) => list.concat([item]));

const makeHarness = Effect.fn("TestHostThreads.makeHarness")(function* (
  options: HarnessOptions = {},
) {
  const [inputs, observed, wakeups] = [
    yield* Queue.unbounded<Frame>(),
    yield* Queue.unbounded<HostThreadState>(),
    yield* Queue.unbounded<LinkWakeups.LinkWakeup>(),
  ];
  const [retryCount, subscriptionCount, loaderCalls] = yield* Effect.all([
    counter(),
    counter(),
    counter(),
  ]);
  const latest = yield* Ref.make<HostThreadState>(EMPTY_HOST_THREAD_STATE);
  const lastSubscribeAfterSequence = yield* Ref.make<number | undefined>(undefined);
  const lastRequestCompletionMarker = yield* Ref.make<boolean | undefined>(undefined);
  const savedThreads = yield* Ref.make<ReadonlyArray<ChatThreadDetailSnapshot>>([]);
  const removedThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const supervisorState = yield* SubscriptionRef.make<SupervisorLinkState>(AVAILABLE_LINK_STATE);

  // An Error pushed into `inputs` fails the stream at that point.
  const frames = Stream.mapEffect(Stream.fromQueue(inputs), (frame) =>
    frame instanceof Error ? Effect.fail(frame) : Effect.succeed(frame),
  );
  type SubscribeInput = Readonly<{ afterSequence?: number; requestCompletionMarker?: boolean }>;
  const recordSubscribe = (input: SubscribeInput) =>
    Effect.all([
      bump(subscriptionCount),
      Ref.set(lastSubscribeAfterSequence, input.afterSequence),
      Ref.set(lastRequestCompletionMarker, input.requestCompletionMarker),
    ]);
  const client = {
    [CHAT_METHODS.subscribeThread]: (input: SubscribeInput) =>
      Stream.unwrap(Effect.as(recordSubscribe(input), frames)),
  } as unknown as KoraRpcClient;

  const freshSession = () =>
    sessionOver(client, options.completionMarker === true ? { completionMarker: true } : undefined);
  const supervisorSession = yield* SubscriptionRef.make(Option.some(freshSession()));
  const prepared = yield* SubscriptionRef.make(Option.some(PREPARED));

  const ours = (threadId: ThreadId) => threadId === THREAD_ID;
  const snapshotLoader = ThreadSnapshotFetcher.of({
    load: (_prepared, threadId) => {
      const found = ours(threadId) ? options.httpSnapshot : undefined;
      return Effect.as(bump(loaderCalls), found ?? Option.none<ChatThreadDetailSnapshot>());
    },
  });
  const supervisorService: HostSupervisor.HostSupervisor["Service"] = {
    retryNow: bump(retryCount),
    disconnect: Effect.void,
    connect: Effect.void,
    prepared,
    session: supervisorSession,
    state: supervisorState,
    target: TARGET,
  };
  const supervisor = HostSupervisor.HostSupervisor.of(supervisorService);

  const cachedSnapshot = (threadId: ThreadId) =>
    ours(threadId) && options.cached !== undefined
      ? Option.some({ thread: options.cached, seq: CACHED_SEQ })
      : Option.none();
  const nothing = () => Effect.void;
  const cache = Persistence.HostCacheStore.of({
    clear: nothing,
    saveDaemonConfig: nothing,
    loadDaemonConfig: () => Effect.succeed(Option.none()),
    removeThread: (_hostId, threadId) => append(removedThreads, threadId),
    saveThread: (hostId, thread) =>
      Effect.andThen(
        append(savedThreads, thread),
        options.saveThread?.(hostId, thread) ?? Effect.void,
      ),
    loadThread: (_hostId, threadId) =>
      options.loadCached ?? Effect.succeed(cachedSnapshot(threadId)),
    saveShell: nothing,
    loadShell: () => Effect.succeed(Option.none()),
  });

  const wakeService = LinkWakeups.LinkWakeups.of({ changes: Stream.fromQueue(wakeups) });
  const threadState = yield* makeHostThreadState(THREAD_ID, options.resumeCache).pipe(
    Effect.provideService(LinkWakeups.LinkWakeups, wakeService),
    Effect.provideService(ThreadSnapshotFetcher, snapshotLoader),
    Effect.provideService(Persistence.HostCacheStore, cache),
    Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
  );
  yield* Effect.forkScoped(
    Stream.runForEach(SubscriptionRef.changes(threadState), (state) =>
      Effect.andThen(Ref.set(latest, state), Queue.offer(observed, state)),
    ),
  );

  /** Yields until the client has been subscribed to `count` times (bounded). */
  const awaitSubscriptions = (count: number, polls = 100) =>
    Effect.gen(function* () {
      for (let left = polls; left > 0; left -= 1) {
        if ((yield* Ref.get(subscriptionCount)) >= count) return;
        yield* Effect.yieldNow;
      }
    });

  return {
    replaceSession: SubscriptionRef.set(supervisorSession, Option.some(freshSession())),
    awaitSubscriptions,
    wakeups,
    removedThreads,
    savedThreads,
    supervisorSession,
    supervisorState,
    lastRequestCompletionMarker,
    lastSubscribeAfterSequence,
    loaderCalls,
    subscriptionCount,
    retryCount,
    latest,
    observed,
    inputs,
    threadState,
  };
});

// ---------------------------------------------------------------------------
// Stream frames
// ---------------------------------------------------------------------------

const snapshotFrame = (thread: ChatThread): ThreadStreamItem => ({
  kind: "snapshot",
  snapshot: { seq: 1, thread },
});

const synchronizedFrame = (): ThreadStreamItem => ({ kind: "synchronized" });

/** A thread event envelope at `sequence`, stamped at `occurredAt`. */
const eventFrame = (
  eventId: string,
  sequence: number,
  occurredAt: string,
  rest: { readonly type: string; readonly payload: object },
): ThreadStreamItem =>
  ({
    event: {
      ...rest,
      aggregateId: THREAD_ID,
      aggregateKind: "thread",
      metadata: {},
      correlationId: null,
      causationEventId: null,
      commandId: null,
      occurredAt,
      sequence,
      eventId: EventId.make(eventId),
    },
    kind: "event",
  }) as ThreadStreamItem;

const titleFrame = (title: string, sequence = 2): ThreadStreamItem => {
  const when = "2026-05-02T01:00:00.000Z";
  return eventFrame("evt-title", sequence, when, {
    payload: { updatedAt: when, title, threadId: THREAD_ID },
    type: "threadMetaUpdated",
  });
};

const deletedFrame = (sequence = 3): ThreadStreamItem => {
  const when = "2026-05-02T02:00:00.000Z";
  return eventFrame("evt-deleted", sequence, when, {
    payload: { deletedAt: when, threadId: THREAD_ID },
    type: "threadDeleted",
  });
};

const linkStateOf = (patch: Partial<SupervisorLinkState>): SupervisorLinkState => ({
  ...{ retryAt: null, lastFailure: null, stage: null },
  generation: 1,
  attempt: 1,
  phase: "connected",
  network: "online",
  desired: true,
  ...patch,
});

/** Runs the generator in its own scope, closed when it returns. */
const inScope = <Eff extends Effect.Effect<any, any, any>, A>(
  body: () => Generator<Eff, A, never>,
) => Effect.scoped(Effect.gen(body));

/** A scope the test closes by hand; it is also closed when the test ends. */
const manualScope = Effect.gen(function* () {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  return scope;
});

const storageFailure = () =>
  new Persistence.LinkPersistenceError({
    message: "Test storage failure",
    operation: "save-thread",
  });

const settleBriefly = Effect.gen(function* () {
  for (let tick = 0; tick < 10; tick += 1) yield* Effect.yieldNow;
});

// ---------------------------------------------------------------------------

describe("HostThreads", () => {
  describe("cache persistence", () => {
    for (const origin of ["disk", "HTTP"] as const) {
      it.effect(
        `skips rewriting an unchanged ${origin} snapshot on navigation or warm return`,
        () =>
          Effect.gen(function* () {
            const resumeCache = freshResumeCache();
            const firstSaves = yield* inScope(function* () {
              const h = yield* makeHarness({
                resumeCache,
                ...(origin === "disk"
                  ? { cached: BASE_THREAD }
                  : { httpSnapshot: Option.some({ seq: 7, thread: BASE_THREAD }) }),
              });
              yield* nextWhere(h.observed, isLive);
              if (origin === "HTTP") yield* TestClock.adjust("500 millis");
              return h.savedThreads;
            });
            expect(yield* Ref.get(firstSaves)).toHaveLength(origin === "disk" ? 0 : 1);

            const secondSaves = yield* inScope(function* () {
              const h = yield* makeHarness({ resumeCache });
              yield* nextWhere(h.observed, isLive);
              return h.savedThreads;
            });
            expect(yield* Ref.get(secondSaves)).toEqual([]);
          }),
      );
    }

    it.effect("tries a failed background cache write again as the scope closes", () =>
      Effect.gen(function* () {
        let writes = 0;
        yield* inScope(function* () {
          const h = yield* makeHarness({
            httpSnapshot: Option.some({ seq: 7, thread: BASE_THREAD }),
            saveThread: () =>
              Effect.suspend(() => {
                writes += 1;
                // Only the first write fails.
                return writes > 1 ? Effect.void : Effect.fail(storageFailure());
              }),
          });
          yield* nextWhere(h.observed, isLive);
          yield* TestClock.adjust("500 millis");
          expect(writes).toBe(1);
        });
        expect(writes).toBe(2);
      }),
    );

    it.effect("writes the newer data once an older background write finishes", () =>
      Effect.gen(function* () {
        const olderStarted = yield* Deferred.make<void>();
        const olderDone = yield* Deferred.make<void>();
        const letOlderFinish = yield* Deferred.make<void>();
        const saved = yield* inScope(function* () {
          const h = yield* makeHarness({
            cached: BASE_THREAD,
            saveThread: (_hostId, snapshot) =>
              snapshot.seq === 8
                ? Deferred.succeed(olderStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(letOlderFinish)),
                    Effect.andThen(Deferred.succeed(olderDone, undefined)),
                  )
                : Effect.void,
          });
          yield* Queue.offer(h.inputs, titleFrame("First update", 8));
          yield* nextWhere(h.observed, hasTitle("First update"));
          yield* TestClock.adjust("500 millis");
          yield* Deferred.await(olderStarted);
          yield* Queue.offer(h.inputs, titleFrame("Newer update", 9));
          yield* nextWhere(h.observed, hasTitle("Newer update"));
          yield* Deferred.succeed(letOlderFinish, undefined);
          yield* Deferred.await(olderDone);
          return h.savedThreads;
        });

        expect((yield* Ref.get(saved)).map((s) => [s.seq, s.thread.title])).toEqual([
          [8, "First update"],
          [9, "Newer update"],
        ]);
      }),
    );

    it.effect("does not persist snapshots of a running thread while streaming or at teardown", () =>
      Effect.gen(function* () {
        const saves = yield* inScope(function* () {
          const h = yield* makeHarness({ cached: RUNNING_THREAD });
          yield* nextWhere(
            h.observed,
            (state) =>
              isLive(state) &&
              Option.isSome(state.data) &&
              state.data.value.session?.status === "running",
          );

          yield* TestClock.adjust("500 millis");
          yield* Effect.yieldNow;

          expect(yield* Ref.get(h.savedThreads)).toEqual([]);
          return h.savedThreads;
        });

        expect(yield* Ref.get(saves)).toEqual([]);
      }),
    );
  });

  describe("successor scopes sharing a resume cache", () => {
    it.effect("does not resume beyond a cancelled event whose data never landed", () =>
      Effect.gen(function* () {
        const resumeCache = freshResumeCache();
        const firstScope = yield* manualScope;
        const first = yield* makeHarness({
          httpSnapshot: Option.some({ thread: BASE_THREAD, seq: CACHED_SEQ }),
          resumeCache,
        }).pipe(Effect.provideService(Scope.Scope, firstScope));
        yield* nextWhere(first.observed, isLive);

        const titleRead = yield* Deferred.make<void>();
        const frame = titleFrame("Not applied", 8);
        if (frame.kind !== "event") return yield* Effect.die("Expected an event");
        // A getter tells the test the moment the reducer looks at the title.
        const payload = frame.event.payload as { title?: string };
        Object.defineProperty(payload, "title", {
          get() {
            Deferred.doneUnsafe(titleRead, Exit.void);
            return "Not applied";
          },
        });
        // The reducer reads the title after advancing the cursor. Holding just the
        // data write means closing the scope interrupts exactly that interval.
        const lock = first.threadState.semaphore;
        yield* Effect.andThen(lock.take(1), Queue.offer(first.inputs, frame));
        yield* Deferred.await(titleRead);
        yield* Scope.close(firstScope, Exit.void);
        yield* first.threadState.semaphore.release(1);

        const resumed = yield* makeHarness({ resumeCache });
        const state = yield* nextWhere(resumed.observed, isLive);
        expect(Option.getOrThrow(state.data).title).toBe(BASE_THREAD.title);
        expect(yield* Ref.get(resumed.lastSubscribeAfterSequence)).toBe(CACHED_SEQ);
        expect(yield* Ref.get(first.savedThreads)).toEqual([
          { thread: BASE_THREAD, seq: CACHED_SEQ },
        ]);
      }),
    );

    it.effect("keeps an expired scope from overwriting what its successor cached", () =>
      Effect.gen(function* () {
        const resumeCache = freshResumeCache();
        const oldScope = yield* manualScope;
        const old = yield* Effect.provideService(
          makeHarness({ resumeCache, cached: BASE_THREAD }),
          Scope.Scope,
          oldScope,
        );
        yield* nextWhere(old.observed, isLive);
        const successor = yield* makeHarness({ resumeCache });
        yield* Queue.offer(successor.inputs, titleFrame("Successor title", 9));
        yield* nextWhere(successor.observed, hasTitle("Successor title"));
        yield* Queue.offer(old.inputs, titleFrame("Old scope title", 8));
        yield* nextWhere(old.observed, hasTitle("Old scope title"));
        yield* Scope.close(oldScope, Exit.void);

        expect(yield* Ref.get(old.savedThreads)).toHaveLength(0);
        const kept = resumeCache.snapshot;
        expect(kept && [kept.sequence, Option.getOrThrow(kept.state.data).title]).toEqual([
          9,
          "Successor title",
        ]);
      }),
    );

    it.effect("ignores a slow disk read that completes after the successor has initialised", () =>
      Effect.gen(function* () {
        const resumeCache = freshResumeCache();
        const readStarted = yield* Deferred.make<void>();
        const readResult = yield* Deferred.make<Option.Option<ChatThreadDetailSnapshot>>();
        const slowStart = yield* makeHarness({
          resumeCache,
          loadCached: Deferred.succeed(readStarted, undefined).pipe(
            Effect.andThen(Deferred.await(readResult)),
          ),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(readStarted);
        const successor = yield* makeHarness({ cached: BASE_THREAD, resumeCache });
        yield* nextWhere(successor.observed, isLive);
        yield* Deferred.succeed(
          readResult,
          Option.some({ seq: 3, thread: { ...BASE_THREAD, title: "Old disk data" } }),
        );
        const slow = yield* Fiber.join(slowStart);
        yield* nextWhere(slow.observed, isLive);

        expect(resumeCache.snapshot?.sequence).toBe(CACHED_SEQ);
        expect(Option.getOrThrow(resumeCache.snapshot!.state.data).title).toBe(BASE_THREAD.title);
      }),
    );

    it.effect("stops an old scope's deletion from erasing its successor's persisted cache", () =>
      Effect.gen(function* () {
        const resumeCache = freshResumeCache();
        const old = yield* makeHarness({ cached: BASE_THREAD, resumeCache });
        yield* nextWhere(old.observed, isLive);
        const successor = yield* makeHarness({ resumeCache });
        yield* Queue.offer(successor.inputs, titleFrame("Successor title", 9));
        yield* nextWhere(successor.observed, hasTitle("Successor title"));
        yield* Queue.offer(old.inputs, deletedFrame(8));
        yield* nextWhere(old.observed, (state) => state.status === "deleted");

        expect(resumeCache.snapshot?.sequence).toBe(9);
        expect(yield* Ref.get(old.removedThreads)).toEqual([]);
      }),
    );

    it.effect("remembers a deletion rather than bringing back the old disk snapshot", () =>
      Effect.gen(function* () {
        const resumeCache = freshResumeCache();
        yield* inScope(function* () {
          const first = yield* makeHarness({ cached: BASE_THREAD, resumeCache });
          yield* Queue.offer(first.inputs, deletedFrame(8));
          yield* nextWhere(first.observed, (state) => state.status === "deleted");
        });

        const resumed = yield* makeHarness({ cached: BASE_THREAD, resumeCache });
        const state = yield* nextWhere(resumed.observed, (s) => s.status === "deleted");

        expect(Option.isNone(state.data)).toBe(true);
        expect(yield* Ref.get(resumed.loaderCalls)).toBe(0);
      }),
    );
  });

  describe("loading", () => {
    it.effect("shows warm-cache data straight away", () =>
      Effect.gen(function* () {
        const { observed } = yield* makeHarness({ cached: BASE_THREAD });
        const first = yield* nextWhere(observed, ({ data }) => Option.isSome(data));

        expect({ data: first.data, error: first.error }).toEqual({
          error: Option.none(),
          data: Option.some(BASE_THREAD),
        });
      }),
    );

    it.effect("resumes from a warm cache with afterSequence and no HTTP fetch", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ cached: BASE_THREAD });

        // The warm cache reaches live from the cached data, and a live event
        // applies on top of it.
        yield* Queue.offer(harness.inputs, titleFrame("Fresh title", CACHED_SEQ + 1));
        yield* nextWhere(harness.observed, liveWithTitle("Fresh title"));

        // The subscription picked up at the cached sequence and never pulled the
        // full snapshot over HTTP.
        expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SEQ);
        expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
      }),
    );

    it.effect("seeds from the HTTP snapshot, then applies live events", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          httpSnapshot: Option.some({ seq: 1, thread: { ...BASE_THREAD, title: "HTTP title" } }),
        });
        // No socket snapshot arrives, only a live event. It can only be applied
        // if the HTTP snapshot already seeded the thread.
        yield* Queue.offer(harness.inputs, titleFrame("Fresh title", 2));

        const state = yield* nextWhere(harness.observed, liveWithTitle("Fresh title"));

        expect(Option.getOrThrow(state.data).title).toBe("Fresh title");
        // Cold cache: the full snapshot came over HTTP and the socket resumed from
        // that snapshot's sequence.
        expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
        expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(1);
      }),
    );
  });

  describe("live events", () => {
    it.effect("applies live events and saves the newest thread", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ cached: BASE_THREAD });
        yield* Queue.offer(harness.inputs, snapshotFrame(BASE_THREAD));
        yield* Queue.offer(harness.inputs, titleFrame("Fresh title"));

        const state = yield* nextWhere(harness.observed, liveWithTitle("Fresh title"));
        yield* TestClock.adjust("500 millis");
        yield* Effect.yieldNow;

        const lastSave = (yield* Ref.get(harness.savedThreads)).at(-1);
        expect(Option.getOrThrow(state.data).title).toBe("Fresh title");
        expect(lastSave?.thread.title).toBe("Fresh title");
        expect(lastSave?.seq).toBe(2);
      }),
    );

    it.effect("drops replayed events at or below the snapshot's sequence", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ cached: BASE_THREAD });
        yield* Queue.offer(harness.inputs, snapshotFrame(BASE_THREAD));
        yield* Queue.offer(harness.inputs, titleFrame("Replayed title", 1));
        yield* Queue.offer(harness.inputs, titleFrame("Fresh title", 2));

        const state = yield* nextWhere(harness.observed, liveWithTitle("Fresh title"));

        expect(Option.getOrThrow(state.data).title).toBe("Fresh title");
      }),
    );

    it.effect("drops cached data when the thread is deleted", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ cached: BASE_THREAD });
        yield* Queue.offer(harness.inputs, snapshotFrame(BASE_THREAD));
        yield* Queue.offer(harness.inputs, deletedFrame());

        const state = yield* nextWhere(harness.observed, (s) => s.status === "deleted");

        expect(Option.isNone(state.data)).toBe(true);
        expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
      }),
    );
  });

  describe("session and foreground handling", () => {
    it.effect("does not bring a deleted thread back when the app returns to the foreground", () =>
      Effect.gen(function* () {
        const stale = { ...BASE_THREAD, title: "Stale HTTP thread" };
        const harness = yield* makeHarness({
          httpSnapshot: Option.some({ thread: stale, seq: 4 }),
          completionMarker: true,
          cached: BASE_THREAD,
        });
        yield* Queue.offer(harness.inputs, snapshotFrame(BASE_THREAD));
        yield* Queue.offer(harness.inputs, deletedFrame());
        yield* nextWhere(harness.observed, (s) => s.status === "deleted");

        expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
        yield* Queue.offer(harness.wakeups, "application-active");
        yield* harness.awaitSubscriptions(2);

        const { status, data } = yield* Ref.get(harness.latest);
        const counts = yield* Effect.all(
          [harness.subscriptionCount, harness.loaderCalls].map(Ref.get),
        );
        expect({ status, data, counts }).toEqual({
          counts: [2, 0],
          data: Option.none(),
          status: "deleted",
        });
      }),
    );

    it.effect("keeps its data through a domain failure and resumes on a new session", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ cached: BASE_THREAD });
        yield* Queue.offer(harness.inputs, snapshotFrame(BASE_THREAD));
        yield* Queue.offer(harness.inputs, new Error("stream failed"));

        const failed = yield* nextWhere(harness.observed, (s) => Option.isSome(s.error));

        expect(Option.getOrThrow(failed.data)).toEqual(BASE_THREAD);
        expect(Option.getOrThrow(failed.error)).toBe("stream failed");
        expect(yield* Ref.get(harness.retryCount)).toBe(0);

        yield* harness.replaceSession;
        yield* harness.awaitSubscriptions(2);
        yield* Queue.offer(
          harness.inputs,
          snapshotFrame({ ...BASE_THREAD, title: "Recovered thread" }),
        );
        const recovered = yield* nextWhere(harness.observed, liveWithTitle("Recovered thread"));

        expect(Option.isNone(recovered.error)).toBe(true);
        expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      }),
    );

    it.effect("recovers from a transient domain failure on the same session", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const notYet = "thread not found yet";
        yield* Queue.offer(harness.inputs, new Error(notYet));

        const failed = yield* nextWhere(harness.observed, ({ error }) => Option.isSome(error));
        expect([failed.error, yield* Ref.get(harness.subscriptionCount)]).toEqual([
          Option.some(notYet),
          1,
        ]);

        // The same session retries after a short pause.
        yield* TestClock.adjust("250 millis");
        yield* harness.awaitSubscriptions(2);
        yield* Queue.offer(
          harness.inputs,
          snapshotFrame({ ...BASE_THREAD, title: "Materialized thread" }),
        );

        const recovered = yield* nextWhere(harness.observed, liveWithTitle("Materialized thread"));

        const [subscriptions, retries] = yield* Effect.all([
          Ref.get(harness.subscriptionCount),
          Ref.get(harness.retryCount),
        ]);
        expect({ retries, subscriptions, error: recovered.error }).toEqual({
          error: Option.none(),
          subscriptions: 2,
          retries: 0,
        });
      }),
    );

    it.effect("leaves a live snapshot alone when the supervisor turns ready", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ cached: BASE_THREAD });
        yield* SubscriptionRef.set(
          harness.supervisorState,
          linkStateOf({ phase: "connecting", stage: "synchronizing", generation: 0 }),
        );
        yield* Queue.offer(harness.inputs, snapshotFrame(BASE_THREAD));
        yield* nextWhere(harness.observed, isLive);

        yield* SubscriptionRef.set(harness.supervisorState, linkStateOf({}));
        yield* settleBriefly;

        expect((yield* Ref.get(harness.latest)).status).toBe("live");
      }),
    );

    it.effect("stays synchronizing on replayed updates until the completion marker comes", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ cached: BASE_THREAD, completionMarker: true });
        yield* nextWhere(
          harness.observed,
          (s) => s.status === "synchronizing" && Option.isSome(s.data),
        );
        expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);

        yield* Queue.offer(harness.inputs, titleFrame("Caught-up title", CACHED_SEQ + 1));
        const catchingUp = yield* nextWhere(
          harness.observed,
          (s) => s.status === "synchronizing" && hasTitle("Caught-up title")(s),
        );
        expect(catchingUp.status).toBe("synchronizing");

        yield* Queue.offer(harness.inputs, synchronizedFrame());
        const live = yield* nextWhere(harness.observed, (s) => isLive(s) && Option.isSome(s.data));
        expect(Option.getOrThrow(live.data).title).toBe("Caught-up title");
      }),
    );

    it.effect("restarts a replaced session after the last sequence it applied", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ cached: BASE_THREAD, completionMarker: true });
        yield* Queue.offer(harness.inputs, titleFrame("Latest title", CACHED_SEQ + 1));
        yield* Queue.offer(harness.inputs, synchronizedFrame());
        yield* nextWhere(harness.observed, liveWithTitle("Latest title"));

        yield* harness.replaceSession;
        yield* harness.awaitSubscriptions(2);

        expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
        expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SEQ + 1);
        expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");
      }),
    );

    it.effect("resubscribes after the last applied sequence when the app is foregrounded", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ cached: BASE_THREAD, completionMarker: true });
        yield* Queue.offer(harness.inputs, titleFrame("Latest title", CACHED_SEQ + 1));
        yield* Queue.offer(harness.inputs, synchronizedFrame());
        yield* nextWhere(harness.observed, liveWithTitle("Latest title"));

        yield* Queue.offer(harness.wakeups, "application-active");
        const resyncing = yield* nextWhere(
          harness.observed,
          (s) => s.status === "synchronizing" && Option.isSome(s.data),
        );
        yield* harness.awaitSubscriptions(2);

        expect(resyncing.status).toBe("synchronizing");
        expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
        expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SEQ + 1);
        expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);
        expect(yield* Ref.get(harness.loaderCalls)).toBe(0);

        yield* Queue.offer(harness.inputs, synchronizedFrame());
        const live = yield* nextWhere(harness.observed, (s) => isLive(s) && Option.isSome(s.data));
        expect(Option.getOrThrow(live.data).title).toBe("Latest title");

        yield* Queue.offer(harness.wakeups, "application-active-probe");
        yield* harness.awaitSubscriptions(3);
        expect(yield* Ref.get(harness.subscriptionCount)).toBe(3);

        yield* Queue.offer(harness.wakeups, "application-active-reconnect");
        yield* settleBriefly;
        expect(yield* Ref.get(harness.subscriptionCount)).toBe(3);
      }),
    );
  });
});
