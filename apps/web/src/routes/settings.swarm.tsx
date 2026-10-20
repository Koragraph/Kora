import { createFileRoute } from "@tanstack/react-router";

import { SwarmPrefsPanel } from "../components/prefs/SwarmPrefsPanel";
import { usePrefsScope } from "../components/prefs/PrefsScopeContext";

/** Swarm setup is machine state (OpenCode, keys, consent), so it follows the selected environment. */
function SettingsSwarmRoute() {
  const { environment, scope } = usePrefsScope();
  if (environment === null || environment === undefined) {
    return (
      <p className="text-sm text-muted-foreground p-8">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to set up Swarm.`
          : "Connect an environment to set up Swarm."}
      </p>
    );
  }
  return <SwarmPrefsPanel hostId={environment.hostId} />;
}

export const Route = createFileRoute("/settings/swarm")({
  component: SettingsSwarmRoute,
});
