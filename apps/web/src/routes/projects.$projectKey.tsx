import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { isBlobsSurfaceProject } from "../chatSurface";
import { useKoraSurfaceOn } from "../koraSurface";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { useAllHostShellsBootstrapped, useProjects } from "../atoms/entities";

/** `projectKey` is `${hostId}:${projectId}` — the same scoped key ThreadNav uses internally. */
function ProjectRouteView() {
  const { projectKey } = Route.useParams();
  const navigate = useNavigate();
  const projects = useProjects();
  const bootstrapped = useAllHostShellsBootstrapped();
  const separatorIndex = projectKey.indexOf(":");
  const hostId = separatorIndex === -1 ? projectKey : projectKey.slice(0, separatorIndex);
  const projectId = separatorIndex === -1 ? "" : projectKey.slice(separatorIndex + 1);
  const project = projects.find((p) => p.hostId === hostId && p.id === projectId) ?? null;

  // A blob's project is its page in Kora; a code project redirects into the Projects settings panel. A project that
  // does not exist (an old Chat project link: the Chat surface became Kora, and its projects became blobs under new
  // ids) lands in Kora instead of spinning forever.
  const koraOn = useKoraSurfaceOn();
  useEffect(() => {
    if (project === null) {
      // Kora is coming soon: an unknown project lands on Code, not the coming-soon page.
      if (bootstrapped) void navigate({ to: koraOn ? "/blobs" : "/", replace: true });
      return;
    }
    if (isBlobsSurfaceProject(project)) {
      void navigate({ to: "/blobs/$blobId", params: { blobId: project.id }, replace: true });
      return;
    }
    void navigate({
      to: "/settings/projects",
      search: { project: projectKey, machine: undefined },
      replace: true,
    });
  }, [project, bootstrapped, projectKey, navigate, koraOn]);

  return (
    <SidebarInset className="grid h-svh min-h-0 place-items-center bg-background text-foreground md:h-dvh">
      <Spinner className="size-5 text-muted-foreground" />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/projects/$projectKey")({
  beforeLoad: async ({ context }) => {
    // Not authenticated = the local Kora service is not reachable; Diagnostics says why and how to fix it.
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/settings/diagnostics", replace: true });
    }
  },
  component: ProjectRouteView,
});
