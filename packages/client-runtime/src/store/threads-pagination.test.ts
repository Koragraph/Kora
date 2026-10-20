import * as Contracts from "@kora/contracts";
import type {
  ChatThread,
  ChatThreadDetailSnapshot,
  ThreadMessage,
  ThreadStreamItem,
} from "@kora/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as Link from "../link/model.ts";
import * as HostSupervisor from "../link/supervisor.ts";
import * as Persistence from "../embedder/hostCache.ts";
import type { KoraRpcClient } from "../wire/protocol.ts";
import type * as RpcSession from "../wire/session.ts";
import type { ThreadSnapshotWindow } from "./threadSnapshotHttp.ts";
import * as Threads from "./threads.ts";

const HOST = new Link.LocalLinkTarget({
  hostId: Contracts.HostId.make("h-pages"),
  httpBaseUrl: "https://pages.host.test",
  wsBaseUrl: "wss://pages.host.test",
  label: "Pages host",
});
const THREAD_ID = Contracts.ThreadId.make("th-pages");
const EARLY = "2025-02-02T08:00:00.000Z";
const LATE = "2025-02-02T09:00:00.000Z";

const reply = (id: string, turn: string, at: string): ThreadMessage => ({
  id: id as ThreadMessage["id"],
  turnId: Contracts.TurnId.make(turn),
  role: "assistant",
  text: `reply ${id}`,
  updatedAt: at,
  createdAt: at,
  streaming: false,
});

const OLD = reply("m-old", "tu-1", EARLY);
const NEW = reply("m-new", "tu-2", LATE);

// A revert to turnCount 1 keeps turns whose checkpoint count is <= 1: tu-1 (on the older page)
// survives and tu-2 (in the loaded window) goes, so both fixture turns get a checkpoint.
const checkpointFor = (turn: string, count: number): ChatThread["checkpoints"][number] => ({
  turnId: Contracts.TurnId.make(turn),
  checkpointTurnCount: count,
  checkpointRef: `cp-${count}` as ChatThread["checkpoints"][number]["checkpointRef"],
  status: "ready",
  files: [],
  assistantMessageId: null,
  completedAt: LATE,
});

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
    ].map((k) => [k, null]),
  ),
  ...Object.fromEntries(["activities", "proposedPlans", "pullRequests"].map((k) => [k, []])),
  id: THREAD_ID,
  projectId: Contracts.ProjectId.make("pj-pages"),
  title: "Paged thread",
  branch: "trunk",
  agentMode: "chat",
  interactionMode: "default",
  runtimeMode: "full-access",
  modelSelection: { model: "m-2", instanceId: Contracts.AgentProfileId.make("codex") },
  createdAt: EARLY,
  updatedAt: EARLY,
  messages: [NEW],
  checkpoints: [checkpointFor("tu-2", 2)],
} as unknown as ChatThread;

const pageInfo = (
  seq: number,
  beforeCursor: string | null,
  hasMore: boolean,
  threadSequence?: number,
) => ({
  seq,
  beforeCursor,
  hasMore,
  ...(threadSequence === undefined ? {} : { threadSequence }),
});

/** The newest turns, with a cursor to older ones. */
const WINDOW: ChatThreadDetailSnapshot = {
  seq: 10,
  thread: THREAD,
  page: pageInfo(10, "cur-a", true),
};
/** The rest of the history. */
const OLDER = (seq = 10, threadSequence?: number): ChatThreadDetailSnapshot => ({
  seq,
  thread: { ...THREAD, messages: [OLD], checkpoints: [checkpointFor("tu-1", 1)] },
  page: pageInfo(seq, null, false, threadSequence),
});

type PageResponse = Option.Option<ChatThreadDetailSnapshot>;

const event = (
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
  at = LATE,
): ThreadStreamItem =>
  ({
    kind: "event",
    event: {
      type,
      sequence,
      eventId: Contracts.EventId.make(`ev-${type}-${sequence}`),
      aggregateId: THREAD_ID,
      aggregateKind: "thread",
      occurredAt: at,
      metadata: {},
      ...{ correlationId: null, causationEventId: null, commandId: null },
      payload: { threadId: THREAD_ID, ...payload },
    },
  }) as ThreadStreamItem;
const retitle = (title: string, sequence: number) =>
  event(sequence, "threadMetaUpdated", { title, updatedAt: LATE });
const revertToFirstTurn = (sequence: number) => event(sequence, "threadReverted", { turnCount: 1 });

