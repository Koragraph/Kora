import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import ThreadView from "../components/ThreadView";
import { threadHasStarted } from "../components/ThreadView.logic";
import { finalizePromotedDraftByRef, usePromptDraftStore } from "../stores/promptDraftStore";
import {
  isThreadRouteDeadEnd,
  resolveThreadPageRef,
  resolveThreadPageRenderState,
} from "../thread/threadRoutes";
import { resolveThreadLoadPhase } from "../thread/threadSync";
import { SidebarInset } from "~/components/ui/sidebar";
import {
  useHostThreadRefs,
  useThreadDetail,
  useThreadSummary,
  useThreadStatus,
} from "../atoms/entities";
import { useHostQuery } from "../atoms/query";
import { hostShell } from "../atoms/shell";
import { KoraComingSoon } from "../components/kora/KoraComingSoon";
import { useIsComingSoonKoraProject } from "../koraSurface";
import { usePrimaryHostId } from "../atoms/hosts";
import { RouteNotFoundView } from "../components/RouteNotFoundView";

function ChatThreadPageView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadPageRef(params),
  });
  const shell = useHostQuery(threadRef === null ? null : hostShell.stateAtom(threadRef.hostId));
  const serverThreadSummary = useThreadSummary(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  const hostThreadRefs = useHostThreadRefs(threadRef?.hostId ?? null);
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  // A cached or still-synchronizing index can lack a thread the daemon has: only a live one proves it missing.
  const shellIsLive = shell.data?.status === "live";
  const hostHasServerThreads = hostThreadRefs.length > 0;
  const draftThreadExists = usePromptDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = usePromptDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const hostHasDraftThreads = usePromptDraftStore((store) => {
    if (!threadRef) {
      return false;
    }
    return store.hasDraftThreadsInHost(threadRef.hostId);
  });
  const renderState = resolveThreadPageRenderState({
    bootstrapComplete,
    serverThreadShellExists: serverThreadSummary !== null,
    serverThreadDetailExists: serverThreadDetail !== null,
    serverThreadDetailDeleted: serverThreadStatus === "deleted",
    draftThreadExists,
  });
  const threadSyncPhase = resolveThreadLoadPhase({
    detailExists: serverThreadDetail !== null,
    shellExists: serverThreadSummary !== null,
    status: serverThreadStatus,
  });
  const serverThreadStarted = threadHasStarted(serverThreadDetail);
  // A blob's thread (a deep link, a notification) while Kora is coming soon: the coming-soon page, never the blob UI.
  const comingSoon = useIsComingSoonKoraProject(threadRef?.hostId, serverThreadSummary?.projectId);
  const hostHasAnyThreads = hostHasServerThreads || hostHasDraftThreads;
  // Any two-segment path lands here (`/nope/really`): a host this client has never heard of never syncs, so say so.
  const primaryHostId = usePrimaryHostId();

  useEffect(() => {
    if (!threadRef || !bootstrapComplete || !shellIsLive) {
      return;
    }

    if (renderState === "missing" && hostHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, hostHasAnyThreads, navigate, renderState, shellIsLive, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftByRef(threadRef);
  }, [draftThread, serverThreadStarted, threadRef]);

  if (!threadRef) {
    return null;
  }
  if (comingSoon) return <KoraComingSoon />;
  // Missing with nowhere to redirect (or an unknown host): a way back, never a blank pane.
  if (
    isThreadRouteDeadEnd({
      routeHostId: threadRef.hostId,
      primaryHostId,
      renderState,
      shellIsLive,
      hostHasAnyThreads,
    })
  ) {
    return <RouteNotFoundView />;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      {renderState === "ready" || (renderState === "loading" && serverThreadSummary !== null) ? (
        <ThreadView
          hostId={threadRef.hostId}
          threadId={threadRef.threadId}
          routeKind="server"
          threadSyncPhase={threadSyncPhase}
        />
      ) : null}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_threads/$hostId/$threadId")({
  component: ChatThreadPageView,
});
