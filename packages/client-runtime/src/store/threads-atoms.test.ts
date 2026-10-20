import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Contracts from "@kora/contracts";
import type {
  ChatThread,
  ChatThreadDetailSnapshot,
  HostId,
  ThreadStreamItem,
} from "@kora/contracts";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Stream,
  SubscriptionRef,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { RpcClientError } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";

import type { LinkCatalogEntry } from "../link/catalog.ts";
import * as Link from "../link/model.ts";
import { HostRegistry } from "../link/registry.ts";
import { HostSupervisor } from "../link/supervisor.ts";
import { LinkWakeups, type LinkWakeup } from "../link/wakeups.ts";
import { HostCacheStore } from "../embedder/hostCache.ts";
import type { KoraRpcClient } from "../wire/protocol.ts";
import type { RpcSession } from "../wire/session.ts";
import { createHostThreadDetailAtoms } from "./threadDetail.ts";
import { THREAD_SNAPSHOT_IDLE_TTL_MS } from "./threadRetention.ts";
import type { ThreadSnapshotWindow } from "./threadSnapshotHttp.ts";
import * as Threads from "./threads.ts";

// ---------------------------------------------------------------------------
// The thread under test
// ---------------------------------------------------------------------------

const HOST = new Link.LocalLinkTarget({
  hostId: Contracts.HostId.make("h-atoms"),
  httpBaseUrl: "https://atoms.host.test",
  wsBaseUrl: "wss://atoms.host.test",
  label: "Atoms host",
});
const THREAD_ID = Contracts.ThreadId.make("th-atoms");
const EPOCH = "2025-09-01T00:00:00.000Z";

const THREAD = {
  ...Object.fromEntries(
    [
      "latestTurn",
      "session",
      "worktreePath",
      "deletedAt",
      "archivedAt",
      "settledAt",
      "settledOverride",
    ].map((key) => [key, null]),
  ),
  ...Object.fromEntries(
    ["checkpoints", "activities", "proposedPlans", "messages", "pullRequests"].map((key) => [
      key,
      [],
    ]),
  ),
  id: THREAD_ID,
  projectId: Contracts.ProjectId.make("pj-atoms"),
  title: "Cached thread",
  branch: "trunk",
  agentMode: "chat",
  interactionMode: "default",
  runtimeMode: "full-access",
  modelSelection: { instanceId: Contracts.AgentProfileId.make("codex"), model: "m-1" },
  createdAt: EPOCH,
  updatedAt: EPOCH,
} as ChatThread;
const SNAPSHOT: ChatThreadDetailSnapshot = { seq: 7, thread: THREAD };

const LIVE_LINK: Link.SupervisorLinkState = {
  ...Link.AVAILABLE_LINK_STATE,
  phase: "connected",
  network: "online",
  generation: 1,
  attempt: 1,
  desired: true,
};

/** What the view says for anything that is not a plain domain error. */
const GENERIC_FAILURE = "Could not synchronize the thread.";

// ---------------------------------------------------------------------------
// Stream frames
// ---------------------------------------------------------------------------

const snapshotOf = (snapshot: ChatThreadDetailSnapshot = SNAPSHOT): ThreadStreamItem => ({
  kind: "snapshot",
  snapshot,
});
const SYNCED: ThreadStreamItem = { kind: "synchronized" };

let eventCount = 0;
const eventFrame = (
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
  eventId?: string,
) =>
  ({
    kind: "event",
    event: {
      type,
      sequence,
      eventId: Contracts.EventId.make(eventId ?? `ev-${++eventCount}`),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      occurredAt: EPOCH,
      metadata: {},
      ...{ correlationId: null, causationEventId: null, commandId: null },
      payload: { threadId: THREAD_ID, ...payload },
    },
  }) as ThreadStreamItem;

const retitled = (title: string, sequence: number) =>
  eventFrame(sequence, "threadMetaUpdated", { title, updatedAt: EPOCH });
const deleted = (sequence: number) => eventFrame(sequence, "threadDeleted", { deletedAt: EPOCH });
const streamedText = (text: string, sequence: number, messageId: string, eventId?: string) =>
  eventFrame(
    sequence,
    "threadMessageSent",
    {
      messageId: Contracts.ItemId.make(messageId),
      text,
      role: "assistant",
      streaming: true,
      turnId: null,
      createdAt: EPOCH,
      updatedAt: EPOCH,
    },
    eventId,
  );

