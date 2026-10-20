import {
  RPC_METHODS,
  PtyNotRunningError,
  FleetWorkerNotFoundError,
  FleetThreadNotFoundError,
  FleetOperationError,
} from "@kora/contracts";
import * as Effect from "effect/Effect";

import { chatEngine } from "../kora-chat.ts";
import { type HandlerRecord, jsonSafe } from "./shared.ts";

/**
 * Fleet + terminal handlers, both backed by REAL kora PTY panes (see `fleet-service.ts`).
 * These replace the benign-empty terminal stubs: a "Terminal" tab is a login shell in the
 * thread's cwd, and an orchestrator's workers attach through `worker:<paneId>` terminal ids.
 */
export const fleetHandlers: HandlerRecord = {
  // ── Terminal (pane-backed) ──────────────────────────────────────────────
  [RPC_METHODS.ptyOpen]: (input) =>
    Effect.promise(() =>
      chatEngine().fleet.open(
        input as {
          cwd: string;
          terminalId: string;
          threadId: string;
          worktreePath?: string | null;
          cols?: number;
          rows?: number;
          env?: Record<string, string>;
        },
      ),
    ),
  [RPC_METHODS.ptyAttach]: (input) =>
    chatEngine().fleet.attach(
      input as {
        threadId: string;
        terminalId: string;
        cwd?: string;
        worktreePath?: string | null;
        cols?: number;
        rows?: number;
        env?: Record<string, string>;
        restartIfNotRunning?: boolean;
      },
    ),
  [RPC_METHODS.ptyWrite]: (input) => {
    const i = input as { threadId: string; terminalId: string; data: string };
    return Effect.suspend(() =>
      chatEngine().fleet.write(i.threadId, i.terminalId, i.data)
        ? Effect.void
        : Effect.fail(new PtyNotRunningError({ threadId: i.threadId, terminalId: i.terminalId })),
    );
  },
  [RPC_METHODS.ptyResize]: (input) => {
    const i = input as { threadId: string; terminalId: string; cols: number; rows: number };
    return Effect.sync(() => {
      chatEngine().fleet.resize(i.threadId, i.terminalId, i.cols, i.rows);
    });
  },
  [RPC_METHODS.ptyClose]: (input) => {
    const i = input as { threadId: string; terminalId?: string };
    return Effect.sync(() => chatEngine().fleet.close(i.threadId, i.terminalId));
  },
  [RPC_METHODS.ptyWatchMeta]: () => chatEngine().fleet.metadata(),

  // ── Fleet ───────────────────────────────────────────────────────────────
  [RPC_METHODS.fleetSubscribe]: (input) =>
    chatEngine().fleet.subscribe((input as { threadId: string }).threadId),
  [RPC_METHODS.fleetSubscribeWorker]: (input) => {
    const i = input as { threadId: string; paneId: string };
    return chatEngine().fleet.subscribeWorker(i.threadId, i.paneId);
  },
  [RPC_METHODS.fleetRespondApproval]: (input) => {
    const i = input as {
      threadId: string;
      paneId: string;
      requestId: string;
      decision: "accept" | "acceptForSession" | "decline";
    };
    return Effect.tryPromise({
      try: () => chatEngine().fleet.respondApproval(i.threadId, i.paneId, i.requestId, i.decision),
      catch: (cause) =>
        new FleetOperationError({
          threadId: i.threadId,
          operation: "respondApproval",
          message: String((cause as Error)?.message ?? cause),
        }),
    }).pipe(
      Effect.flatMap((ok) =>
        ok
          ? Effect.void
          : Effect.fail(new FleetWorkerNotFoundError({ threadId: i.threadId, paneId: i.paneId })),
      ),
    );
  },
  [RPC_METHODS.fleetSteer]: (input) => {
    const i = input as { threadId: string; paneId: string; text: string; submit?: boolean };
    return Effect.promise(() =>
      chatEngine().fleet.steer(i.threadId, i.paneId, i.text, i.submit !== false),
    ).pipe(
      Effect.flatMap((ok) =>
        ok
          ? Effect.void
          : Effect.fail(new FleetWorkerNotFoundError({ threadId: i.threadId, paneId: i.paneId })),
      ),
    );
  },
  [RPC_METHODS.fleetKill]: (input) => {
    const i = input as { threadId: string; paneId: string };
    return Effect.suspend(() =>
      chatEngine().fleet.kill(i.threadId, i.paneId)
        ? Effect.void
        : Effect.fail(new FleetWorkerNotFoundError({ threadId: i.threadId, paneId: i.paneId })),
    );
  },
  [RPC_METHODS.fleetRetry]: (input) => {
    const i = input as { threadId: string; paneId: string };
    return Effect.tryPromise({
      try: () => chatEngine().fleet.retry(i.threadId, i.paneId),
      catch: (cause) =>
        new FleetOperationError({
          threadId: i.threadId,
          operation: "retry",
          message: String((cause as Error)?.message ?? cause),
        }),
    }).pipe(
      Effect.flatMap((r) =>
        r
          ? Effect.void
          : Effect.fail(new FleetWorkerNotFoundError({ threadId: i.threadId, paneId: i.paneId })),
      ),
    );
  },
  [RPC_METHODS.fleetExtend]: (input) => {
    const i = input as { threadId: string; paneId: string; minutes: number };
    return Effect.tryPromise({
      try: () => chatEngine().fleet.extend(i.threadId, i.paneId, i.minutes),
      catch: (cause) =>
        new FleetOperationError({
          threadId: i.threadId,
          operation: "extend",
          message: String((cause as Error)?.message ?? cause),
        }),
    }).pipe(
      Effect.flatMap((ok) =>
        ok
          ? Effect.void
          : Effect.fail(new FleetWorkerNotFoundError({ threadId: i.threadId, paneId: i.paneId })),
      ),
    );
  },
  [RPC_METHODS.fleetMergeVerify]: (input) => {
    const i = input as { threadId: string; paneIds?: readonly string[] };
    return Effect.tryPromise({
      try: () => chatEngine().fleet.mergeVerify(i.threadId, i.paneIds),
      catch: (cause) =>
        new FleetOperationError({
          threadId: i.threadId,
          operation: "mergeVerify",
          message: String((cause as Error)?.message ?? cause),
        }),
    }).pipe(
      Effect.flatMap((v) =>
        v ? Effect.succeed(v) : Effect.fail(new FleetThreadNotFoundError({ threadId: i.threadId })),
      ),
    );
  },
  [RPC_METHODS.fleetReadReport]: (input) => {
    const i = input as { threadId: string; paneId: string };
    return Effect.tryPromise({
      try: () => chatEngine().fleet.readReport(i.threadId, i.paneId),
      catch: (cause) =>
        new FleetOperationError({
          threadId: i.threadId,
          operation: "readReport",
          message: String((cause as Error)?.message ?? cause),
        }),
    }).pipe(
      Effect.flatMap((r) =>
        r
          ? Effect.succeed(jsonSafe(r))
          : Effect.fail(new FleetWorkerNotFoundError({ threadId: i.threadId, paneId: i.paneId })),
      ),
    );
  },
  [RPC_METHODS.fleetMerge]: (input) => {
    const i = input as { threadId: string; paneId: string; commitFirst?: boolean };
    return Effect.tryPromise({
      try: () => chatEngine().fleet.merge(i.threadId, i.paneId, i.commitFirst !== false),
      catch: (cause) =>
        new FleetOperationError({
          threadId: i.threadId,
          operation: "merge",
          message: String((cause as Error)?.message ?? cause),
        }),
    }).pipe(
      Effect.flatMap((r) =>
        r
          ? Effect.succeed(r)
          : Effect.fail(new FleetWorkerNotFoundError({ threadId: i.threadId, paneId: i.paneId })),
      ),
    );
  },
};
