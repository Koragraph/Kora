// @effect-diagnostics globalDate:off -- plain wall-clock reads at the boundary to the in-process routine service.
import type {
  BlobIdInput,
  RoutineConfirmCardPayload,
  RoutineConfirmInput,
  RoutineCreateTriggerInput,
  RoutineIdInput,
  RoutinePreviewInput,
  RoutineRunIdInput,
  RoutineSaveInput,
  RoutineSetPausedInput,
  RoutineTriggerIdInput,
  RoutinesChangedEvent,
} from "@kora/contracts";
import { BLOB_METHODS } from "@kora/contracts";

import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { host, type KoraRoutineJson, type KoraRoutinesLike } from "../host.ts";
import { chatEngine } from "../kora-chat.ts";
import { type HandlerRecord, jsonSafe } from "./shared.ts";
import { callAsync, fail, profileOf, runtimeFor } from "./blobs.ts";

/**
 * `blobs.routines.*` (docs/bots/ROUTINES.md): thin delegation to the runtime's `RoutineService` (`UiHost.blobs.routines`).
 * Wire rules as blobs.ts: every result goes through `jsonSafe`, every failure is a typed `BlobError`. Two things are
 * enforced HERE because they are about what leaves the daemon:
 *   - `eventPayload` (the untrusted body of a webhook event, kept only while a run is live) never reaches the client;
 *   - a webhook SECRET leaves only in the result of `createTrigger` / `rotateTrigger`, and is never logged.
 */

function routinesOf(operation: string): KoraRoutinesLike {
  const r = runtimeFor(operation).routines;
  if (!r)
    throw fail(
      operation,
      "Routines are not available in this daemon yet. Restart Kora to finish updating it.",
      "unavailable",
    );
  return r;
}

/** A run as the client sees it: without the webhook body. */
function runWire(run: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!run) return null;
  const { eventPayload: _drop, ...rest } = run;
  void _drop;
  return rest;
}

function routineWire(view: KoraRoutineJson): Record<string, unknown> {
  const v = view as Record<string, unknown>;
  return {
    ...v,
    live: runWire(v.live as Record<string, unknown> | null),
    lastRun: runWire(v.lastRun as Record<string, unknown> | null),
  };
}

function unwrap<T>(
  operation: string,
  r: { ok: true; value: T } | { ok: false; message: string },
  code = "invalid",
): T {
  if (!r.ok) throw fail(operation, r.message, code);
  return r.value;
}

/** Every routine change the service announces, as frames for `blobs.routines.subscribe`. */
const routinesStream = (): Stream.Stream<RoutinesChangedEvent> =>
  Stream.callback<RoutinesChangedEvent>((queue) =>
    Effect.gen(function* () {
      let off: () => void = () => {};
      try {
        const svc = host().blobs?.routines;
        if (svc) {
          const fn = (e: { routineId: string | null; blobId: string | null }) =>
            Queue.offerUnsafe(
              queue,
              jsonSafe({ blobId: e?.blobId ?? null, routineId: e?.routineId ?? null } as const),
            );
          svc.on("changed", fn);
          off = () => {
            try {
              svc.off("changed", fn);
            } catch {
              /* already gone */
            }
          };
        }
      } catch (cause) {
        host().log(
          `[kora-ui] routines.subscribe: unavailable (${String((cause as Error)?.message ?? cause)})`,
        );
      }
      yield* Effect.addFinalizer(() => Effect.sync(off));
      // seed frame: a client that subscribes after a change re-reads once
      Queue.offerUnsafe(queue, { blobId: null, routineId: null });
      return yield* Effect.never;
    }),
  );

function saveToInput(i: RoutineSaveInput) {
  return {
    title: i.title,
    prompt: i.prompt,
    cadence: i.cadence,
    results: i.results,
    rememberLastRun: i.rememberLastRun,
    maxRunMinutes: i.maxRunMinutes,
    catchUp: i.catchUp,
    paused: i.paused,
  };
}

