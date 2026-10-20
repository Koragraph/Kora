import { describe, expect, it } from "@effect/vitest";
import * as Contracts from "@kora/contracts";
import type { ClientChatCommand, HostId, ThreadIndexSnapshot } from "@kora/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { HostRegistry } from "../link/registry.ts";
import { HostSupervisor } from "../link/supervisor.ts";
import type { RpcSession } from "../wire/session.ts";
import { createThreadHostAtoms } from "./threadCommands.ts";

const HOST = Contracts.HostId.make("h-remote");
const THREAD = Contracts.ThreadId.make("th-remote");
const AT = "2025-10-10T10:00:00.000Z";
const FAR_FUTURE = "2099-12-31T00:00:00.000Z";

type Row = ThreadIndexSnapshot["threads"][number];

const ROW = {
  ...Object.fromEntries(
    [
      "latestTurn",
      "session",
      "latestUserMessageAt",
      "branch",
      "worktreePath",
      "archivedAt",
      "settledAt",
      "settledOverride",
    ].map((key) => [key, null]),
  ),
  ...Object.fromEntries(
    ["hasPendingApprovals", "hasPendingUserInput", "hasActionableProposedPlan"].map((key) => [
      key,
      false,
    ]),
  ),
  id: THREAD,
  projectId: Contracts.ProjectId.make("pj-remote"),
  title: "Remote work",
  pullRequests: [],
  agentMode: "chat",
  interactionMode: "default",
  runtimeMode: "full-access",
  modelSelection: { model: "m-3", instanceId: Contracts.AgentProfileId.make("codex") },
  createdAt: AT,
  updatedAt: AT,
} as unknown as Row;

/** An index holding one version of the thread. */
const index = (row: Partial<Row> = {}, seq = 1): ThreadIndexSnapshot => ({
  seq,
  updatedAt: AT,
  projects: [],
  threads: [{ ...ROW, ...row }],
});
const BASE = index();

type Reply = Deferred.Deferred<{ sequence: number }, Error>;

/**
 * A host whose dispatch answers only when a test resolves the reply, plus the atoms under
 * test. `visible` is what a list shows: the server's index with any pending optimism on top.
 */
const scenario = Effect.fn("ThreadCommandsTest.scenario")(function* () {
  const sent = yield* Queue.unbounded<{ command: ClientChatCommand; reply: Reply }>();
  const dispatch = (command: ClientChatCommand) =>
    Effect.flatMap(Deferred.make<{ sequence: number }, Error>(), (reply) =>
      Effect.andThen(Queue.offer(sent, { command, reply }), Deferred.await(reply)),
    );
  const session = {
    client: { [Contracts.CHAT_METHODS.dispatch]: dispatch },
  } as unknown as RpcSession;
  const supervisor = HostSupervisor.of({
    target: { hostId: HOST },
    session: yield* SubscriptionRef.make(Option.some(session)),
  } as HostSupervisor["Service"]);
  const zeroBytes = Crypto.make({
    digest: (_algorithm, bytes) => Effect.succeed(bytes),
    randomBytes: (length) => new Uint8Array(length),
  });
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(Crypto.Crypto, zeroBytes),
      Layer.succeed(HostRegistry, {
        run: (_hostId, effect) => Effect.provideService(effect, HostSupervisor, supervisor),
      } as HostRegistry["Service"]),
    ),
  );
  const server = Atom.family((_hostId: HostId) => Atom.make(BASE));
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make()),
    (made) => Effect.sync(() => made.dispose()),
  );
  const commands = createThreadHostAtoms(runtime, server);
  const visibleAtom = commands.snapshotAtom(HOST);
  registry.mount(visibleAtom);

  type Action = keyof typeof commands &
    (
      | "settle"
      | "unsettle"
      | "snooze"
      | "unsnooze"
      | "pin"
      | "unpin"
      | "reorderPin"
      | "reorderActive"
    );
  return {
    commands,
    registry,
    sent,
    visible: () => registry.get(visibleAtom),
    visibleRow: () => registry.get(visibleAtom)?.threads[0],
    serverIndex: () => registry.get(server(HOST)),
    /** The server publishes a new index. */
    publish: (next: ThreadIndexSnapshot) => registry.set(server(HOST), next),
    start: (action: Action, input: Record<string, unknown> = {}) =>
      commands[action].run(registry, {
        hostId: HOST,
        input: { threadId: THREAD, ...input } as never,
      }),
    outcome: (pending: Promise<{ readonly _tag: string }>) =>
      Effect.map(
        Effect.promise(() => pending),
        ({ _tag }) => _tag,
      ),
  };
});

