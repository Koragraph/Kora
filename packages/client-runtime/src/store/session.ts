import type { DaemonConfig, DaemonSessionState, HostId } from "@kora/contracts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/unstable/http";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { errorLogFields } from "../failures/logFields.ts";
import { hostEndpointUrl } from "../host/endpoint.ts";
import type { PreparedLink } from "../link/model.ts";
import type { HostRegistry } from "../link/registry.ts";
import * as HostSupervisor from "../link/supervisor.ts";
import { executeAuthenticatedHostHttpRequest } from "./hostHttpAuth.ts";
import { followStreamInHost } from "./runtime.ts";

const SESSION_STATE_TIMEOUT_MS = 6_000;

/** Per-host facts about the transport session: bootstrap config, prepared link, granted scopes. */
export function createHostSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<HostRegistry | HttpClient.HttpClient | R, E>,
) {
  // Only the config captured when the socket session was established; current settings and
  // providers come from the server atoms' config value.
  const initialConfigAtom = Atom.family((hostId: HostId) =>
    runtime
      .atom(
        followStreamInHost(
          hostId,
          Stream.unwrap(
            Effect.gen(function* () {
              const supervisor = yield* HostSupervisor.HostSupervisor;
              return SubscriptionRef.changes(supervisor.session).pipe(
                Stream.mapEffect((session) =>
                  Option.isNone(session)
                    ? Effect.succeed(Option.none<DaemonConfig>())
                    : session.value.initialConfig.pipe(
                        Effect.map(Option.some),
                        Effect.catch((error) =>
                          Effect.logWarning(
                            "Could not load the initial environment configuration.",
                            {
                              hostId,
                              ...errorLogFields(error),
                            },
                          ).pipe(Effect.as(Option.none<DaemonConfig>())),
                        ),
                      ),
                ),
              );
            }),
          ),
        ),
        { initialValue: Option.none<DaemonConfig>() },
      )
      .pipe(Atom.withLabel(`environment-config:${hostId}`)),
  );

  const initialConfigValueAtom = Atom.family((hostId: HostId) =>
    Atom.make((get): DaemonConfig | null =>
      Option.getOrNull(Option.flatten(AsyncResult.value(get(initialConfigAtom(hostId))))),
    ).pipe(Atom.withLabel(`environment-config-value:${hostId}`)),
  );

  const preparedConnectionAtom = Atom.family((hostId: HostId) =>
    runtime
      .atom(
        followStreamInHost(
          hostId,
          Stream.unwrap(
            Effect.gen(function* () {
              const supervisor = yield* HostSupervisor.HostSupervisor;
              return SubscriptionRef.changes(supervisor.prepared);
            }),
          ),
        ),
        { initialValue: Option.none<PreparedLink>() },
      )
      .pipe(Atom.withLabel(`environment-prepared-connection-source:${hostId}`)),
  );

  const preparedConnectionValueAtom = Atom.family((hostId: HostId) =>
    Atom.make((get): Option.Option<PreparedLink> =>
      Option.getOrElse(AsyncResult.value(get(preparedConnectionAtom(hostId))), () =>
        Option.none<PreparedLink>(),
      ),
    ).pipe(Atom.withLabel(`environment-prepared-connection:${hostId}`)),
  );

  // Re-fetched whenever a reconnect swaps the prepared link, so scope changes are picked up without a refresh.
  const sessionStateAtom = Atom.family((hostId: HostId) =>
    runtime
      .atom((get) =>
        Effect.gen(function* () {
          const prepared = get(preparedConnectionValueAtom(hostId));
          if (Option.isNone(prepared)) return yield* Effect.never;
          return yield* executeAuthenticatedHostHttpRequest({
            prepared: prepared.value,
            method: "GET",
            url: (httpBaseUrl) => hostEndpointUrl(httpBaseUrl, "/api/auth/session"),
            // A wedged environment must not pin the permissions check in "loading".
            timeoutMs: SESSION_STATE_TIMEOUT_MS,
            group: "auth",
            request: ({ client, headers }) => client.session({ headers }),
          });
        }),
      )
      .pipe(
        Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-session-state:${hostId}`),
      ),
  );

  const sessionStateValueAtom = Atom.family((hostId: HostId) =>
    Atom.make((get): DaemonSessionState | null =>
      Option.getOrNull(AsyncResult.value(get(sessionStateAtom(hostId)))),
    ).pipe(Atom.withLabel(`environment-session-state-value:${hostId}`)),
  );

  return {
    sessionStateValueAtom,
    sessionStateAtom,
    preparedConnectionValueAtom,
    preparedConnectionAtom,
    initialConfigValueAtom,
    initialConfigAtom,
  };
}
