import { describe, expect, it } from "@effect/vitest";
import {
  CHAT_METHODS,
  HostId,
  type ThreadIndexItem,
  type ThreadIndexSnapshot,
} from "@kora/contracts";
import { Effect, Fiber, Option, Queue, Ref, Stream, SubscriptionRef } from "effect";

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
import { makeHostShellState } from "./shell.ts";

const TARGET = new LocalLinkTarget({
  label: "Shell host",
  wsBaseUrl: "wss://shell-host.test",
  httpBaseUrl: "https://shell-host.test",
  hostId: HostId.make("environment-1"),
});

const { hostId, label, httpBaseUrl, wsBaseUrl: socketUrl } = TARGET;
const PREPARED: PreparedLink = {
  target: TARGET,
  httpAuthorization: null,
  socketUrl,
  httpBaseUrl,
  label,
  hostId,
};

const STAMP = "2026-07-08T00:00:00.000Z";
const indexAt = (
  seq: number,
  threads: ThreadIndexSnapshot["threads"] = [],
): ThreadIndexSnapshot => ({
  updatedAt: STAMP,
  threads,
  projects: [],
  seq,
});
const EMPTY_INDEX = indexAt(1);

const sessionOver = (client: KoraRpcClient): RpcSession.RpcSession => {
  const config = { shellResumeCompletionMarker: true } as never;
  return {
    client,
    initialConfig: Effect.succeed(config),
    closed: Effect.never,
    probe: Effect.void,
    ready: Effect.void,
    subscribeDaemonConfig: (input) => client.subscribeDaemonConfig(input),
  };
};

const subscribeThreadsClient = (
  subscribe: (input: {
    readonly afterSequence?: number;
    readonly requestCompletionMarker?: boolean;
  }) => Stream.Stream<ThreadIndexItem>,
) => ({ [CHAT_METHODS.subscribeThreads]: subscribe }) as unknown as KoraRpcClient;

const linkState = (
  phase: SupervisorLinkState["phase"],
  generation: number,
): SupervisorLinkState => ({
  phase,
  generation,
  stage: phase === "connecting" ? "synchronizing" : null,
  retryAt: null,
  lastFailure: null,
  attempt: 1,
  network: "online",
  desired: true,
});

interface RigOptions {
  readonly client: KoraRpcClient;
  readonly cachedShell?: ThreadIndexSnapshot;
  /** Persisting never completes when set, to prove state is published first. */
  readonly savingHangs?: boolean;
  readonly wakeups?: Queue.Queue<LinkWakeups.LinkWakeup>;
}

/** A supervisor, cache and shell state wired together; returns the pieces tests poke at. */
const buildRig = Effect.fn("TestShellRig.build")(function* (options: RigOptions) {
  const [supervisorState, activeSession, prepared] = yield* Effect.all([
    SubscriptionRef.make(AVAILABLE_LINK_STATE),
    SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
      Option.some(sessionOver(options.client)),
    ),
    SubscriptionRef.make(Option.some(PREPARED)),
  ]);
  const noop = () => Effect.void;
  const none = () => Effect.succeed(Option.none());
  const service: HostSupervisor.HostSupervisor["Service"] = {
    prepared,
    session: activeSession,
    state: supervisorState,
    target: TARGET,
    retryNow: Effect.void,
    connect: Effect.void,
    disconnect: Effect.void,
  };
  const supervisor = HostSupervisor.HostSupervisor.of(service);
  const cache = Persistence.HostCacheStore.of({
    clear: noop,
    saveDaemonConfig: noop,
    loadDaemonConfig: none,
    removeThread: noop,
    saveThread: noop,
    loadThread: none,
    saveShell: () => (options.savingHangs === true ? Effect.never : Effect.void),
    loadShell: () => Effect.succeed(Option.fromNullishOr(options.cachedShell)),
  });
  const shellState = yield* makeHostShellState().pipe(
    Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
    Effect.provideService(Persistence.HostCacheStore, cache),
    Effect.provideService(
      LinkWakeups.LinkWakeups,
      LinkWakeups.LinkWakeups.of({
        changes: options.wakeups ? Stream.fromQueue(options.wakeups) : Stream.never,
      }),
    ),
  );
  return { supervisorState, activeSession, shellState };
});

