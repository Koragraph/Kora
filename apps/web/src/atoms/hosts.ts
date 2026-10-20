import { useMemo } from "react";
import * as Option from "effect/Option";
import type { HostId } from "@kora/contracts";
import {
  linkCatalogDisplayUrl,
  type HostPresentation as BaseHostPresentation,
} from "@kora/client-runtime/link";
import { useAtomValue } from "@effect/atom-react";

import { usePreparedLink } from "./session";
import { primaryHostIdAtom } from "./primaryHost";
import { hostPresentations, useHostPresentation } from "./presentation";
import { hostCatalog } from "../link/catalog";

export interface HostPresentation extends BaseHostPresentation {
  readonly hostId: HostId;
  readonly label: string;
  readonly displayUrl: string | null;
}

function projectHostPresentation(
  hostKey: HostId,
  presentation: BaseHostPresentation,
): HostPresentation {
  return {
    ...presentation,
    hostId: hostKey,
    label: presentation.entry.target.label,
    displayUrl: linkCatalogDisplayUrl(presentation.entry),
  };
}

export function useHosts() {
  const catalog = useAtomValue(hostCatalog.catalogEntryAtom);
  const networkStatus = useAtomValue(hostCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(hostPresentations.presentationsAtom);

  const environments = useMemo(
    () =>
      [...presentationById.entries()].map(([hostId, presentation]) =>
        projectHostPresentation(hostId, presentation),
      ),
    [presentationById],
  );

  return {
    presentationById,
    environments,
    networkStatus,
    isReady: catalog.isReady,
  };
}

export function usePrimaryHostId(): HostId | null {
  return useAtomValue(primaryHostIdAtom);
}

function useHost(hostKey: HostId | null): HostPresentation | null {
  const { presentation } = useHostPresentation(hostKey);
  return useMemo(
    () =>
      hostKey === null || presentation === null
        ? null
        : projectHostPresentation(hostKey, presentation),
    [hostKey, presentation],
  );
}

export function usePrimaryHost(): HostPresentation | null {
  return useHost(usePrimaryHostId());
}

export function useHostHttpBaseUrl(hostKey: HostId | null): string | null {
  const prepared = usePreparedLink(hostKey);
  return Option.isSome(prepared) ? prepared.value.httpBaseUrl : null;
}
