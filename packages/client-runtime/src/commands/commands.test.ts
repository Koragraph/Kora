import {
  CHAT_METHODS,
  DispatchCommandId,
  HostId,
  ProjectId,
  ThreadId,
  type ClientChatCommand,
} from "@kora/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { AVAILABLE_LINK_STATE, LocalLinkTarget, type PreparedLink } from "../link/model.ts";
import * as HostSupervisor from "../link/supervisor.ts";
import type { KoraRpcClient } from "../wire/protocol.ts";
import type * as RpcSession from "../wire/session.ts";
import * as Commands from "./commands.ts";

/** All-zero random bytes, so a generated id is the nil v4 UUID. */
const zeroCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    digest: (_algorithm, bytes) => Effect.succeed(bytes),
    randomBytes: (length) => new Uint8Array(length).fill(0),
  }),
);
const NIL_V4 = "00000000-0000-4000-8000-000000000000";

const THREAD = ThreadId.make("th-cmd");
const id = (raw: string) => DispatchCommandId.make(raw);
const AT = "2025-01-02T03:04:05.000Z";

/**
 * Runs `use` against a connected host whose dispatch method records every command it gets,
 * and returns what was recorded.
 */
const recording = <A, E>(
  use: Effect.Effect<A, E, HostSupervisor.HostSupervisor | Crypto.Crypto>,
): Effect.Effect<{ sent: ClientChatCommand[]; result: A }, E, Crypto.Crypto> =>
  Effect.gen(function* () {
    const sent: ClientChatCommand[] = [];
    const client = {
      [CHAT_METHODS.dispatch]: (command: ClientChatCommand) =>
        Effect.sync(() => {
          sent.push(command);
          return { sequence: sent.length };
        }),
    } as unknown as KoraRpcClient;
    const session: RpcSession.RpcSession = {
      client,
      initialConfig: Effect.never,
      probe: Effect.void,
      subscribeDaemonConfig: (input) => client.subscribeDaemonConfig(input),
      closed: Effect.never,
      ready: Effect.void,
    };
    const supervisor = HostSupervisor.HostSupervisor.of({
      target: new LocalLinkTarget({
        hostId: HostId.make("h-cmd"),
        label: "Command host",
        httpBaseUrl: "https://host.test",
        wsBaseUrl: "wss://host.test",
      }),
      state: yield* SubscriptionRef.make(AVAILABLE_LINK_STATE),
      retryNow: Effect.void,
      session: yield* SubscriptionRef.make(Option.some(session)),
      disconnect: Effect.void,
      prepared: yield* SubscriptionRef.make(Option.none<PreparedLink>()),
      connect: Effect.void,
    } satisfies HostSupervisor.HostSupervisor["Service"]);
    const result = yield* use.pipe(
      Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
    );
    return { sent, result };
  });

describe("chat commands", () => {
  it.effect("generate an id when the caller gives none, and keep the caller's time", () =>
    Effect.gen(function* () {
      const { sent, result } = yield* recording(
        Commands.createProject({
          projectId: ProjectId.make("pj-cmd"),
          title: "Commands",
          workspaceRoot: "/srv/commands",
          createdAt: AT,
        }),
      );
      expect(result).toEqual({ sequence: 1 });
      expect(sent).toEqual([
        {
          type: "createProject",
          commandId: NIL_V4,
          projectId: "pj-cmd",
          title: "Commands",
          workspaceRoot: "/srv/commands",
          createdAt: AT,
        },
      ]);
    }).pipe(Effect.provide(zeroCrypto)),
  );

  it.effect("keep a caller's id and time so a queued command stays idempotent", () =>
    Effect.gen(function* () {
      const { sent } = yield* recording(
        Commands.stopThreadSession({ commandId: id("queued-1"), threadId: THREAD, createdAt: AT }),
      );
      expect(sent).toEqual([
        { type: "session.stop", commandId: "queued-1", threadId: THREAD, createdAt: AT },
      ]);
    }).pipe(Effect.provide(zeroCrypto)),
  );

  it.effect("choose the revert command from restoreFiles", () =>
    Effect.gen(function* () {
      const variants: Array<boolean | undefined> = [undefined, true, false];
      const { sent } = yield* recording(
        Effect.forEach(variants, (restoreFiles) =>
          Commands.revertThreadCheckpoint({
            commandId: id("rewind-1"),
            threadId: THREAD,
            turnCount: 0,
            createdAt: AT,
            ...(restoreFiles === undefined ? {} : { restoreFiles }),
          }),
        ),
      );
      const restoring = "revertThreadCheckpoint";
      expect(sent.map(({ type }) => type)).toEqual([
        restoring,
        restoring,
        "revertThreadConversation",
      ]);
      expect(sent.some((command) => "restoreFiles" in command)).toBe(false);
    }).pipe(Effect.provide(zeroCrypto)),
  );

  it.effect("add no timestamp to commands that have none", () =>
    Effect.gen(function* () {
      const { sent } = yield* recording(
        Effect.all([
          Commands.archiveThread({ commandId: id("c-archive"), threadId: THREAD }),
          Commands.settleThread({ commandId: id("c-settle"), threadId: THREAD }),
          Commands.unsettleThread({
            commandId: id("c-unsettle"),
            threadId: THREAD,
            reason: "user",
          }),
          Commands.reorderActiveThread({
            commandId: id("c-order"),
            threadId: THREAD,
            orderKey: "kq",
          }),
        ]),
      );
      expect(sent).toEqual([
        { type: "archiveThread", commandId: "c-archive", threadId: THREAD },
        { type: "settleThread", commandId: "c-settle", threadId: THREAD },
        { type: "unsettleThread", commandId: "c-unsettle", threadId: THREAD, reason: "user" },
        { type: "reorderActiveThread", commandId: "c-order", threadId: THREAD, orderKey: "kq" },
      ]);
    }).pipe(Effect.provide(zeroCrypto)),
  );
});
