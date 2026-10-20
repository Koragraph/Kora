import { createFileRoute } from "@tanstack/react-router";

import { searchableSetting } from "../components/prefs/prefsSearch";
import { ExtensionsSettings } from "../components/settings/extensions/ExtensionsSettings";

function SettingsExtensionsRoute() {
  return <ExtensionsSettings anchorId={searchableSetting("extensions").id} />;
}

export const Route = createFileRoute("/settings/extensions")({
  component: SettingsExtensionsRoute,
});