export const blobsRoutinesHandlers: HandlerRecord = {
  [BLOB_METHODS.routinesSubscribe]: () => routinesStream(),

  [BLOB_METHODS.routinesSnapshot]: (input) => {
    const i = input as BlobIdInput;
    return callAsync("routinesSnapshot", async () => {
      profileOf(runtimeFor("routinesSnapshot"), "routinesSnapshot", i.blobId);
      const svc = routinesOf("routinesSnapshot");
      const status = svc.status();
      return {
        routines: svc.list(i.blobId).map(routineWire),
        runs: svc.runs(i.blobId).map((r) => runWire(r)),
        webhook: {
          baseUrl: status.baseUrl,
          receiverUp: status.receiverUp,
          port: status.webhookPort,
        },
      };
    });
  },

  [BLOB_METHODS.routinesThreads]: (input) => {
    const i = input as BlobIdInput;
    return callAsync("routinesThreads", async () => {
      profileOf(runtimeFor("routinesThreads"), "routinesThreads", i.blobId);
      return { threads: chatEngine().blobThreadChoices(i.blobId) };
    });
  },

  [BLOB_METHODS.routinesPreview]: (input) => {
    const i = input as RoutinePreviewInput;
    return callAsync("routinesPreview", async () =>
      unwrap("routinesPreview", routinesOf("routinesPreview").preview(i.cadence)),
    );
  },

  [BLOB_METHODS.routinesSave]: (input) => {
    const i = input as RoutineSaveInput;
    return callAsync("routinesSave", async () => {
      const svc = routinesOf("routinesSave");
      profileOf(runtimeFor("routinesSave"), "routinesSave", i.blobId);
      const saved = i.id
        ? unwrap("routinesSave", svc.update(i.id, saveToInput(i)))
        : unwrap("routinesSave", svc.create({ blobId: i.blobId, ...saveToInput(i) }, "user"));
      return routineWire(svc.view(saved));
    });
  },

  [BLOB_METHODS.routinesSetPaused]: (input) => {
    const i = input as RoutineSetPausedInput;
    return callAsync("routinesSetPaused", async () => {
      const svc = routinesOf("routinesSetPaused");
      const saved = unwrap("routinesSetPaused", svc.update(i.routineId, { paused: i.paused }));
      return routineWire(svc.view(saved));
    });
  },

  [BLOB_METHODS.routinesRemove]: (input) => {
    const i = input as RoutineIdInput;
    return callAsync("routinesRemove", async () => {
      unwrap("routinesRemove", routinesOf("routinesRemove").remove(i.routineId), "not_found");
      return {};
    });
  },

  [BLOB_METHODS.routinesRunNow]: (input) => {
    const i = input as RoutineIdInput;
    return callAsync("routinesRunNow", async () => {
      const r = await routinesOf("routinesRunNow").runNow(i.routineId);
      if (!r.ok) throw fail("routinesRunNow", r.reason, "cannot_run");
      return { runId: r.runId };
    });
  },

  [BLOB_METHODS.routinesCancelRun]: (input) => {
    const i = input as RoutineRunIdInput;
    return callAsync("routinesCancelRun", async () => {
      if (!(await routinesOf("routinesCancelRun").cancelRun(i.runId)))
        throw fail("routinesCancelRun", "That run is not running any more.", "not_running");
      return {};
    });
  },

  [BLOB_METHODS.routinesCreateTrigger]: (input) => {
    const i = input as RoutineCreateTriggerInput;
    return callAsync("routinesCreateTrigger", async () =>
      unwrap(
        "routinesCreateTrigger",
        routinesOf("routinesCreateTrigger").createTrigger(i.routineId, i.label),
      ),
    );
  },

  [BLOB_METHODS.routinesRotateTrigger]: (input) => {
    const i = input as RoutineTriggerIdInput;
    return callAsync("routinesRotateTrigger", async () =>
      unwrap(
        "routinesRotateTrigger",
        routinesOf("routinesRotateTrigger").rotateTrigger(i.routineId, i.triggerId),
      ),
    );
  },

  [BLOB_METHODS.routinesDeleteTrigger]: (input) => {
    const i = input as RoutineTriggerIdInput;
    return callAsync("routinesDeleteTrigger", async () => {
      unwrap(
        "routinesDeleteTrigger",
        routinesOf("routinesDeleteTrigger").deleteTrigger(i.routineId, i.triggerId),
        "not_found",
      );
      return {};
    });
  },

  [BLOB_METHODS.routinesConfirm]: (input) => {
    const i = input as RoutineConfirmInput;
    return callAsync("routinesConfirm", async () => {
      const card = unwrap(
        "routinesConfirm",
        routinesOf("routinesConfirm").confirm(i.token, i.accept),
        "expired",
      ) as RoutineConfirmCardPayload;
      // the transcript's card flips to its answered state (the answer also comes back to the card that was clicked)
      chatEngine().updateBlobCard(card);
      return card;
    });
  },
};
