import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { threadPageParams } from "../thread/threadRoutes";
import {
  usePromptDraftStore,
  useBackgroundDraftSubmissionPending,
  markDraftPromoted,
  DraftId,
} from "../stores/promptDraftStore";
import { SidebarInset } from "../components/ui/sidebar";
import { waitForDraftStageTransition } from "../components/thread/draftHeroTransition";
import { resolveDraftPromotionNavigationTarget } from "../components/ThreadView.logic";
import ThreadView from "../components/ThreadView";
import { useThread, useThreadRefs } from "../atoms/entities";
import { KoraComingSoon } from "../components/kora/KoraComingSoon";
import { useIsComingSoonKoraProject } from "../koraSurface";

function DraftChatThreadPageView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = Route.useParams();
  const draftKey = DraftId.make(rawDraftId);
  const draftSession = usePromptDraftStore((storeObj) => storeObj.getDraftSession(draftKey));
  const knownThreads = useThreadRefs();
  const inferredThreadRef =
    knownThreads.find(
      (handle) =>
        draftSession !== null &&
        draftSession !== undefined &&
        handle.hostId === draftSession.hostId &&
        handle.threadId === draftSession.threadId,
    ) ?? null;
  const serverThreadRef = draftSession?.promotedTo ?? inferredThreadRef;
  const serverThread = useThread(serverThreadRef);
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(serverThreadRef);
  // Once the daemon lists the draft's thread, the real URL is the right one even before its first turn
  // shows up in the detail (which can trail the index): stay on /draft/<id> no longer than that.
  const canonicalThreadRef =
    resolveDraftPromotionNavigationTarget({
      backgroundSubmissionPending,
      serverThread,
      serverThreadRef,
    }) ?? (serverThread !== null && !backgroundSubmissionPending ? serverThreadRef : null);

  const alreadyPromoted = Boolean(draftSession?.promotedTo);
  // A draft in a blob's project while Kora is coming soon: the coming-soon page.
  const comingSoon = useIsComingSoonKoraProject(draftSession?.hostId, draftSession?.projectId);
  useEffect(() => {
    if (inferredThreadRef && !alreadyPromoted) markDraftPromoted(inferredThreadRef);
  }, [alreadyPromoted, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef) return undefined;
    let abandoned = false;
    const goToThread = async () => {
      await waitForDraftStageTransition();
      if (abandoned) return;
      void navigate({
        replace: true,
        params: threadPageParams(canonicalThreadRef),
        to: "/$hostId/$threadId",
      });
    };
    void goToThread();
    return () => {
      abandoned = true;
    };
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    const orphaned = !draftSession && !canonicalThreadRef;
    if (orphaned) void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate]);

  if (!draftSession) {
    return null;
  }
  if (comingSoon) return <KoraComingSoon />;

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <ThreadView
        key={draftKey}
        draftId={draftKey}
        hostId={draftSession.hostId}
        threadId={draftSession.threadId}
        routeKind="draft"
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_threads/draft/$draftId")({
  component: DraftChatThreadPageView,
});
