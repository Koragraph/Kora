import { createFileRoute } from "@tanstack/react-router";

import { ConnectionsSettings } from "../components/blobs/apps/ConnectionsSettings";
import { searchableSetting } from "../components/prefs/prefsSearch";
import { KoraComingSoonSettingsNote } from "../components/kora/KoraComingSoon";
import { useKoraSurfaceOn } from "../koraSurface";

function SettingsConnectionsRoute() {
  if (!useKoraSurfaceOn()) return <KoraComingSoonSettingsNote />;
  return <ConnectionsSettings anchorId={searchableSetting("connected-apps").id} />;
}

export const Route = createFileRoute("/settings/connections")({
  component: SettingsConnectionsRoute,
});
