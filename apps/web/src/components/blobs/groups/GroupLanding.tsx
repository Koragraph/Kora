// What /blobs/<group id> shows: like a blob's landing it never renders a chat itself. It forwards to the group's newest
// thread, or opens a fresh draft in the group's project; an unknown or deleted group says so.
import { hostProjectRef, hostThreadRef } from "@kora/client-runtime/host";
import { ProjectId } from "@kora/contracts";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useAllHostShellsBootstrapped, useProjects, useThreadSummaries } from "~/atoms/entities";
import { useStartNewThread } from "~/hooks/useStartThread";
import { threadPageParams } from "~/thread/threadRoutes";
import { useAppSurfaceStore } from "../../assistant/surfaceStore";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../ui/empty";
import { SidebarInset } from "../../ui/sidebar";
import { Spinner } from "../../ui/spinner";
import { useGroupsState } from "./useGroups";

export function GroupLanding({ groupId }: { readonly groupId: string }) {
  const router = useRouter();
  const [, setSurface] = useAppSurfaceStore();
  const { ready, groups } = useGroupsState();
  const threads = useThreadSummaries();
  const projects = useProjects();
  const bootstrapped = useAllHostShellsBootstrapped();
  const openNewThread = useStartNewThread();
  const [failed, setFailed] = useState(false);
  const landed = useRef(false);

  useEffect(() => {
    setSurface("blobs");
  }, [setSurface]);

  const group = groups.find((g) => g.id === groupId && g.archivedAt === null) ?? null;
  const project = projects.find((p) => p.id === groupId) ?? null;
  const latest = threads
    .filter((t) => t.projectId === groupId && !t.archivedAt)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];

  useEffect(() => {
    if (landed.current || !ready || !bootstrapped || !group || !project) return;
    landed.current = true;
    if (latest) {
      void router.navigate({
        to: "/$hostId/$threadId",
        params: threadPageParams(hostThreadRef(latest.hostId, latest.id)),
        replace: true,
      });
      return;
    }
    void openNewThread(hostProjectRef(project.hostId, ProjectId.make(groupId)), {
      replace: true,
    }).catch(() => {
      landed.current = false;
      setFailed(true);
    });
  }, [ready, bootstrapped, group, project, latest, router, openNewThread, groupId]);

  const unknown = ready && group === null;
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      {unknown || failed ? (
        <Empty className="flex-1" data-group-missing>
          <EmptyHeader className="max-w-sm">
            <EmptyTitle className="text-foreground text-lg">
              {unknown ? "That group isn’t here" : "Couldn’t open that group"}
            </EmptyTitle>
            <EmptyDescription className="mt-2 text-sm">
              {unknown
                ? "It may have been archived or deleted. Pick another from the sidebar."
                : "Try picking it again."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid flex-1 place-items-center" aria-busy>
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      )}
    </SidebarInset>
  );
}
