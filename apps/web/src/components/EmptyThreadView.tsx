import { SidebarInset } from "./ui/sidebar";
import { EmptyDescription, EmptyHeader, EmptyTitle, Empty } from "./ui/empty";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { SetupCheck } from "./onboarding/SetupCheck";
import { SurfacePageHeader } from "./SurfacePageHeader";
import { sortScopedProjectsForNav } from "./NavRows.logic";
import { useStartNewThread } from "../hooks/useStartThread";
import { useAddLocalFolderProject } from "../hooks/useAddLocalFolderProject";
import { isNative } from "../env";
import { useAllHostShellsBootstrapped, useThreadSummaries, useProjects } from "../atoms/entities";
import { hostProjectRef } from "@kora/client-runtime/host";
import { useState } from "react";
import { FolderOpenIcon, PlusIcon } from "lucide-react";

export function NoActiveThreadState() {
  const projects = useProjects();
  const threads = useThreadSummaries();
  const bootstrapped = useAllHostShellsBootstrapped();
  const openNewThread = useStartNewThread();
  const addLocalFolderProject = useAddLocalFolderProject();
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  // Deciding "no project" before the shells arrive would flash the open-a-project prompt.
  const recentProject = bootstrapped
    ? (sortScopedProjectsForNav(projects, threads, "updated_at")[0] ?? null)
    : null;

  const startChat = async () => {
    if (starting || !recentProject) return;
    setStarting(true);
    setFailed(false);
    try {
      await openNewThread(hostProjectRef(recentProject.hostId, recentProject.id));
    } catch {
      setFailed(true);
    } finally {
      setStarting(false);
    }
  };

  const openProject = async () => {
    if (opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      const result = await addLocalFolderProject();
      if (result.kind === "failed") setOpenError(result.message);
    } finally {
      setOpening(false);
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* Empty bar: the title below says "No chat open" once. */}
        <SurfacePageHeader electron={isNative} className="border-b border-border/60" />
        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader>
              <EmptyTitle className="text-xl text-foreground">No chat open</EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                {recentProject
                  ? `Start a new chat in ${recentProject.title}, or pick an earlier one in the sidebar.`
                  : "Open a project folder to start your first chat."}
              </EmptyDescription>
            </EmptyHeader>
            <div className="mt-6 flex justify-center">
              {recentProject ? (
                <Button size="sm" disabled={starting} onClick={() => void startChat()}>
                  {starting ? <Spinner className="size-4" /> : <PlusIcon className="size-4" />}
                  New chat
                </Button>
              ) : (
                <Button size="sm" disabled={opening} onClick={() => void openProject()}>
                  {opening ? <Spinner className="size-4" /> : <FolderOpenIcon className="size-4" />}
                  Open a project
                </Button>
              )}
            </div>
            {failed ? (
              <p role="alert" className="mt-3 text-xs text-destructive-foreground">
                Couldn't start the chat. Try again, or pick the project in the sidebar.
              </p>
            ) : null}
            {openError ? (
              <p role="alert" className="mt-3 text-xs text-destructive-foreground">
                {openError}
              </p>
            ) : null}
            <SetupCheck className="mt-6" />
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
