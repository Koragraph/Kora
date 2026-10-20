import type { HostId, HostThreadRef } from "@kora/contracts";
import { hostThreadRef } from "@kora/client-runtime/host";

import { useProjects } from "~/atoms/entities";
import { useStartThread } from "./useStartThread";

export interface ActiveProjectTarget {
  readonly threadRef: HostThreadRef;
  readonly projectName: string;
  readonly cwd: string;
  readonly hostId: HostId;
  readonly projectId: string;
}

/**
 * Resolves the project workspace behind the active thread (or draft) so
 * project-scoped surfaces like the file picker and content search know which
 * workspace to query and which thread's right panel opens their results.
 */
export function useActiveProjectTarget(): ActiveProjectTarget | null {
  const { activeDraftThread, activeThread } = useStartThread();
  const projects = useProjects();
  const thread = activeThread ?? activeDraftThread;
  const threadKey = activeThread?.id ?? activeDraftThread?.threadId;
  const proj = thread
    ? projects.find((cand) => cand.hostId === thread.hostId && cand.id === thread.projectId)
    : null;
  const workDir = thread?.worktreePath ?? proj?.workspaceRoot;

  if (!thread || !threadKey || !proj || !workDir) return null;

  return {
    hostId: proj.hostId,
    projectId: proj.id,
    cwd: workDir,
    projectName: proj.title,
    threadRef: hostThreadRef(thread.hostId, threadKey),
  };
}
