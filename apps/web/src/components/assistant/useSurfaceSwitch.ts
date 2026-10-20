// Kora | Code switching, shared by the titlebar switcher (always reachable, even with the sidebar closed) and anything
// else that flips surfaces. Switching navigates to that surface's most recent thread, or its empty/new state (Kora's
// chat, or the code landing when no repo exists yet).
import { useCallback } from "react";
import { useRouter } from "@tanstack/react-router";
import { hostThreadRef } from "@kora/client-runtime/host";

import { useProjects, useThreadSummaries } from "../../atoms/entities";
import { useBlobsState } from "../blobs/shell/blobsApi";
import { threadPageParams } from "../../thread/threadRoutes";
import { useAppSurfaceStore, useLastBlobStore, type AppSurface } from "./surfaceStore";
import { latestThreadForSurface } from "./useSurfaceSwitch.logic";
import { useKoraSurfaceOn } from "../../koraSurface";

export type SwitchSurface = (next: AppSurface, opts?: { readonly force?: boolean }) => void;

export function useSurfaceSwitch(): [AppSurface, SwitchSurface] {
  const [surface, setSurface] = useAppSurfaceStore();
  const [lastBlob] = useLastBlobStore();
  const projects = useProjects();
  const threads = useThreadSummaries();
  const router = useRouter();
  const { snapshot: blobs } = useBlobsState();
  const koraOn = useKoraSurfaceOn();

  const switchSurface = useCallback(
    (next: AppSurface, opts?: { readonly force?: boolean }) => {
      // `force`: the coming-soon page's "back to Code" works even when the stored surface already says Code (a deep link).
      if (next === surface && !opts?.force) return;
      setSurface(next);
      // Kora is coming soon: the Kora tab is its coming-soon page, never a blob thread.
      if (next === "blobs" && !koraOn) {
        void router.navigate({ to: "/blobs" });
        return;
      }
      // A retired blob's threads stay in the store; the Blobs tab never lands on one.
      const retired = new Set(
        (blobs?.blobs ?? []).filter((b) => b.archivedAt !== null).map((b) => b.id),
      );
      // Back to Blobs: the blob you were in, not whichever thread anywhere moved last.
      if (next === "blobs" && lastBlob && !retired.has(lastBlob)) {
        const blob = (blobs?.blobs ?? []).find((b) => b.id === lastBlob);
        if (blob) {
          void router.navigate({ to: "/blobs/$blobId", params: { blobId: blob.id } });
          return;
        }
      }
      const best = latestThreadForSurface(projects, threads, next, retired);
      if (best) {
        void router.navigate({
          to: "/$hostId/$threadId",
          params: threadPageParams(hostThreadRef(best.hostId, best.id)),
        });
        return;
      }
      void router.navigate({ to: next === "blobs" ? "/blobs" : "/" });
    },
    [surface, setSurface, lastBlob, projects, threads, blobs, router, koraOn],
  );

  return [surface, switchSurface];
}
