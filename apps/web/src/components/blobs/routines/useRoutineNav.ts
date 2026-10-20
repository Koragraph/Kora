// Where "Open run" / "Back to results" go: the thread route of the primary host. A routine's execution thread is hidden
// from every list but stays reachable by id, so a plain navigation is enough.
import { hostThreadRef } from "@kora/client-runtime/host";
import { useRouter } from "@tanstack/react-router";
import { useMemo } from "react";

import { usePrimaryHostId } from "~/atoms/hosts";
import { threadPageParams } from "~/thread/threadRoutes";
import type { RoutineNav } from "./routinesApi";

export function useRoutineNav(): RoutineNav {
  const router = useRouter();
  const hostId = usePrimaryHostId();
  return useMemo<RoutineNav>(
    () => ({
      openThread: (threadId) => {
        if (hostId === null) return;
        void router.navigate({
          to: "/$hostId/$threadId",
          params: threadPageParams(hostThreadRef(hostId, threadId as never)),
        });
      },
    }),
    [router, hostId],
  );
}
