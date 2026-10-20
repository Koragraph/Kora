"use client";

import {
  reconcileWebDaemonSessions,
  applyWebDaemonEvent,
  readThreadWebState,
} from "~/stores/webStateStore";
import { webHost } from "~/atoms/preview";
import type { HostThreadRef } from "@kora/contracts";
import { parseHostThreadKey, hostThreadKey } from "@kora/client-runtime/host";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import * as Schema from "effect/Schema";
import { useAtomValue } from "@effect/atom-react";

const threadKeyFields = { threadKey: Schema.String };

class WebSessionThreadKeyParseError extends Schema.TaggedError<WebSessionThreadKeyParseError>()(
  "WebSessionThreadKeyParseError",
  threadKeyFields,
) {
  override get message(): string {
    return `Invalid scoped preview thread key: ${this.threadKey}`;
  }
}

const webSessionSyncAtom = Atom.family((threadKey: string) => {
  const threadRef = parseHostThreadKey(threadKey);
  if (threadRef === null) {
    throw new WebSessionThreadKeyParseError({ threadKey });
  }

  const sessionsAtom = webHost.list({
    hostId: threadRef.hostId,
    input: { threadId: threadRef.threadId },
  });
  const eventsAtom = webHost.events({
    hostId: threadRef.hostId,
    input: {},
  });

  return Atom.make((get) => {
    let eventsVersion = 0;
    let disposed = false;

    const reconcileSessions = (result: Atom.Type<typeof sessionsAtom>) => {
      if (!AsyncResult.isSuccess(result)) {
        return;
      }
      reconcileWebDaemonSessions(threadRef, result.value);
    };

    const applyLatestEvent = (result: Atom.Type<typeof eventsAtom>) => {
      if (!AsyncResult.isSuccess(result) || result.value.threadId !== threadRef.threadId) return;
      const currentEpoch = readThreadWebState(threadRef).serverEpoch;
      if (currentEpoch !== null && currentEpoch !== result.value.serverEpoch) {
        get.refresh(sessionsAtom);
        return;
      }
      applyWebDaemonEvent(threadRef, result.value);
    };

    const markDisposed = () => {
      disposed = true;
    };
    get.addFinalizer(markDisposed);
    const initialEvent = get.once(eventsAtom);
    get.subscribe(sessionsAtom, reconcileSessions);
    const onEvents = (result: Atom.Type<typeof eventsAtom>) => {
      eventsVersion += 1;
      applyLatestEvent(result);
    };
    get.subscribe(eventsAtom, onEvents);
    queueMicrotask(() => {
      if (disposed) {
        return;
      }
      // The cached list can predate an automation-created tab. Keep the local
      // snapshot visible until an authoritative refresh arrives instead of
      // reconciling against a stale empty result when the panel first mounts.
      get.refresh(sessionsAtom);
      if (eventsVersion === 0) {
        applyLatestEvent(initialEvent);
      }
    });
  }).pipe(Atom.setIdleTTL(1_000), Atom.withLabel(`preview:session-sync:${threadKey}`));
});

export function useWebSession(threadRef: HostThreadRef): void {
  useAtomValue(webSessionSyncAtom(hostThreadKey(threadRef)));
}