type Rig = Effect.Success<ReturnType<typeof buildRig>>;

const untilStatus = (rig: Rig, status: string) =>
  SubscriptionRef.changes(rig.shellState).pipe(
    Stream.filter((state) => state.status === status),
    Stream.runHead,
  );

const spinUntil = (done: () => Effect.Effect<boolean>, limit = 100) =>
  Effect.gen(function* () {
    for (let n = 0; n < limit && !(yield* done()); n += 1) yield* Effect.yieldNow;
  });

const idle = (ticks: number) =>
  Effect.gen(function* () {
    for (let n = 0; n < ticks; n += 1) yield* Effect.yieldNow;
  });

describe("environment shell synchronization", () => {
  it.effect("shows the live state before it is saved, and keeps it once connected", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<ThreadIndexItem>();
      const rig = yield* buildRig({
        client: subscribeThreadsClient(() => Stream.fromQueue(events)),
        savingHangs: true,
      });

      yield* SubscriptionRef.set(rig.supervisorState, linkState("connecting", 0));
      yield* Queue.offer(events, { kind: "snapshot", snapshot: EMPTY_INDEX });
      const syncing = yield* SubscriptionRef.changes(rig.shellState).pipe(
        Stream.filter((state) => state.status === "synchronizing" && Option.isSome(state.snapshot)),
        Stream.runHead,
      );
      expect(Option.getOrThrow(Option.getOrThrow(syncing).snapshot)).toEqual(EMPTY_INDEX);

      yield* Queue.offer(events, { kind: "synchronized" });
      yield* untilStatus(rig, "live");

      yield* SubscriptionRef.set(rig.supervisorState, linkState("connected", 1));
      yield* idle(10);

      const state = yield* SubscriptionRef.get(rig.shellState);
      expect(state.status).toBe("live");
      expect(Option.getOrThrow(state.snapshot)).toEqual(EMPTY_INDEX);
    }),
  );

  // RpcClient buffers 16 events by default, so a big server chunk lands as several batches.
  const batching: ReadonlyArray<readonly [capacity: number, seqs: ReadonlyArray<number>]> = [
    [Number.POSITIVE_INFINITY, [51]],
    [16, [17, 33, 49, 51]],
  ];
  it.live.each(batching)("groups live events with a buffer of %d", ([capacity, seqs]) =>
    Effect.gen(function* () {
      const expectedSequences = seqs;
      const events = yield* Queue.bounded<ThreadIndexItem>(capacity);
      const rig = yield* buildRig({
        client: subscribeThreadsClient(() => Stream.fromQueue(events)),
      });
      yield* SubscriptionRef.set(rig.supervisorState, linkState("connected", 1));
      yield* Queue.offer(events, { kind: "snapshot", snapshot: EMPTY_INDEX });
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* untilStatus(rig, "live");

      // Observe before publishing so no batch can land before the subscription exists.
      const ids = Array.from({ length: 50 }, (_, n) => `thread-${n}`);
      const allIn = (state: { readonly snapshot: Option.Option<ThreadIndexSnapshot> }) =>
        Option.exists(state.snapshot, ({ threads }) => threads.length === ids.length);
      const watcher = yield* Effect.forkScoped(
        Stream.runCollect(
          Stream.takeUntil(Stream.drop(SubscriptionRef.changes(rig.shellState), 1), allIn),
        ),
        { startImmediately: true },
      );
      const upserts = ids.map((id, n) => ({
        thread: { id } as never,
        sequence: n + 2,
        kind: "thread-upserted" as const,
      }));
      yield* Queue.offerAll(events, upserts);

      const snapshots = (yield* Fiber.join(watcher)).map((state) =>
        Option.getOrThrow(state.snapshot),
      );
      expect(snapshots.map((snapshot) => snapshot.seq)).toEqual(expectedSequences);
      expect(snapshots.at(-1)!.threads.map(({ id }) => id)).toEqual(ids);
    }).pipe(Effect.scoped),
  );

  it.effect("asks a fresh session for a whole socket snapshot, then resumes from its cursor", () =>
    Effect.gen(function* () {
      const cached = indexAt(5, [{ id: "cached-thread" } as never]);
      const replacement: ThreadIndexSnapshot = {
        ...cached,
        seq: 9_999,
        threads: [],
        updatedAt: "2026-07-09T00:00:00.000Z",
      };
      const events = yield* Queue.unbounded<ThreadIndexItem>();
      const wakeups = yield* Queue.unbounded<LinkWakeups.LinkWakeup>();
      const requested = yield* Queue.unbounded<{
        readonly afterSequence?: number;
        readonly requestCompletionMarker?: boolean;
      }>();
      const rig = yield* buildRig({
        client: subscribeThreadsClient((input) =>
          Stream.unwrap(Queue.offer(requested, input).pipe(Effect.as(Stream.fromQueue(events)))),
        ),
        cachedShell: cached,
        wakeups,
      });

      const firstRequest = yield* Queue.take(requested);
      expect(firstRequest.afterSequence).toBeUndefined();
      expect(firstRequest.requestCompletionMarker).toBe(true);
      const warming = yield* SubscriptionRef.get(rig.shellState);
      expect(warming.status).toBe("synchronizing");
      expect(Option.getOrThrow(warming.snapshot)).toEqual(cached);

      yield* Queue.offer(events, { kind: "snapshot", snapshot: replacement });
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* untilStatus(rig, "live");
      expect(Option.getOrThrow((yield* SubscriptionRef.get(rig.shellState)).snapshot)).toEqual(
        replacement,
      );

      yield* Queue.offer(wakeups, "application-active");
      const resumeRequest = yield* Queue.take(requested);
      expect(resumeRequest.afterSequence).toBe(replacement.seq);
      expect(resumeRequest.requestCompletionMarker).toBe(true);
    }),
  );

  it.effect("resubscribes from the in-memory cursor when the app becomes active", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<ThreadIndexItem>();
      const wakeups = yield* Queue.unbounded<LinkWakeups.LinkWakeup>();
      const cursors = yield* Ref.make<ReadonlyArray<number | undefined>>([]);
      const client = subscribeThreadsClient((input) =>
        Stream.unwrap(
          Ref.update(cursors, (seen) => [...seen, input.afterSequence]).pipe(
            Effect.as(Stream.fromQueue(events)),
          ),
        ),
      );
      const rig = yield* buildRig({ client, cachedShell: EMPTY_INDEX, wakeups });
      const awaitRequests = (count: number) =>
        spinUntil(() => Ref.get(cursors).pipe(Effect.map((seen) => seen.length >= count)));
      const seenCursors = Ref.get(cursors);

      // A new session asks the socket for a complete snapshot (no cursor).
      yield* awaitRequests(1);
      expect(yield* seenCursors).toEqual([undefined]);
      yield* Queue.offer(events, { kind: "snapshot", snapshot: { ...EMPTY_INDEX, seq: 10 } });
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* untilStatus(rig, "live");

      // A newer snapshot on the stream moves the cursor forward.
      yield* Queue.offer(events, { kind: "snapshot", snapshot: { ...EMPTY_INDEX, seq: 40 } });
      yield* SubscriptionRef.changes(rig.shellState).pipe(
        Stream.filter((value) => Option.isSome(value.snapshot) && value.snapshot.value.seq === 40),
        Stream.runHead,
      );

      yield* Queue.offer(wakeups, "application-active");
      yield* awaitRequests(2);
      expect(yield* seenCursors).toEqual([undefined, 40]);
      yield* Queue.offer(events, { kind: "synchronized" });

      yield* Queue.offer(wakeups, "application-active-probe");
      yield* awaitRequests(3);
      expect(yield* seenCursors).toEqual([undefined, 40, 40]);

      yield* Queue.offer(wakeups, "application-active-reconnect");
      yield* idle(10);
      expect((yield* seenCursors).length).toBe(3);

      // A replaced session starts over with a complete snapshot.
      yield* SubscriptionRef.set(rig.activeSession, Option.some(sessionOver(client)));
      yield* awaitRequests(4);
      expect(yield* seenCursors).toEqual([undefined, 40, 40, undefined]);
    }),
  );
});
