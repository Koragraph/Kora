// "Allow this app for this blob": the UX ruling for a Connect chip shown inside a blob's own context (its chat, its card).
// Connecting there allows that one app for that one blob and nothing else (never widens "All" or other apps).
import type { BlobProfile } from "@kora/contracts";
import { useCallback } from "react";

import { useBlobsApi, useBlobsState } from "../shell/blobsApi";
import { grantsAllowToolkit, normalizeGrants, withToolkitGranted } from "./appsModel";

export function useGrantToolkit() {
  const api = useBlobsApi();
  const { snapshot } = useBlobsState();
  const blobs = snapshot?.blobs ?? [];
  const isGranted = useCallback(
    (blobId: string, toolkit: string): boolean => {
      const g = normalizeGrants(blobs.find((b) => b.id === blobId)?.toolGrants?.apps);
      return grantsAllowToolkit(g, toolkit);
    },
    [blobs],
  );
  const grant = useCallback(
    async (
      blobId: string,
      toolkit: string,
    ): Promise<{ ok: true; profile: BlobProfile } | { ok: false; message: string }> => {
      const blob = blobs.find((b) => b.id === blobId);
      if (!blob) return { ok: false, message: "That blob is not on your team any more." };
      const next = withToolkitGranted(blob.toolGrants?.apps, toolkit);
      const r = await api.update(blobId, {
        toolGrants: { ...blob.toolGrants, apps: { mode: next.mode, allow: [...next.allow] } },
      });
      return r.ok ? { ok: true, profile: r.value } : r;
    },
    [api, blobs],
  );
  return { isGranted, grant };
}