const protocolFailure = (message: string, cause: unknown = new Error(message)) =>
  new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({ cause, message }),
  });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** One open thread subscription: the frames we feed it and a latch set when it closes. */
type OpenStream = {
  readonly afterSequence: number | undefined;
  readonly events: Queue.Queue<ThreadStreamItem, Error>;
  readonly closed: Deferred.Deferred<void>;
};
type OlderPageRequest = {
  readonly window: ThreadSnapshotWindow;
  readonly response: Deferred.Deferred<Option.Option<ChatThreadDetailSnapshot>>;
  readonly closed: Deferred.Deferred<void>;
};

type Setup = Partial<{
  snapshot: ChatThreadDetailSnapshot;
  /** Start with the link connected. */
  connected: boolean;
  /** The HTTP snapshot load finds nothing. */
  noHttpSnapshot: boolean;
  firstPage: Effect.Effect<Option.Option<ChatThreadDetailSnapshot>>;
  /** Replace the RPC stream (the subscription is still recorded). */
  stream: Stream.Stream<ThreadStreamItem, Error>;
}>;

const harness = Effect.fn("ThreadAtomsTest.harness")(function* (setup: Setup = {}) {
  const counts = { httpLoads: 0, diskLoads: 0, opened: 0, active: 0 };
  const clock = yield* Clock.Clock;
  const wakeups = yield* Queue.unbounded<LinkWakeup>();
  const streams = yield* Queue.unbounded<OpenStream>();
  const olderPages = yield* Queue.unbounded<OlderPageRequest>();

  const openStream = (input: { readonly afterSequence?: number }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ThreadStreamItem, Error>();
        const closed = yield* Deferred.make<void>();
        const open = Effect.sync(() => {
          counts.opened += 1;
          counts.active += 1;
        });
        const close = Effect.sync(() => {
          counts.active -= 1;
        }).pipe(Effect.andThen(Deferred.succeed(closed, undefined)));
        yield* Effect.acquireRelease(open, () => close);
        yield* Queue.offer(streams, { afterSequence: input.afterSequence, events, closed });
        return setup.stream ?? Stream.fromQueue(events);
      }),
    );
  const client = {
    [Contracts.CHAT_METHODS.subscribeThread]: openStream,
  } as unknown as KoraRpcClient;

  const session: RpcSession = {
    client,
    closed: Effect.never,
    probe: Effect.void,
    ready: Effect.void,
    subscribeDaemonConfig: (input) => client.subscribeDaemonConfig(input),
    initialConfig: Effect.succeed({
      threadSnapshotPagination: true,
      threadResumeCompletionMarker: true,
    } as never),
  };
  const link = yield* SubscriptionRef.make(setup.connected ? LIVE_LINK : Link.AVAILABLE_LINK_STATE);
  const sessionRef = yield* SubscriptionRef.make(Option.some(session));
  const prepared: Link.PreparedLink = {
    target: HOST,
    hostId: HOST.hostId,
    label: HOST.label,
    httpBaseUrl: HOST.httpBaseUrl,
    socketUrl: HOST.wsBaseUrl,
    httpAuthorization: null,
  };
  const supervisor = HostSupervisor.of({
    target: HOST,
    state: link,
    session: sessionRef,
    prepared: yield* SubscriptionRef.make<Option.Option<Link.PreparedLink>>(Option.some(prepared)),
    retryNow: Effect.void,
    disconnect: Effect.void,
    connect: Effect.void,
  });
  const unexpected = (what: string) => () => Effect.die(`Unexpected ${what}`);
  const withSupervisor = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, HostSupervisor, supervisor);
  const hosts = HostRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<HostId, LinkCatalogEntry>>(new Map()),
    networkStatus: yield* SubscriptionRef.make<Link.NetworkStatus>("online"),
    start: Effect.void,
    retryNow: () => Effect.void,
    registerPlatform: unexpected("host registration"),
    reconcilePlatform: unexpected("host reconciliation"),
    setEnabled: unexpected("host toggle"),
    state: () => SubscriptionRef.get(supervisor.state),
    stateChanges: () => SubscriptionRef.changes(supervisor.state),
    run: (_hostId, effect) => withSupervisor(effect),
    runStream: (_hostId, stream) => Stream.provideService(stream, HostSupervisor, supervisor),
    followStream: (_hostId, stream) => Stream.provideService(stream, HostSupervisor, supervisor),
  });

  const firstPage = Effect.sync(() => void (counts.httpLoads += 1)).pipe(
    Effect.andThen(
      setup.firstPage ??
        Effect.succeed(
          setup.noHttpSnapshot ? Option.none() : Option.some(setup.snapshot ?? SNAPSHOT),
        ),
    ),
  );
  const olderPage = (window: ThreadSnapshotWindow) =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* Deferred.make<Option.Option<ChatThreadDetailSnapshot>>();
        const closed = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
        yield* Queue.offer(olderPages, { window, response, closed });
        return yield* Deferred.await(response);
      }),
    );

  const nothingStored = () => Effect.succeed(Option.none());
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(HostRegistry, hosts),
      Layer.succeed(Clock.Clock, clock),
      Layer.succeed(LinkWakeups, { changes: Stream.fromQueue(wakeups) }),
      Layer.succeed(
        Threads.ThreadSnapshotFetcher,
        Threads.ThreadSnapshotFetcher.of({
          load: (_prepared, _threadId, window) =>
            window?.beforeCursor === undefined ? firstPage : olderPage(window),
        }),
      ),
      Layer.succeed(
        HostCacheStore,
        HostCacheStore.of({
          loadThread: () =>
            Effect.sync(() => {
              counts.diskLoads += 1;
              return Option.none();
            }),
          loadShell: nothingStored,
          loadDaemonConfig: nothingStored,
          saveThread: () => Effect.void,
          saveShell: () => Effect.void,
          saveDaemonConfig: () => Effect.void,
          removeThread: () => Effect.void,
          clear: () => Effect.void,
        }),
      ),
    ),
  );

  const rawAtoms = Threads.createHostThreadStateAtoms(runtime);
  const details = createHostThreadDetailAtoms(rawAtoms.stateAtom);
  const ref = { hostId: HOST.hostId, threadId: THREAD_ID };
  const stateAtom = details.stateAtom(ref);
  const newRegistry = Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make({ timeoutResolution: 1, defaultIdleTTL: 60_000 })),
    (registry) => Effect.sync(() => registry.dispose()),
  );
  const registry = yield* newRegistry;

  /** The first state matching `predicate`. */
  const when = (predicate: (state: Threads.HostThreadState) => boolean, inRegistry = registry) =>
    Effect.map(
      Stream.runHead(Stream.filter(AtomRegistry.toStream(inRegistry, stateAtom), predicate)),
      (found) => Option.getOrThrow(found),
    );

  return {
    runtime,
    supervisor,
    registry,
    newRegistry,
    rawAtoms,
    details,
    ref,
    stateAtom,
    link,
    session,
    sessionRef,
    wakeups,
    olderPages,
    counts: () => ({ ...counts }),
    mount: () => registry.mount(stateAtom),
    state: () => registry.get(stateAtom),
    thread: () => Option.getOrThrow(registry.get(stateAtom).data),
    nextStream: Queue.take(streams),
    when,
    live: () => when((state) => state.status === "live"),
    failing: () => when((state) => Option.isSome(state.error)),
    /** Feed frames to an open stream, in order. */
    serve: (open: OpenStream, ...frames: ThreadStreamItem[]) => Queue.offerAll(open.events, frames),
    newSession: SubscriptionRef.set(sessionRef, Option.some({ ...session })),
    /** Unmount and wait until the stream has closed. */
    finish: (unmountView: () => void, open: OpenStream) =>
      Effect.sync(unmountView).pipe(Effect.andThen(Deferred.await(open.closed))),
  };
});

