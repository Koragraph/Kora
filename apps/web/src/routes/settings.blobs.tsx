import { createFileRoute } from "@tanstack/react-router";

import { BlobsSettings } from "../components/blobs/settings/BlobsSettings";
import { searchableSetting } from "../components/prefs/prefsSearch";
import { KoraComingSoonSettingsNote } from "../components/kora/KoraComingSoon";
import { useKoraSurfaceOn } from "../koraSurface";

function SettingsBlobsRoute() {
  if (!useKoraSurfaceOn()) return <KoraComingSoonSettingsNote />;
  // The search catalog owns the "About me" anchor id; the page renders it.
  return <BlobsSettings aboutMe={searchableSetting("blobs-about-me")} />;
}

export const Route = createFileRoute("/settings/blobs")({
  component: SettingsBlobsRoute,
});
