import type {
  SwarmClearKeyInput,
  SwarmGetStatusInput,
  SwarmInstallCancelInput,
  SwarmInstallStartInput,
  SwarmSetConsentInput,
  SwarmSetKeyInput,
  SwarmSetPreferencesInput,
  SwarmStatus,
  SwarmStreamEvent,
  SwarmTestProviderInput,
} from "@kora/contracts";
import { RPC_METHODS, SwarmOperationError } from "@kora/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { host } from "../host.ts";
import { type HandlerRecord, jsonSafe } from "./shared.ts";

/**
 * Swarm setup handlers: thin delegation to the runtime's `SwarmSetup` (`UiHost.swarm`, in-process). Each RPC calls the
 * `KoraSwarmLike` method of the same verb (ref-reconciled R1). Every unary result and every stream frame goes through
 * `jsonSafe` (a nested undefined tears the socket). A failure is a typed `SwarmOperationError` — never a defect, never
 * a hang (an auto-stubbed RPC hangs forever; `handlers.test.ts` guards that these stay real).
 */

const message = (cause: unknown): string => String((cause as Error)?.message ?? cause);

const call = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SwarmOperationError({ operation, message: message(cause) }),
  }).pipe(Effect.map((value) => jsonSafe(value)));

/** Snapshot-only status stream: seed with getStatus(), then every onStatus. Held open; never fails or completes. */
const statusStream = (): Stream.Stream<SwarmStreamEvent> =>
  Stream.callback<SwarmStreamEvent>((queue) =>
    Effect.gen(function* () {
      const emit = (status: SwarmStatus) =>
        Queue.offerUnsafe(queue, jsonSafe({ type: "snapshot", status } as const));
      let unsubscribe: (() => void) | null = null;
      try {
        unsubscribe = host().swarm.onStatus(emit);
      } catch (cause) {
        host().log(`[kora-ui] swarm.subscribe: onStatus unavailable (${message(cause)})`);
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            unsubscribe?.();
          } catch {
            /* already gone */
          }
        }),
      );
      yield* Effect.promise(() =>
        host()
          .swarm.getStatus()
          .then(emit, (cause: unknown) =>
            host().log(`[kora-ui] swarm.subscribe: initial status failed (${message(cause)})`),
          ),
      );
      return yield* Effect.never;
    }),
  );

export const swarmHandlers: HandlerRecord = {
  [RPC_METHODS.swarmSubscribe]: () => statusStream(),
  [RPC_METHODS.swarmGetStatus]: (input) => {
    const i = input as SwarmGetStatusInput;
    return call("getStatus", () =>
      host().swarm.getStatus(i.probe === undefined ? {} : { probe: i.probe }),
    );
  },
  [RPC_METHODS.swarmInstallStart]: (input) =>
    call("installStart", () => host().swarm.installStart(input as SwarmInstallStartInput)),
  [RPC_METHODS.swarmInstallCancel]: (input) =>
    call("installCancel", () => host().swarm.installCancel(input as SwarmInstallCancelInput)),
  [RPC_METHODS.swarmSetKey]: (input) =>
    call("setKey", () => host().swarm.setKey(input as SwarmSetKeyInput)),
  [RPC_METHODS.swarmClearKey]: (input) =>
    call("clearKey", () => host().swarm.clearKey(input as SwarmClearKeyInput)),
  [RPC_METHODS.swarmTestProvider]: (input) =>
    call("testProvider", () => host().swarm.testProvider(input as SwarmTestProviderInput)),
  [RPC_METHODS.swarmSetConsent]: (input) =>
    call("setConsent", () => host().swarm.setConsent(input as SwarmSetConsentInput)),
  [RPC_METHODS.swarmSetPreferences]: (input) =>
    call("setPreferences", () => host().swarm.setPreferences(input as SwarmSetPreferencesInput)),
};
