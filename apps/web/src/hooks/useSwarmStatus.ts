import type { HostId, SwarmStatus } from "@kora/contracts";

import { useDaemonConfigs } from "../atoms/entities";
import { useHostQuery } from "../atoms/query";
import { swarmHost } from "../atoms/swarm";

/**
 * The host's live Swarm readiness. `supported` is the host capability `swarm`; the status stream is
 * subscribed only when it is true (older daemons do not serve `swarm.subscribe`).
 */
export function useSwarmStatus(hostId: HostId | null): {
  readonly supported: boolean;
  readonly status: SwarmStatus | null;
} {
  const configs = useDaemonConfigs();
  const supported = hostId !== null && configs.get(hostId)?.environment.capabilities.swarm === true;
  const query = useHostQuery(
    supported && hostId !== null ? swarmHost.status({ hostId, input: {} }) : null,
  );
  return { supported, status: query.data?.status ?? null };
}
