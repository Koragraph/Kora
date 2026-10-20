import { createFileRoute } from "@tanstack/react-router";

import { OutsideAccessSettings } from "../components/blobs/outside";
import { searchableSetting } from "../components/prefs/prefsSearch";
import { KoraComingSoonSettingsNote } from "../components/kora/KoraComingSoon";
import { useKoraSurfaceOn } from "../koraSurface";

function SettingsOutsideRoute() {
  if (!useKoraSurfaceOn()) return <KoraComingSoonSettingsNote />;
  return <OutsideAccessSettings anchorId={searchableSetting("outside-access").id} />;
}

export const Route = createFileRoute("/settings/outside")({
  component: SettingsOutsideRoute,
});
