import { createFileRoute } from "@tanstack/react-router";
import { HostId, AgentProfileId } from "@kora/contracts";

import { AgentsPrefsPanel } from "../components/prefs/agents/AgentsPrefsPanel";
import { usePrefsScope } from "../components/prefs/PrefsScopeContext";

/** Settings › Agents. Agents are machine state: the page edits this Mac's daemon. */
function SettingsProvidersRoute() {
  const dest = Route.useSearch();
  const { environment, scope } = usePrefsScope();
  if (environment === null || environment === undefined) {
    return (
      <p className="text-sm text-muted-foreground p-8">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to set up its agents.`
          : "Waiting for Kora's daemon to set up agents."}
      </p>
    );
  }
  return (
    <AgentsPrefsPanel
      hostId={environment.hostId}
      {...(dest.instanceId ? { targetInstanceId: dest.instanceId } : {})}
    />
  );
}

export const Route = createFileRoute("/settings/providers")({
  validateSearch: (unparsed: Record<string, unknown>) => ({
    ...(typeof unparsed.hostId === "string" && unparsed.hostId.trim()
      ? { hostId: HostId.make(unparsed.hostId) }
      : {}),
    ...(typeof unparsed.instanceId === "string" && unparsed.instanceId.trim()
      ? { instanceId: AgentProfileId.make(unparsed.instanceId) }
      : {}),
  }),
  component: SettingsProvidersRoute,
});