describe("thread lifecycle commands on a remote host", () => {
  const cases = [
    {
      action: "settle",
      input: {},
      shows: { settledOverride: "settled", pinnedAt: null, snoozedUntil: null },
    },
    {
      action: "unsettle",
      input: { reason: "user" },
      shows: { settledAt: null, settledOverride: "active" },
    },
    { action: "snooze", input: { snoozedUntil: FAR_FUTURE }, shows: { snoozedUntil: FAR_FUTURE } },
    {
      action: "unsnooze",
      input: { reason: "user" },
      shows: { snoozedAt: null, snoozedUntil: null },
    },
    {
      action: "pin",
      input: { orderKey: "a" },
      shows: { pinOrderKey: "a", pinnedAt: expect.any(String) },
    },
    { action: "unpin", input: {}, shows: { pinOrderKey: null, pinnedAt: null } },
    { action: "reorderPin", input: { orderKey: "b" }, shows: { pinOrderKey: "b" } },
    { action: "reorderActive", input: { orderKey: "b" }, shows: { activeOrderKey: "b" } },
  ] as const;

  /** A starting row the action actually changes. */
  const startingRow = (action: string): Partial<Row> => ({
    ...(["unsettle", "pin"].includes(action)
      ? { settledOverride: "settled" as const, settledAt: AT }
      : {}),
    ...(["unsnooze", "settle", "pin"].includes(action)
      ? { snoozedUntil: FAR_FUTURE, snoozedAt: AT }
      : {}),
    ...(["unpin", "settle"].includes(action) ? { pinnedAt: AT, pinOrderKey: "a" } : {}),
  });

  for (const { action, input, shows } of cases) {
    it.effect(`${action}: shown at once, rolled back when the host rejects it`, () =>
      Effect.gen(function* () {
        const s = yield* scenario();
        const before = index(startingRow(action));
        s.publish(before);
        const pending = s.start(action, {
          commandId: Contracts.DispatchCommandId.make(action),
          reason: "user",
          orderKey: "a",
          snoozedUntil: FAR_FUTURE,
          ...input,
        });
        expect(s.visibleRow()).toMatchObject(shows);
        const request = yield* Queue.take(s.sent);
        // Optimism never touches the server's copy.
        expect(s.serverIndex()).toBe(before);
        yield* Deferred.fail(request.reply, new Error("host said no"));
        expect(yield* s.outcome(pending)).toBe("Failure");
        expect(s.visible()).toBe(before);
      }),
    );
  }

  it.effect("keeps showing an acknowledged change until the index that confirms it", () =>
    Effect.gen(function* () {
      const s = yield* scenario();
      const pending = s.start("settle");
      yield* Deferred.succeed((yield* Queue.take(s.sent)).reply, { sequence: 3 });
      expect(yield* s.outcome(pending)).toBe("Success");

      const unrelated = index({ title: "Retitled elsewhere" }, 2);
      s.publish(unrelated);
      expect(s.visibleRow()).toMatchObject({
        title: "Retitled elsewhere",
        settledOverride: "settled",
      });

      const confirming = index(
        {
          title: "Retitled elsewhere",
          settledOverride: "settled",
          settledAt: "2025-10-10T11:00:00.000Z",
        },
        3,
      );
      s.publish(confirming);
      expect(s.visible()).toBe(confirming);
      s.publish(index({}, 4));
      expect(s.visibleRow()?.settledOverride).toBeNull();
    }),
  );

  it.effect("shows a queued undo straight away and keeps it when the first action fails", () =>
    Effect.gen(function* () {
      const s = yield* scenario();
      const settle = s.start("settle");
      const first = yield* Queue.take(s.sent);
      const unsettle = s.start("unsettle", { reason: "user" });
      expect(s.visibleRow()?.settledOverride).toBe("active");

      yield* Deferred.fail(first.reply, new Error("settle refused"));
      yield* s.outcome(settle);
      expect(s.visibleRow()?.settledOverride).toBe("active");

      const second = yield* Queue.take(s.sent);
      expect(second.command.type).toBe("unsettleThread");
      const confirmed = index({ settledOverride: "active" }, 2);
      s.publish(confirmed);
      yield* Deferred.succeed(second.reply, { sequence: 2 });
      yield* s.outcome(unsettle);
      expect(s.visible()).toBe(confirmed);
    }),
  );

  it.effect("keeps hosts apart and does not bring back a thread the host removed", () =>
    Effect.gen(function* () {
      const s = yield* scenario();
      const pending = s.start("settle");
      const request = yield* Queue.take(s.sent);
      expect(s.registry.get(s.commands.snapshotAtom(Contracts.HostId.make("h-elsewhere")))).toBe(
        BASE,
      );

      const emptied: ThreadIndexSnapshot = { ...BASE, seq: 2, threads: [] };
      s.publish(emptied);
      expect(s.visible()?.threads).toEqual([]);
      yield* Deferred.fail(request.reply, new Error("gone"));
      yield* s.outcome(pending);
      expect(s.visible()).toBe(emptied);
    }),
  );

  it.effect("does not hide a thread that is waiting on an approval", () =>
    Effect.gen(function* () {
      const s = yield* scenario();
      const waiting = index({ hasPendingApprovals: true });
      s.publish(waiting);
      const pending = s.start("settle");
      const request = yield* Queue.take(s.sent);
      expect(s.visibleRow()).toBe(waiting.threads[0]);
      yield* Deferred.fail(request.reply, new Error("approval outstanding"));
      yield* s.outcome(pending);
    }),
  );

  for (const action of ["settle", "snooze"] as const) {
    const undo = action === "settle" ? "unsettle" : "unsnooze";
    const parked: Partial<Row> =
      action === "settle" ? { settledOverride: "settled" } : { snoozedUntil: FAR_FUTURE };
    const awake = action === "settle" ? { settledOverride: "active" } : { snoozedUntil: null };

    it.effect(`${action}: a failed undo leaves the confirmed ${action} in place`, () =>
      Effect.gen(function* () {
        const s = yield* scenario();
        const pending = s.start(action, { snoozedUntil: FAR_FUTURE });
        const first = yield* Queue.take(s.sent);
        const undoing = s.start(undo, { reason: "user" });
        expect(s.visibleRow()).toMatchObject(awake);

        yield* Deferred.succeed(first.reply, { sequence: 2 });
        expect(yield* s.outcome(pending)).toBe("Success");
        expect(s.visibleRow()).toMatchObject(awake);
        const confirmed = index(parked, 2);
        s.publish(confirmed);
        expect(s.visibleRow()).toMatchObject(awake);

        const second = yield* Queue.take(s.sent);
        expect(second.command.type).toBe(`${undo}Thread`);
        yield* Deferred.fail(second.reply, new Error("undo refused"));
        expect(yield* s.outcome(undoing)).toBe("Failure");
        expect(s.visible()).toBe(confirmed);
      }),
    );

    it.effect(`${action}: a newer approval published before the reply wins`, () =>
      Effect.gen(function* () {
        const s = yield* scenario();
        const pending = s.start(action, { snoozedUntil: FAR_FUTURE });
        const request = yield* Queue.take(s.sent);
        const newer = index({ hasPendingApprovals: true }, 3);
        s.publish(newer);
        expect(s.visibleRow()).toBe(newer.threads[0]);
        yield* Deferred.succeed(request.reply, { sequence: 2 });
        expect(yield* s.outcome(pending)).toBe("Success");
        expect(s.visible()).toBe(newer);
      }),
    );

    it.effect(`${action}: accepted even though the index still shows an old question`, () =>
      Effect.gen(function* () {
        const s = yield* scenario();
        const stale = index({ hasPendingUserInput: true });
        s.publish(stale);
        const pending = s.start(action, { snoozedUntil: FAR_FUTURE });
        const request = yield* Queue.take(s.sent);
        expect(s.visibleRow()).toBe(stale.threads[0]);
        yield* Deferred.succeed(request.reply, { sequence: 2 });
        expect(yield* s.outcome(pending)).toBe("Success");
        expect(s.visibleRow()).toMatchObject({ ...parked, hasPendingUserInput: false });
        expect(s.serverIndex()).toBe(stale);
      }),
    );
  }
});
