import { useMemo } from "react";

import { useHosts } from "~/atoms/hosts";
import { useKoraSurfaceOn } from "~/koraSurface";
import { isAgentPrefsHostAvailable } from "./AgentPrefsPanel.logic";
import { filterAvailablePrefsSearchItems } from "./prefsSearch";

export function useAvailablePrefsSearchItems() {
  const { environments } = useHosts();
  const koraSurfaceOn = useKoraSurfaceOn();

  return useMemo(
    () =>
      filterAvailablePrefsSearchItems({
        hasHost: environments.some((environment) => environment.daemonConfig !== null),
        hasSwarm: environments.some(
          (environment) => environment.daemonConfig?.environment.capabilities.swarm === true,
        ),
        hasProviderSettingsHost: environments.some((environment) =>
          isAgentPrefsHostAvailable({
            connectionPhase: environment.connection.phase,
            hasDaemonConfig: environment.daemonConfig !== null,
          }),
        ),
        koraSurfaceOn,
      }),
    [environments, koraSurfaceOn],
  );
}
