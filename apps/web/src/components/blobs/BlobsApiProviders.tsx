// Mounts the daemon-backed client APIs of the Blobs surface that are shared by many places: routines (the Runs tab, the
// report / confirm cards in a transcript) and connected apps (the Apps page, Settings > Connections, grants editor, chips).
// Once, near the root, so a card deep in a transcript and the side panel talk through the same instance.
import type { ReactNode } from "react";

import { AppsApiProvider } from "./apps/appsApi";
import { useRpcAppsApi } from "./apps/useRpcAppsApi";
import { OutsideApiProvider } from "./outside/outsideApi";
import { useRpcOutsideApi } from "./outside/useRpcOutsideApi";
import { RoutinesApiProvider } from "./routines/routinesApi";
import { useRpcRoutinesApi } from "./routines/useRpcRoutinesApi";

export function BlobsApiProviders(props: { readonly children: ReactNode }) {
  const routines = useRpcRoutinesApi();
  const apps = useRpcAppsApi();
  const outside = useRpcOutsideApi();
  return (
    <RoutinesApiProvider api={routines}>
      <AppsApiProvider api={apps}>
        <OutsideApiProvider api={outside}>{props.children}</OutsideApiProvider>
      </AppsApiProvider>
    </RoutinesApiProvider>
  );
}