const ON = { connected: true } as const;
/** Loads and streams after one cold visit and one warm return. */
const WARM_RETURN = { active: 1, opened: 2, diskLoads: 1, httpLoads: 1 };
const NO_HTTP = { connected: true, noHttpSnapshot: true } as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("host thread state atoms", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("when synchronizing fails", () => {
    it.effect(
      "reports a defect from the snapshot loader before any RPC stream opens, then retries",
      () =>
        Effect.gen(function* () {
          const loaderDone = yield* Deferred.make<void>();
          const h = yield* harness({
            ...ON,
            firstPage: Effect.die(new Error("RAW LOADER DEFECT MUST STAY OUT OF THE UI")).pipe(
              Effect.ensuring(Deferred.succeed(loaderDone, undefined)),
            ),
          });
          const unmount = h.mount();
          yield* Deferred.await(loaderDone);

          const failed = yield* h.failing();
          expect([failed.status, failed.error, failed.data]).toEqual([
            "empty",
            Option.some(GENERIC_FAILURE),
            Option.none(),
          ]);
          const before = { httpLoads: 1, diskLoads: 1, opened: 0, active: 0 };
          expect(h.counts()).toEqual(before);

          // Backoff: nothing happens before one second.
          yield* TestClock.adjust("500 millis");
          expect(h.state()).toEqual(failed);
          expect(h.counts()).toEqual(before);
          yield* TestClock.adjust("500 millis");
          const again = yield* h.when((s) => Option.isSome(s.error) && h.counts().httpLoads === 2);
          expect(again.error).toEqual(Option.some(GENERIC_FAILURE));
          expect(h.counts().opened).toBe(0);
          unmount();
        }),
    );

    it.effect.each([
      { kind: "protocol", noHttpSnapshot: true },
      { kind: "protocol", noHttpSnapshot: false },
      { kind: "fatal", noHttpSnapshot: true },
      { kind: "fatal", noHttpSnapshot: false },
    ] as const)(
      "keeps a $kind failure on screen through link changes, until a new session (no HTTP copy: $noHttpSnapshot)",
      ({ kind, noHttpSnapshot }) =>
        Effect.gen(function* () {
          const h = yield* harness({ connected: true, noHttpSnapshot });
          const unmount = h.mount();
          const first = yield* h.nextStream;
          const raw = new Error("RAW STREAM DEFECT MUST STAY OUT OF THE UI");
          const cause =
            kind === "fatal" ? Cause.die(raw) : Cause.fail(protocolFailure(raw.message, raw));
          yield* Queue.failCause(first.events, cause);
          yield* Deferred.await(first.closed);

          // Short of the 1 s defect retry, so the failure is what the view shows.
          yield* TestClock.adjust("500 millis");
          const failed = h.state();
          expect(failed.status).toBe(noHttpSnapshot ? "empty" : "cached");
          expect(failed.error).toEqual(Option.some(GENERIC_FAILURE));
          expect(failed.data).toEqual(noHttpSnapshot ? Option.none() : Option.some(THREAD));
          expect([h.counts().opened, h.counts().active]).toEqual([1, 0]);

          // The link may read connected before a session exists; only a session restarts it.
          for (const state of [
            Link.AVAILABLE_LINK_STATE,
            { ...LIVE_LINK, phase: "connecting" as const },
            LIVE_LINK,
          ]) {
            yield* SubscriptionRef.set(h.link, state);
            yield* TestClock.adjust("0 millis");
            expect(h.state()).toEqual(failed);
          }

          yield* h.newSession;
          const next = yield* h.nextStream;
          expect([h.state().error, h.state().status]).toEqual([Option.none(), "synchronizing"]);
          yield* h.serve(next, snapshotOf(), SYNCED);
          const healthy = yield* h.live();
          expect([healthy.error, healthy.data]).toEqual([Option.none(), Option.some(THREAD)]);
          unmount();
          yield* Deferred.await(next.closed);
        }),
    );

    it.effect(
      "retries a protocol failure on the same session when the app comes to the foreground",
      () =>
        Effect.gen(function* () {
          const h = yield* harness(NO_HTTP);
          const unmount = h.mount();
          const first = yield* h.nextStream;
          yield* Queue.fail(first.events, protocolFailure("snapshot shape mismatch"));
          yield* Deferred.await(first.closed);
          yield* TestClock.adjust("0 millis");
          expect(Option.isSome(h.state().error)).toBe(true);

          yield* Queue.offer(h.wakeups, "application-active");
          const next = yield* h.nextStream;
          expect(h.state().error).toEqual(Option.none());
          yield* h.serve(next, snapshotOf(), SYNCED);
          yield* h.live();
          unmount();
          yield* Deferred.await(next.closed);
        }),
    );

    it.effect("waits quietly after a dropped socket and resumes on the next session", () =>
      Effect.gen(function* () {
        const h = yield* harness(NO_HTTP);
        const unmount = h.mount();
        const first = yield* h.nextStream;
        const dropped = new Socket.SocketCloseError({ closeReason: "network gone", code: 1006 });
        yield* Queue.fail(first.events, new RpcClientError.RpcClientError({ reason: dropped }));
        yield* Deferred.await(first.closed);
        yield* TestClock.adjust("1 second");
        const waiting = h.state();
        expect([waiting.data, waiting.error, waiting.status, h.counts().opened]).toEqual([
          Option.none(),
          Option.none(),
          "synchronizing",
          1,
        ]);

        yield* h.newSession;
        const next = yield* h.nextStream;
        yield* h.serve(next, snapshotOf(), SYNCED);
        yield* h.live();
        unmount();
        yield* Deferred.await(next.closed);
      }),
    );

    it.effect("shows a domain error as-is and retries it on the same session", () =>
      Effect.gen(function* () {
        const h = yield* harness(NO_HTTP);
        const unmount = h.mount();
        const first = yield* h.nextStream;
        yield* Queue.fail(first.events, new Error("thread is still being created"));
        yield* Deferred.await(first.closed);
        expect((yield* h.failing()).error).toEqual(Option.some("thread is still being created"));

        yield* TestClock.adjust("250 millis");
        const next = yield* h.nextStream;
        expect(h.counts().opened).toBe(2);
        yield* h.serve(next, snapshotOf(), SYNCED);
        expect((yield* h.live()).error).toEqual(Option.none());
        unmount();
        yield* Deferred.await(next.closed);
      }),
    );

    it.effect.each([
      { kind: "protocol", ended: false },
      { kind: "fatal", ended: false },
      { kind: "domain", ended: false },
      { kind: "protocol", ended: true },
    ] as const)(
      "applies everything buffered before a $kind failure (deleted: $ended)",
      ({ kind, ended }) =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const failure = new Error(
            kind === "domain"
              ? "buffered domain failure"
              : "RAW BUFFERED DEFECT MUST STAY OUT OF THE UI",
          );
          const frames = [
            snapshotOf(),
            SYNCED,
            retitled("After the burst", 8),
            ...(ended ? [deleted(9)] : []),
          ];
          const finalCause =
            kind === "fatal"
              ? Cause.die(failure)
              : Cause.fail(kind === "domain" ? failure : protocolFailure(failure.message, failure));
          const h = yield* harness({
            ...NO_HTTP,
            stream: Stream.fromEffect(Deferred.await(release)).pipe(
              Stream.flatMap(() => Stream.fromIterable(frames)),
              Stream.concat(Stream.failCause(finalCause)),
            ),
          });

          yield* Effect.gen(function* () {
            const state = yield* Threads.makeHostThreadState(THREAD_ID);
            const sawFirst = yield* Deferred.make<void>();
            const sawAll = yield* Deferred.make<void>();
            const caughtUp = (value: Threads.HostThreadState) =>
              ended
                ? value.status === "deleted"
                : Option.getOrNull(value.data)?.title === "After the burst";
            yield* Effect.forkScoped(
              Stream.runForEach(SubscriptionRef.changes(state), (value) =>
                Deferred.succeed(sawFirst, undefined).pipe(
                  Effect.andThen(
                    caughtUp(value) ? Deferred.succeed(sawAll, undefined) : Effect.void,
                  ),
                ),
              ),
            );
            yield* Deferred.await(sawFirst);
            const open = yield* h.nextStream;
            yield* Deferred.succeed(release, undefined).pipe(
              Effect.andThen(Deferred.await(open.closed)),
              Effect.andThen(Deferred.await(sawAll)),
            );

            const final = yield* SubscriptionRef.get(state);
            if (ended) {
              expect([final.status, final.data, final.error]).toEqual([
                "deleted",
                Option.none(),
                Option.none(),
              ]);
              return;
            }
            expect(Option.getOrThrow(final.data).title).toBe("After the burst");
            expect(final.error).toEqual(
              Option.some(kind === "domain" ? failure.message : GENERIC_FAILURE),
            );
            expect(final.status).toBe("cached");
          }).pipe(
            Effect.provideService(HostSupervisor, h.supervisor),
            Effect.provide(h.registry.get(h.runtime.layer)),
            Effect.scoped,
          );
        }),
    );
  });

  describe("one stream for many consumers", () => {
    it.effect("opens one stream for every detail atom and closes it after the last unmount", () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const dropMessages = h.registry.mount(h.details.messagesAtom(h.ref));
        const first = yield* h.nextStream;
        const dropStatus = h.registry.mount(h.details.statusAtom(h.ref));
        expect(h.counts()).toEqual({ httpLoads: 1, diskLoads: 1, opened: 1, active: 1 });

        dropMessages();
        yield* Queue.offer(first.events, SYNCED);
        yield* h.live();
        expect(h.counts().active).toBe(1);
        dropStatus();
        yield* Deferred.await(first.closed);
        expect(h.counts().active).toBe(0);
      }),
    );

    it.effect.each([1, 16, 500])(
      "publishes a replay once per delivered batch (batch of %i)",
      (batch) =>
        Effect.gen(function* () {
          const h = yield* harness();
          const unmount = h.mount();
          const first = yield* h.nextStream;
          let published = 0;
          const stop = h.registry.subscribe(h.details.messagesAtom(h.ref), () => published++, {
            immediate: true,
          });
          published = 0;
          const replay = Array.from({ length: 500 }, (_, n) =>
            streamedText(`${n},`, 8 + n, "replayed", `rp-${n}`),
          );
          for (let start = 0; start < replay.length; start += batch) {
            yield* Queue.offerAll(first.events, replay.slice(start, start + batch));
            const last = Math.min(start + batch, replay.length) - 1;
            yield* h.when(
              (s) => Option.getOrNull(s.data)?.messages[0]?.text.endsWith(`${last},`) === true,
            );
          }
          // Re-deliveries of already-applied events change nothing.
          yield* h.serve(first, replay[499]!, replay[0]!, SYNCED);
          yield* h.live();

          expect(h.thread().messages[0]?.text).toBe(replay.map((_, n) => `${n},`).join(""));
          expect(published).toBe(Math.ceil(replay.length / batch));
          stop();
          unmount();
          yield* Deferred.await(first.closed);
          const remount = h.mount();
          const next = yield* h.nextStream;
          expect(next.afterSequence).toBe(507);
          remount();
          yield* Deferred.await(next.closed);
        }),
    );
  });

  describe("coming back to a thread", () => {
    it.effect("keeps the data and resumes after the last sequence, with no new snapshot", () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const unmount = h.mount();
        const first = yield* h.nextStream;
        yield* h.serve(first, streamedText("kept", 8, "m-keep", "m-keep"), SYNCED);
        yield* h.live();
        const before = h.thread();
        unmount();
        yield* Deferred.await(first.closed);

        const remount = h.mount();
        expect(h.thread()).toBe(before);
        const next = yield* h.nextStream;
        expect([next.afterSequence, h.counts()]).toEqual([8, WARM_RETURN]);
        yield* h.finish(remount, next);
      }),
    );

    it.effect.each([
      { replays: false, statuses: ["live"] },
      { replays: true, statuses: ["live", "synchronizing", "live"] },
    ])(
      "stays live on a warm resume unless something is replayed (replays: $replays)",
      ({ replays, statuses }) =>
        Effect.gen(function* () {
          const h = yield* harness(ON);
          const unmount = h.mount();
          const first = yield* h.nextStream;
          yield* Queue.offer(first.events, SYNCED);
          yield* h.live();
          unmount();
          yield* Deferred.await(first.closed);

          const seen: Array<Threads.HostThreadState["status"]> = [];
          const stop = h.registry.subscribe(h.stateAtom, ({ status }) => seen.push(status), {
            immediate: true,
          });
          const remount = h.mount();
          const next = yield* h.nextStream;
          expect(next.afterSequence).toBe(7);
          if (replays) {
            yield* Queue.offer(
              next.events,
              snapshotOf({ seq: 9, thread: { ...THREAD, title: "Replayed" } }),
            );
            yield* h.when((s) => s.status === "synchronizing");
          }
          yield* Queue.offer(next.events, SYNCED);
          yield* h.live();
          const transitions = seen.filter((status, n) => n === 0 || seen[n - 1] !== status);
          expect(transitions).toEqual(statuses);
          stop();
          remount();
          yield* Deferred.await(next.closed);
        }),
    );

    it.effect("shows cached data when the link dropped while away, then catches up", () =>
      Effect.gen(function* () {
        const h = yield* harness(ON);
        const unmount = h.mount();
        const first = yield* h.nextStream;
        yield* Queue.offer(first.events, SYNCED);
        yield* h.live();
        unmount();
        yield* Deferred.await(first.closed);

        yield* SubscriptionRef.set(h.sessionRef, Option.none());
        yield* SubscriptionRef.set(h.link, Link.AVAILABLE_LINK_STATE);
        const remount = h.mount();
        yield* h.when((s) => s.status === "cached");
        expect(h.thread()).toBe(THREAD);
        expect(h.counts().opened).toBe(1);

        yield* SubscriptionRef.set(h.link, LIVE_LINK);
        yield* SubscriptionRef.set(h.sessionRef, Option.some(h.session));
        const next = yield* h.nextStream;
        expect(next.afterSequence).toBe(7);
        expect(h.state().status).toBe("synchronizing");
        yield* Queue.offer(next.events, SYNCED);
        yield* h.live();
        remount();
        yield* Deferred.await(next.closed);
      }),
    );

    it.effect("keeps warm data even if the raw atom family drops its weak entry", () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const rawEntry = h.rawAtoms.stateAtom(HOST.hostId, THREAD_ID);
        const unmount = h.mount();
        const first = yield* h.nextStream;
        const fresher = { ...THREAD, title: "Fresher" };
        yield* h.serve(first, snapshotOf({ seq: 8, thread: fresher }), SYNCED);
        yield* h.live();
        unmount();
        yield* Deferred.await(first.closed);

        // Simulate the collection directly instead of waiting on the GC.
        const realDeref = WeakRef.prototype.deref;
        function derefExceptRawEntry(this: WeakRef<object>) {
          const held = realDeref.call(this);
          return held === rawEntry ? undefined : held;
        }
        vi.spyOn(WeakRef.prototype, "deref").mockImplementation(derefExceptRawEntry);
        const remount = h.mount();
        expect(h.thread()).toBe(fresher);
        const next = yield* h.nextStream;
        expect([next.afterSequence, h.counts()]).toEqual([8, WARM_RETURN]);
        yield* h.finish(remount, next);
      }),
    );

    it.effect("does not share a cached snapshot with a different registry", () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const unmount = h.mount();
        const first = yield* h.nextStream;
        unmount();
        yield* Deferred.await(first.closed);

        const second = yield* h.newRegistry;
        const unmountSecond = second.mount(h.stateAtom);
        const other = yield* h.nextStream;
        expect(h.counts()).toEqual({ httpLoads: 2, diskLoads: 2, opened: 2, active: 1 });
        unmountSecond();
        yield* Deferred.await(other.closed);
      }),
    );

    it.effect("forgets the snapshot after the idle window with nobody watching", () =>
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        const h = yield* harness();
        const unmount = h.mount();
        const first = yield* h.nextStream;
        yield* h.finish(unmount, first).pipe(Effect.andThen(Effect.yieldNow));
        const pastIdleWindow = THREAD_SNAPSHOT_IDLE_TTL_MS + 1;
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(pastIdleWindow));

        const remount = h.mount();
        const next = yield* h.nextStream;
        expect(h.counts()).toEqual({ httpLoads: 2, diskLoads: 2, opened: 2, active: 1 });
        remount();
        yield* Deferred.await(next.closed);
      }),
    );

    it.effect("cancels an older-page load on unmount and allows it again after returning", () =>
      Effect.gen(function* () {
        const h = yield* harness({
          snapshot: { ...SNAPSHOT, page: { hasMore: true, beforeCursor: "older-a", seq: 7 } },
        });
        const unmount = h.mount();
        const first = yield* h.nextStream;
        expect(Threads.requestOlderThreadTurns(HOST.hostId, THREAD_ID)).toBe(true);
        const pending = yield* Queue.take(h.olderPages);
        const loading = () => Option.getOrThrow(h.state().page).loadingOlder;
        expect(loading()).toBe(true);

        unmount();
        yield* Deferred.await(first.closed);
        yield* Deferred.await(pending.closed);

        const remount = h.mount();
        const next = yield* h.nextStream;
        expect(loading()).toBe(false);
        expect(Threads.requestOlderThreadTurns(HOST.hostId, THREAD_ID)).toBe(true);
        const again = yield* Queue.take(h.olderPages);
        expect(again.window.beforeCursor).toBe("older-a");
        expect(h.counts().httpLoads).toBe(1);
        remount();
        yield* Deferred.await(next.closed);
        yield* Deferred.await(again.closed);
      }),
    );
  });
});
