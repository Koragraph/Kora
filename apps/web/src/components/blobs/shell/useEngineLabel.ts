// The blob engine -> the name the composer's model picker shows (daemon provider catalog), one place for every label.
import type { BlobEngine } from "@kora/contracts";
import { useCallback } from "react";

import { useHosts, usePrimaryHostId } from "~/atoms/hosts";
import { EMPTY_DAEMON_AGENTS } from "~/atoms/server";
import { engineLabel } from "./engineLabel";

export function useEngineLabel(): (engine: Pick<BlobEngine, "instanceId" | "model">) => string {
  const hostId = usePrimaryHostId();
  const { environments } = useHosts();
  const providers =
    environments.find((e) => e.hostId === hostId)?.daemonConfig?.providers ?? EMPTY_DAEMON_AGENTS;
  return useCallback(
    (engine) => engineLabel(engine, (id) => providers.find((p) => p.instanceId === id)?.models),
    [providers],
  );
}