const harness = Effect.fn("PaginationTest.harness")(function* (
  setup: {
    readonly paginates?: boolean;
    readonly firstLoad?: PageResponse;
    /** What the cache store hands back (a warm cache). */
    readonly cached?: ChatThreadDetailSnapshot;
  } = {},
) {
  const feed = yield* Queue.unbounded<ThreadStreamItem>();
  const seen = yield* Queue.unbounded<Threads.HostThreadState>();
  const windowsAsked = yield* Ref.make<ReadonlyArray<ThreadSnapshotWindow | undefined>>([]);
  const lastSubscription = yield* Ref.make<Record<string, unknown> | undefined>(undefined);
  // Older pages answer through deferreds so a test can interleave live events with a fetch.
  const pageRequests = yield* Queue.unbounded<Deferred.Deferred<PageResponse>>();

  const client = {
    [Contracts.CHAT_METHODS.subscribeThread]: (input: Record<string, unknown>) =>
      Stream.unwrap(Effect.as(Ref.set(lastSubscription, input), Stream.fromQueue(feed))),
  } as unknown as KoraRpcClient;
  const session: RpcSession.RpcSession = {
    client,
    closed: Effect.never,
    probe: Effect.void,
    ready: Effect.void,
    subscribeDaemonConfig: (input) => client.subscribeDaemonConfig(input),
    initialConfig: Effect.succeed({ threadSnapshotPagination: setup.paginates !== false } as never),
  };
  const sessionRef = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(session),
  );
  const prepared: Link.PreparedLink = {
    target: HOST,
    hostId: HOST.hostId,
    label: HOST.label,
    httpBaseUrl: HOST.httpBaseUrl,
    socketUrl: HOST.wsBaseUrl,
    httpAuthorization: null,
  };
  const supervisor = HostSupervisor.HostSupervisor.of({
    target: HOST,
    session: sessionRef,
    state: yield* SubscriptionRef.make<Link.SupervisorLinkState>(Link.AVAILABLE_LINK_STATE),
    prepared: yield* SubscriptionRef.make<Option.Option<Link.PreparedLink>>(Option.some(prepared)),
    retryNow: Effect.void,
    disconnect: Effect.void,
    connect: Effect.void,
  } satisfies HostSupervisor.HostSupervisor["Service"]);

  const fetcher = Threads.ThreadSnapshotFetcher.of({
    load: (_prepared, _threadId, window) => {
      const record = Ref.update(windowsAsked, (asked) => [...asked, window]);
      const answer: Effect.Effect<PageResponse> =
        window?.beforeCursor === undefined
          ? Effect.succeed(setup.firstLoad ?? Option.none())
          : Effect.flatMap(Deferred.make<PageResponse>(), (pending) =>
              Effect.andThen(Queue.offer(pageRequests, pending), Deferred.await(pending)),
            );
      return Effect.andThen(record, answer);
    },
  });
  const nothing = () => Effect.succeed(Option.none());
  const cache = Persistence.HostCacheStore.of({
    loadThread: () => Effect.succeed(Option.fromNullishOr(setup.cached)),
    loadShell: nothing,
    loadDaemonConfig: nothing,
    saveThread: () => Effect.void,
    saveShell: () => Effect.void,
    saveDaemonConfig: () => Effect.void,
    removeThread: () => Effect.void,
    clear: () => Effect.void,
  });

  const state = yield* Threads.makeHostThreadState(THREAD_ID).pipe(
    Effect.provideService(Threads.ThreadSnapshotFetcher, fetcher),
    Effect.provideService(Persistence.HostCacheStore, cache),
    Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
  );
  yield* Effect.forkScoped(
    Stream.runForEach(SubscriptionRef.changes(state), (value) => Queue.offer(seen, value)),
  );

  const until = (predicate: (value: Threads.HostThreadState) => boolean) =>
    Effect.repeat(Queue.take(seen), { until: predicate });
  const pageOf = (value: Threads.HostThreadState) => Option.getOrUndefined(value.page);

  return {
    feed,
    windowsAsked,
    lastSubscription,
    until,
    /** Wait for the first windowed state. */
    windowed: until((value) => Option.isSome(value.page)),
    /** Ask for older turns and wait for the spinner. */
    askOlder: Effect.suspend(() => {
      Threads.requestOlderThreadTurns(HOST.hostId, THREAD_ID);
      return until((value) => pageOf(value)?.loadingOlder === true);
    }),
    /** Wait until the spinner is gone. */
    settled: until((value) => pageOf(value) !== undefined && pageOf(value)!.loadingOlder === false),
    answerPage: (response: PageResponse) =>
      Effect.flatMap(Queue.take(pageRequests), (pending) => Deferred.succeed(pending, response)),
    /** A new session on the same feed, so the state subscribes again. */
    resubscribe: SubscriptionRef.set(sessionRef, Option.some({ ...session })),
  };
});

const has = (value: Threads.HostThreadState, id: string) =>
  Option.getOrNull(value.data)?.messages.some((m) => m.id === id) === true;
