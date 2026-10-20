import { useEffect, useRef, useState } from "react";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { hostProjectRef } from "@kora/client-runtime/host";

import { useStartNewThread } from "../hooks/useStartThread";
import { SidebarInset } from "../components/ui/sidebar";
import { RefreshIcon } from "../components/ui/spin-refresh-icon";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Button } from "../components/ui/button";
import { FirstRunWelcome } from "../components/onboarding/FirstRunWelcome";
import { useAppSurfaceStore } from "../components/assistant/surfaceStore";
import { sortScopedProjectsForNav } from "../components/NavRows.logic";
import { landingProjectsForSurface } from "../chatSurface";
import { useKoraSurfaceOn } from "../koraSurface";
import { useAllHostShellsBootstrapped, useProjects, useThreadSummaries } from "../atoms/entities";

function StartFailedPanel({ onRetry }: { onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-xl text-foreground">Couldn’t start a new chat</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            {"The project is still available. Try opening the draft again."}
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button onClick={onRetry} size="sm">
              <RefreshIcon className="size-4" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

/** Opens a fresh draft in the project that was active most recently, so `/` is never a dead end. */
function IndexDraftLanding({ surface }: { surface: "blobs" | "code" }) {
  const projects = useProjects();
  const threadShells = useThreadSummaries();
  const bootstrapped = useAllHostShellsBootstrapped();
  const openNewThread = useStartNewThread();
  const started = useRef(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const landing = landingProjectsForSurface(projects, surface);
  const mostRecent = bootstrapped
    ? (sortScopedProjectsForNav(landing, threadShells, "updated_at")[0] ?? null)
    : null;
  const projId = mostRecent ? `${mostRecent.hostId}:${mostRecent.id}` : null;

  useEffect(() => {
    if (!mostRecent || started.current) return;
    started.current = true;
    openNewThread(hostProjectRef(mostRecent.hostId, mostRecent.id), { replace: true }).catch(() => {
      started.current = false;
      setFailed(true);
    });
    // `projectKey` stands in for the project object, which changes identity on every sync.
  }, [projId, attempt, openNewThread]);

  if (!bootstrapped) return null;
  if (!mostRecent) return <FirstRunWelcome />;
  if (!failed) return null;
  return (
    <StartFailedPanel
      onRetry={() => {
        setFailed(false);
        setAttempt((n) => n + 1);
      }}
    />
  );
}

function ChatIndexRouteView() {
  const [surface, setSurface] = useAppSurfaceStore();
  const koraOn = useKoraSurfaceOn();
  // Kora is coming soon: the app always opens on Code (a stored "blobs" / "chat" from an earlier build included).
  useEffect(() => {
    if (!koraOn && surface === "blobs") setSurface("code");
  }, [koraOn, surface, setSurface]);
  if (!koraOn) return <IndexDraftLanding surface="code" />;
  if (surface === "blobs") return <Navigate to="/blobs" replace />;
  return <IndexDraftLanding surface={surface} />;
}

export const Route = createFileRoute("/_threads/")({ component: ChatIndexRouteView });
