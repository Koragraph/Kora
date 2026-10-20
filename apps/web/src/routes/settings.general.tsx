import { createFileRoute } from "@tanstack/react-router";

import { GeneralPrefsPanel } from "../components/prefs/PrefsPanels";

function SettingsGeneralRoute() {
  return <GeneralPrefsPanel />;
}

export const Route = createFileRoute("/settings/general")({
  component: SettingsGeneralRoute,
});
