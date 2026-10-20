import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { AuthStandardClientScopes, PRIMARY_LOCAL_HOST_ID } from "@kora/contracts";
import { HostRpcRequestObserver } from "@kora/client-runtime/wire";
import {
  PrimaryHostAuth,
  PlatformLinkSource,
  HostOwnedDataCleanup,
  ClientPresentation,
} from "@kora/client-runtime/embedder";
import {
  mapRemoteHostError,
  Wakeups,
  LocalLinkTarget,
  LocalLinkRegistration,
  LinkTransientError,
  Connectivity,
} from "@kora/client-runtime/link";
import { fetchRemoteHostDescriptor } from "@kora/client-runtime/host";
import { errorLogFields } from "@kora/client-runtime/failures";

import { linkStorageLayer } from "./storage";
import { clientPresentationMetadata } from "./clientMetadata";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../wire/requestLatencyState";
import { clearPromptDraftsHost } from "../stores/promptDraftStore";
import { readPrimaryHostTarget, type PrimaryHostTarget } from "../hosts/primary/target";
import { readVerifiedShellPrimaryBearerToken } from "../hosts/primary/shellAuth";
import { primaryHostHttpLayer } from "../hosts/primary/httpLayer";
import { APP_VERSION } from "../branding";

const REGISTRATION_POLL_MS = 3_000;

export type PrimaryHostTargetRead =
  | { _tag: "Success"; target: PrimaryHostTarget | null }
  | { _tag: "Failure"; cause: unknown };

type CachedPlatformRegistration = {
  signature: string;
  registration: LocalLinkRegistration;
};

export function readPrimaryHostTargetResult(
  readTarget: () => PrimaryHostTarget | null = readPrimaryHostTarget,
): PrimaryHostTargetRead {
  let target: PrimaryHostTarget | null;
  try {
    target = readTarget();
  } catch (cause) {
    return { _tag: "Failure", cause };
  }
  return { _tag: "Success", target };
}

/** A bridge hiccup must not drop a working connection; only a clean "no daemon" does. */
export function primaryRegistrationToRetainAfterTopologyRead(
  prior: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: PrimaryHostTargetRead,
): CachedPlatformRegistration | undefined {
  return topologyRead._tag === "Failure" ? prior.get(PRIMARY_LOCAL_HOST_ID) : undefined;
}

// ---------- connectivity + wakeups ----------

const networkStatus = () =>
  typeof navigator === "undefined" ? "unknown" : navigator.onLine ? "online" : "offline";

const connectivityLayer = Connectivity.layer({
  changes: Stream.callback((queue) => {
    const handlers = {
      online: () => Queue.offerUnsafe(queue, "online"),
      offline: () => Queue.offerUnsafe(queue, "offline"),
    };
    const attach = Effect.sync(() => {
      for (const [name, handler] of Object.entries(handlers)) {
        window.addEventListener(name, handler);
      }
    });
    const detach = () =>
      Effect.sync(() => {
        for (const [name, handler] of Object.entries(handlers)) {
          window.removeEventListener(name, handler);
        }
      });
    return Effect.acquireRelease(attach, detach);
  }),
  status: Effect.sync(networkStatus),
});

const wakeupsLayer = Wakeups.layer({
  changes: Stream.callback((queue) => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      Queue.offerUnsafe(queue, "application-active");
    };
    return Effect.acquireRelease(
      Effect.sync(() => document.addEventListener("visibilitychange", onVisibility)),
      () => Effect.sync(() => document.removeEventListener("visibilitychange", onVisibility)),
    );
  }),
});

// ---------- who we are + how we sign in ----------

const presentationLayer = Layer.succeed(ClientPresentation, {
  metadata: clientPresentationMetadata({
    appVersion: APP_VERSION,
    hosted: false,
    identity: {
      userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      platform: typeof navigator === "undefined" ? "" : navigator.platform,
      maxTouchPoints: typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints,
    },
    shellBridge: typeof window === "undefined" ? undefined : window.shellBridge,
  }),
  scopes: AuthStandardClientScopes,
});

const primaryAuthLayer = Layer.succeed(PrimaryHostAuth, {
  // Runs on every connect and reconnect, with a fresh proof that the server is this Mac's daemon.
  bearerToken: Effect.tryPromise({
    try: () => readVerifiedShellPrimaryBearerToken({ fresh: true }),
    catch: (cause) =>
      new LinkTransientError({
        reason: "endpoint-unavailable",
        detail: `Could not load or verify the desktop primary credential: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  }).pipe(Effect.map(Option.fromNullishOr)),
});

// ---------- the one daemon, polled ----------

function registrationsStream() {
  return Stream.unwrap(
    Effect.sync(() => {
      let cache = new Map<string, CachedPlatformRegistration>();

      const refresh = Effect.gen(function* () {
        const read = readPrimaryHostTargetResult();
        if (read._tag === "Failure") {
          yield* Effect.logWarning(
            "Could not read the local daemon address.",
            errorLogFields(read.cause),
          );
          const retained = primaryRegistrationToRetainAfterTopologyRead(cache, read);
          cache = new Map(retained ? [[PRIMARY_LOCAL_HOST_ID, retained]] : []);
          return [...cache.values()].map((ch) => ch.registration);
        }
        const dest = read.target;
        if (dest === null) {
          cache = new Map();
          return [];
        }

        const { httpBaseUrl, wsBaseUrl } = dest.target;
        const signature = `primary|${httpBaseUrl}|${wsBaseUrl}`;
        const memo = cache.get(PRIMARY_LOCAL_HOST_ID);
        if (memo?.signature === signature) return [memo.registration];

        const descriptor = yield* fetchRemoteHostDescriptor({ httpBaseUrl }).pipe(
          Effect.provide(primaryHostHttpLayer),
          Effect.mapError(mapRemoteHostError),
          Effect.option,
        );
        if (Option.isNone(descriptor)) {
          yield* Effect.logWarning("Could not reach the local daemon.");
          cache = new Map();
          return [];
        }
        const registration = new LocalLinkRegistration({
          target: new LocalLinkTarget({
            hostId: descriptor.value.hostId,
            label: descriptor.value.label,
            httpBaseUrl,
            wsBaseUrl,
          }),
        });
        cache = new Map([[PRIMARY_LOCAL_HOST_ID, { signature, registration }]]);
        return [registration];
      });

      return Stream.make(undefined).pipe(
        Stream.concat(Stream.tick(`${REGISTRATION_POLL_MS} millis`)),
        Stream.mapEffect(() => refresh),
      );
    }),
  );
}

const linkSourceLayer = Layer.succeed(PlatformLinkSource, { registrations: registrationsStream() });

const cleanupLayer = Layer.succeed(HostOwnedDataCleanup, {
  clear: (hostKey) => Effect.sync(() => clearPromptDraftsHost(hostKey)),
});

let requestCounter = 0;
const observerLayer = Layer.succeed(HostRpcRequestObserver, {
  observe: ({ hostId, method }) =>
    Effect.sync(() => {
      const ident = `${hostId}:${++requestCounter}`;
      trackRpcRequestSent(ident, method, `${method} · ${hostId}`);
      return Effect.sync(() => acknowledgeRpcRequest(ident));
    }),
});

export const linkPlatformLayer = Layer.mergeAll(
  connectivityLayer,
  wakeupsLayer,
  presentationLayer,
  primaryAuthLayer,
  linkSourceLayer,
  cleanupLayer,
  observerLayer,
  linkStorageLayer,
);
