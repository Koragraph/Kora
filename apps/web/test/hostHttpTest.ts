import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  DaemonSessionId,
  HostAuthenticatedAuth,
  HostAuthenticatedPrincipal,
  HostHttpApi,
  type AuthHostScope,
  type BrowserAuthSessionRequest,
  type BrowserAuthSessionResult,
  type DaemonSessionState,
  type HostAuthInvalidError,
  type HostDescriptor,
} from "@kora/contracts";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { HttpApiTest } from "effect/unstable/httpapi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { PrimaryHostHttpClient } from "../src/hosts/primary/httpClient";
import { __setPrimaryHttpRunnerForTests } from "../src/util/runtime";

/** Canned answers for the host's HTTP endpoints; an endpoint left out dies if the code under test calls it. */
interface HostHttpTestScenario {
  readonly descriptor?: () => Effect.Effect<HostDescriptor>;
  readonly session?: () => Effect.Effect<DaemonSessionState>;
  readonly browserSession?: (
    payload: BrowserAuthSessionRequest,
  ) => Effect.Effect<BrowserAuthSessionResult, HostAuthInvalidError>;
}

/** How often each endpoint was hit (and with what, for the one that takes a body). */
export interface HostHttpTestCalls {
  descriptor: number;
  session: number;
  browserSession: Array<BrowserAuthSessionRequest>;
}

const failUnscripted = (endpoint: string) =>
  Effect.die(new Error(`Unexpected environment HTTP endpoint: ${endpoint}`));

/** Pretends every request already carries a valid browser-session principal. */
const alwaysSignedIn: Context.Service.Shape<typeof HostAuthenticatedAuth> = (inner) =>
  Effect.provideService(inner, HostAuthenticatedPrincipal, {
    method: "browser-session-cookie",
    subject: "test-client",
    sessionId: DaemonSessionId.make("test-session"),
    scopes: new Set<AuthHostScope>(),
    expiresAt: DateTime.makeUnsafe("2026-05-01T12:00:00.000Z"),
  });

const metadataGroup = (scenario: HostHttpTestScenario, calls: HostHttpTestCalls) =>
  HttpApiBuilder.group(HostHttpApi, "metadata", (api) =>
    api.handle("descriptor", () =>
      Effect.suspend(() => {
        calls.descriptor++;
        return scenario.descriptor ? scenario.descriptor() : failUnscripted("metadata.descriptor");
      }),
    ),
  );

const authGroup = (scenario: HostHttpTestScenario, calls: HostHttpTestCalls) =>
  HttpApiBuilder.group(HostHttpApi, "auth", (api) =>
    api
      .handle("session", () =>
        Effect.suspend(() => {
          calls.session++;
          return scenario.session ? scenario.session() : failUnscripted("auth.session");
        }),
      )
      .handle("browserSession", ({ payload }) =>
        Effect.suspend(() => {
          calls.browserSession.push(payload);
          return scenario.browserSession
            ? scenario.browserSession(payload)
            : failUnscripted("auth.browserSession");
        }),
      )
      .handle("token", () => failUnscripted("auth.token"))
      .handle("webSocketTicket", () => failUnscripted("auth.webSocketTicket")),
  );

/**
 * Routes the primary host's HTTP client to an in-process server that answers from `scenario`.
 * Call `dispose()` in teardown to restore the real runner.
 */
export async function installHostHttpTest(scenario: HostHttpTestScenario) {
  const calls: HostHttpTestCalls = { descriptor: 0, session: 0, browserSession: [] };

  const client = await Effect.runPromise(
    HttpApiTest.groups(HostHttpApi, ["metadata", "auth"]).pipe(
      Effect.provide([
        NodeHttpServer.layerHttpServices,
        metadataGroup(scenario, calls),
        authGroup(scenario, calls),
      ]),
      Effect.provideService(HostAuthenticatedAuth, alwaysSignedIn),
      Effect.scoped,
    ),
  );

  const runtime = ManagedRuntime.make(Layer.succeed(PrimaryHostHttpClient, client));
  __setPrimaryHttpRunnerForTests((effect) => runtime.runPromise(effect));

  return {
    calls,
    dispose: async () => {
      __setPrimaryHttpRunnerForTests();
      await runtime.dispose();
    },
  };
}
