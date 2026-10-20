import { useAtomValue } from "@effect/atom-react";
import { AVAILABLE_LINK_STATE } from "@kora/client-runtime/link";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { usePrimaryHostId } from "~/atoms/hosts";
import { useAtomAction } from "~/atoms/use-atom-command";
import { hostCatalog } from "~/link/catalog";

import { Button } from "../../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../ui/empty";

/**
 * Covers the landing wait once the link to the daemon has failed an attempt. The link keeps retrying with
 * backoff by itself; this only says so, and lets the user retry right now.
 */
export default function LandingUnreachable() {
  const hostId = usePrimaryHostId();
  const link = Option.getOrElse(
    AsyncResult.value(useAtomValue(hostCatalog.stateAtom(hostId as never))),
    () => AVAILABLE_LINK_STATE,
  );
  const retryNow = useAtomAction(hostCatalog.retryNow, { reportFailure: false });
  if (hostId === null || link.lastFailure === null || link.phase === "connected") return null;
  return (
    <Empty className="absolute inset-0 bg-background" role="alert" data-landing-unreachable>
      <EmptyHeader className="max-w-sm">
        <EmptyTitle className="text-foreground text-lg">Can’t reach Kora</EmptyTitle>
        <EmptyDescription className="mt-2 text-sm">
          Kora’s background service isn’t answering. Retrying automatically.
        </EmptyDescription>
        <div className="mt-4 flex justify-center">
          <Button size="sm" variant="outline" onClick={() => void retryNow(hostId)}>
            Retry
          </Button>
        </div>
      </EmptyHeader>
    </Empty>
  );
}