const cursorOf = (value: Threads.HostThreadState) => Option.getOrThrow(value.page).beforeCursor;

describe("windowed thread history", () => {
  describe("first load", () => {
    it.effect("asks for a window when the server can paginate", () =>
      Effect.gen(function* () {
        const h = yield* harness({ firstLoad: Option.some(WINDOW) });
        const state = yield* h.windowed;
        expect(Option.getOrThrow(state.page)).toEqual({
          beforeCursor: "cur-a",
          hasMore: true,
          loadingOlder: false,
        });
        expect((yield* Ref.get(h.windowsAsked))[0]?.turnLimit).toBe(
          Threads.INITIAL_THREAD_USER_TURN_LIMIT,
        );
        expect((yield* Ref.get(h.lastSubscription))?.turnLimit).toBe(
          Threads.INITIAL_THREAD_USER_TURN_LIMIT,
        );
      }),
    );

    it.effect("asks for no window when the server cannot paginate", () =>
      Effect.gen(function* () {
        const h = yield* harness({
          paginates: false,
          firstLoad: Option.some({ seq: 10, thread: THREAD }),
        });
        const state = yield* h.until((value) => Option.isSome(value.data));
        expect(state.page).toEqual(Option.none());
        expect((yield* Ref.get(h.windowsAsked))[0]).toBeUndefined();
        expect((yield* Ref.get(h.lastSubscription))?.turnLimit).toBeUndefined();
      }),
    );
  });

  describe("older pages", () => {
    it.effect("put older rows before the window and clear the cursor", () =>
      Effect.gen(function* () {
        const h = yield* harness({ firstLoad: Option.some(WINDOW) });
        yield* h.windowed;
        yield* h.askOlder;
        yield* h.answerPage(Option.some(OLDER()));
        const state = yield* h.until((value) => has(value, "m-old"));
        expect(Option.getOrThrow(state.data).messages.map(({ id }) => id)).toEqual([
          "m-old",
          "m-new",
        ]);
        const { beforeCursor, hasMore, loadingOlder } = Option.getOrThrow(state.page);
        expect([beforeCursor, hasMore, loadingOlder]).toEqual([null, false, false]);
      }),
    );

    it.effect("are dropped when a revert lands while they load", () =>
      Effect.gen(function* () {
        const h = yield* harness({ firstLoad: Option.some(WINDOW) });
        yield* h.windowed;
        yield* h.askOlder;
        yield* Queue.offer(h.feed, revertToFirstTurn(11));
        yield* h.until((value) => !has(value, "m-new"));
        yield* h.answerPage(Option.some(OLDER()));
        const state = yield* h.settled;
        // Nothing resurrected; the cursor did not move.
        expect(has(state, "m-old")).toBe(false);
        expect(cursorOf(state)).toBe("cur-a");
      }),
    );

    it.effect("are dropped when a fresh snapshot replaces the thread meanwhile", () =>
      Effect.gen(function* () {
        const h = yield* harness({ firstLoad: Option.some(WINDOW) });
        yield* h.windowed;
        yield* h.askOlder;
        yield* Queue.offer(h.feed, {
          kind: "snapshot",
          snapshot: {
            seq: 20,
            thread: { ...THREAD, title: "Fresh" },
            page: pageInfo(20, "cur-b", true),
          },
        });
        yield* h.until((value) => Option.getOrNull(value.data)?.title === "Fresh");
        yield* h.answerPage(Option.some(OLDER()));
        const state = yield* h.settled;
        expect(has(state, "m-old")).toBe(false);
        expect(cursorOf(state)).toBe("cur-b");
      }),
    );

    it.effect("are dropped when read from a projection older than the loaded state", () =>
      Effect.gen(function* () {
        const h = yield* harness({ firstLoad: Option.some(WINDOW) });
        yield* h.windowed;
        yield* h.askOlder;
        yield* h.answerPage(Option.some({ ...OLDER(), seq: 5 }));
        const state = yield* h.settled;
        expect(has(state, "m-old")).toBe(false);
        expect(cursorOf(state)).toBe("cur-a");
      }),
    );

    it.effect("never move the live-event dedupe sequence forward", () =>
      Effect.gen(function* () {
        const h = yield* harness({ firstLoad: Option.some(WINDOW) });
        yield* h.windowed;
        yield* h.askOlder;
        // Captured at projection sequence 12 while the state is at 10: events 11-12 must still apply.
        yield* h.answerPage(Option.some(OLDER(12)));
        yield* h.until((value) => has(value, "m-old"));
        // The revert at 11 removes tu-2 but keeps the merged tu-1 row; a swallowed event would not.
        yield* Queue.offer(h.feed, revertToFirstTurn(11));
        const state = yield* h.until((value) => !has(value, "m-new") && has(value, "m-old"));
        expect(has(state, "m-old")).toBe(true);
      }),
    );

    // A page ahead of the live state may hold streaming text the subscription has not delivered
    // yet; merging it now and replaying the deltas later would duplicate text, so it waits.
    it.effect("wait when read ahead of the live state, and merge once events catch up", () =>
      Effect.gen(function* () {
        const h = yield* harness({ firstLoad: Option.some(WINDOW) });
        yield* h.windowed;
        yield* h.askOlder;
        yield* h.answerPage(Option.some(OLDER(11, 11)));

        const { id, ...oldFields } = OLD;
        yield* Queue.offerAll(h.feed, [
          retitle("Caught up", 11),
          event(
            12,
            "threadMessageSent",
            { ...oldFields, messageId: id, text: " (more)", streaming: true },
            EARLY,
          ),
        ]);
        const state = yield* h.until(
          (value) => Option.getOrNull(value.data)?.messages[0]?.text.endsWith(" (more)") === true,
        );
        expect(Option.getOrThrow(state.data).messages[0]?.text).toBe(`${OLD.text} (more)`);
        expect(has(state, "m-new")).toBe(true);
        expect(Option.getOrThrow(state.page).loadingOlder).toBe(false);
      }),
    );

    it.effect("stop the spinner if the feed synchronizes short of a waiting page", () =>
      Effect.gen(function* () {
        const h = yield* harness({ firstLoad: Option.some(WINDOW) });
        yield* h.windowed;
        yield* h.askOlder;
        yield* h.answerPage(Option.some(OLDER(11, 11)));
        // Caught up at 10: events will never bring the state to the page's watermark.
        yield* Queue.offer(h.feed, { kind: "synchronized" });
        const state = yield* h.settled;
        expect([has(state, "m-old"), has(state, "m-new")]).toEqual([false, true]);
      }),
    );

    it.effect("keep waiting across a resubscribe's synchronized marker", () =>
      Effect.gen(function* () {
        const h = yield* harness({ firstLoad: Option.some(WINDOW) });
        yield* h.windowed;
        yield* h.askOlder;
        yield* h.answerPage(Option.some(OLDER(11, 11)));
        const previous: unknown = yield* Ref.get(h.lastSubscription);
        yield* h.resubscribe;
        while ((yield* Ref.get(h.lastSubscription)) === previous) yield* Effect.yieldNow;

        // The new subscription's marker does not drop the page...
        yield* Queue.offer(h.feed, { kind: "synchronized" });
        // ...and reaching the watermark merges it.
        yield* Queue.offer(h.feed, retitle("Caught up", 11));
        const merged = yield* h.until((value) => has(value, "m-old"));
        expect({
          newer: has(merged, "m-new"),
          spinning: Option.getOrThrow(merged.page).loadingOlder,
        }).toEqual({
          newer: true,
          spinning: false,
        });
      }),
    );
  });

  // Cursors are an (anchor, turnId) keyset from event content, so they survive the revert
  // projector's rewrite; the reducer's own turn filtering handles the loaded rows.
  it.effect("a revert keeps the cursor and fetches nothing", () => {
    const run = Effect.gen(function* () {
      const h = yield* harness({ firstLoad: Option.some(WINDOW) });
      yield* h.windowed;
      yield* Queue.offer(h.feed, revertToFirstTurn(11));
      const state = yield* h.until((value) => !has(value, "m-new"));
      expect(cursorOf(state)).toBe("cur-a");
      expect((yield* Ref.get(h.windowsAsked)).length).toBe(1);
    });
    return run;
  });

  describe("cached windows", () => {
    // Resuming a window against a server that cannot page would show only the window forever.
    it.effect("are thrown away for a full snapshot when the server cannot paginate", () =>
      Effect.gen(function* () {
        const h = yield* harness({
          paginates: false,
          cached: WINDOW,
          firstLoad: Option.some({ seq: 20, thread: { ...THREAD, title: "Whole thread" } }),
        });
        const state = yield* h.until(
          (value) => Option.getOrNull(value.data)?.title === "Whole thread",
        );
        expect(state.page).toEqual(Option.none());
        const subscription = yield* Ref.get(h.lastSubscription);
        expect([subscription?.turnLimit, subscription?.afterSequence]).toEqual([undefined, 20]);
      }),
    );

    it.effect("are kept and resumed when the server can paginate", () =>
      Effect.gen(function* () {
        const h = yield* harness({ cached: WINDOW });
        expect(cursorOf(yield* h.windowed)).toBe("cur-a");
        // The subscription input is recorded once the RPC method is invoked.
        const subscription = yield* Effect.repeat(Ref.get(h.lastSubscription), {
          until: (input) => input !== undefined,
        });
        expect(subscription?.afterSequence).toBe(10);
      }),
    );
  });
});
