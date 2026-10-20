// What /blobs and /blobs/$blobId show: they never render a chat themselves, they forward to the blob's most recent
// thread (or open a fresh draft in its project). With no blobs at all, /blobs is the tasteful empty roster.
import { hostProjectRef, hostThreadRef } from "@kora/client-runtime/host";
import { ProjectId } from "@kora/contracts";
import { useRouter } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAllHostShellsBootstrapped, useProjects } from "~/atoms/entities";
import { BlobAvatar } from "~/components/blobs/avatar";
import { useStartNewThread } from "~/hooks/useStartThread";
import { threadPageParams } from "~/thread/threadRoutes";
import { Button } from "../../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../ui/empty";
import { SidebarInset } from "../../ui/sidebar";
import { Spinner } from "../../ui/spinner";
import { BlobEditorDialog } from "../editor/BlobEditorDialog";
import LandingUnreachable from "./LandingUnreachable";
import { KoraFirstRunHost } from "../welcome/KoraFirstRun";
import { useAppSurfaceStore, useLastBlobStore } from "../../assistant/surfaceStore";
import { useBlobRoster } from "./useBlobRoster";

export const LANDING_WATCHDOG_MS = 4_000;
export const LANDING_MAX_ATTEMPTS = 3;

/** `blobId` null = /blobs: land on Kora, else the first teammate. */
export function BlobLanding({ blobId }: { readonly blobId: string | null }) {
  const router = useRouter();
  const [, setSurface] = useAppSurfaceStore();
  const [lastBlob] = useLastBlobStore();
  const { ready, hostId, roster, entries } = useBlobRoster();
  const projects = useProjects();
  const bootstrapped = useAllHostShellsBootstrapped();
  const openNewThread = useStartNewThread();
  const [editorOpen, setEditorOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const landedRef = useRef<string | null>(null);
  // How many times the landing re-tried after its forward went nowhere (see the watchdog below).
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setSurface("blobs");
  }, [setSurface]);

  // /blobs with no id: the blob you were last in (if still on the roster), else Kora, else the first teammate.
  const remembered =
    lastBlob && (roster.chief?.id === lastBlob || roster.team.some((b) => b.id === lastBlob))
      ? lastBlob
      : null;
  const target = blobId ?? remembered ?? roster.chief?.id ?? roster.team[0]?.id ?? null;
  const entry = target ? (entries.get(target) ?? null) : null;
  const projectReady =
    target !== null &&
    hostId !== null &&
    projects.some((p) => p.hostId === hostId && p.id === target);

  useEffect(() => {
    if (!ready || !bootstrapped || !entry || !projectReady || hostId === null) return;
    if (landedRef.current === entry.blob.id) return;
    landedRef.current = entry.blob.id;
    const latest = entry.threads[0]?.thread;
    if (latest) {
      void router.navigate({
        to: "/$hostId/$threadId",
        params: threadPageParams(hostThreadRef(latest.hostId, latest.id)),
        replace: true,
      });
      return;
    }
    void openNewThread(hostProjectRef(hostId, ProjectId.make(entry.blob.id)), {
      replace: true,
    }).then(
      (opened) => {
        // `null` = the route changed while the request ran: nothing was opened. The watchdog below retries.
        if (opened === null) landedRef.current = null;
      },
      () => {
        landedRef.current = null;
        setFailed(true);
      },
    );
  }, [ready, bootstrapped, entry, projectReady, hostId, router, openNewThread, attempt]);

  // Watchdog (live QA #4: a fresh load sat on the skeleton for 60 s until a reload). This component unmounts the moment
  // the forward lands, so still being here LANDING_WATCHDOG_MS after the forward started means it went nowhere (a navigate
  // that lost a race with the shells bootstrapping, or a draft request cancelled by a route change): try again, then say so.
  useEffect(() => {
    if (!ready || !bootstrapped || !entry || !projectReady || hostId === null || failed) return;
    const t = setTimeout(() => {
      landedRef.current = null;
      if (attempt + 1 >= LANDING_MAX_ATTEMPTS) setFailed(true);
      else setAttempt((n) => n + 1);
    }, LANDING_WATCHDOG_MS);
    return () => clearTimeout(t);
  }, [ready, bootstrapped, entry, projectReady, hostId, failed, attempt]);

  const unknownBlob = ready && blobId !== null && entry === null;
  const noBlobs = ready && blobId === null && target === null;

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      {noBlobs ? (
        <div className="min-h-0 flex-1" data-blobs-welcome>
          <KoraFirstRunHost
            onBuild={() => setEditorOpen(true)}
            onFirstTask={(blob) => {
              void router.navigate({ to: "/blobs/$blobId", params: { blobId: blob.id } });
            }}
          />
        </div>
      ) : unknownBlob ? (
        <Empty className="flex-1" data-blobs-welcome>
          <EmptyHeader className="max-w-sm">
            <div className="mb-2 grid place-items-center">
              <BlobAvatar state="idle" size={144} reaction="wave" label="A blob waving" />
            </div>
            <EmptyTitle className="text-foreground text-xl">
              That blob isn’t on your team
            </EmptyTitle>
            <EmptyDescription className="mt-2 text-sm text-muted-foreground/80">
              It may have been retired. Pick someone from the sidebar, or hire a new one.
            </EmptyDescription>
            <div className="mt-5 flex justify-center">
              <Button size="sm" onClick={() => setEditorOpen(true)} data-new-blob-hero>
                <PlusIcon />
                New blob
              </Button>
            </div>
          </EmptyHeader>
        </Empty>
      ) : failed ? (
        <Empty className="flex-1">
          <EmptyHeader className="max-w-sm">
            <EmptyTitle className="text-foreground text-lg">Couldn’t open that chat</EmptyTitle>
            <EmptyDescription className="mt-2 text-sm">
              Try picking the blob again.
            </EmptyDescription>
            <div className="mt-4 flex justify-center">
              <Button
                size="sm"
                variant="outline"
                data-landing-retry
                onClick={() => {
                  landedRef.current = null;
                  setFailed(false);
                  setAttempt(0);
                }}
              >
                Try again
              </Button>
            </div>
          </EmptyHeader>
        </Empty>
      ) : (
        <LandingWait />
      )}
      <BlobEditorDialog open={editorOpen} blobId={null} onOpenChange={setEditorOpen} />
    </SidebarInset>
  );
}

/** The wait before a thread opens. A cold start can take a few seconds: after two of them, say what is happening. */
function LandingWait() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 2000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      className="relative flex flex-1 flex-col items-center justify-center gap-3"
      aria-busy
      role="status"
    >
      <Spinner className="size-5 text-muted-foreground" />
      <p
        className={`text-[13px] text-muted-foreground transition-opacity duration-300 ${slow ? "opacity-100" : "opacity-0"}`}
      >
        Getting your team ready…
      </p>
      <LandingUnreachable />
    </div>
  );
}
