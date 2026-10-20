import { createFileRoute } from "@tanstack/react-router";

import { searchableSetting } from "../components/prefs/prefsSearch";
import { EnginesSettings } from "../components/settings/engines/EnginesSettings";

function SettingsEnginesRoute() {
  return <EnginesSettings anchorId={searchableSetting("engines").id} />;
}

export const Route = createFileRoute("/settings/engines")({
  component: SettingsEnginesRoute,
});
