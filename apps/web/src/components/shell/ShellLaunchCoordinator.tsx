/** Turns "open this folder" requests from the desktop shell into project + new thread, one at a time. */

import { newProjectId } from "../../util/utils";
import { inferProjectTitleFromPath, findProjectByPath } from "../../util/projectPaths";
import { handleShellLaunchRequest } from "../../shellLaunch";
import { useStartNewThread } from "../../hooks/useStartThread";
import { useAtomAction } from "../../atoms/use-atom-command";
import { hostShell } from "../../atoms/shell";
import { projectHost } from "../../atoms/projects";
import { usePrimaryHost } from "../../atoms/hosts";
import { waitForProject, readProjects } from "../../atoms/entities";
import type { HostId } from "@kora/contracts";
import { squashAtomActionFailure } from "@kora/client-runtime/store/runtime";
import { hostProjectRef } from "@kora/client-runtime/host";
import { useEffectEvent, useEffect } from "react";
import * as Option from "effect/Option";
import { useAtomValue } from "@effect/atom-react";

export function ShellLaunchCoordinator(): null {
  const host = usePrimaryHost();
  const hostId: HostId | null = host?.hostId ?? null;
  const shell = useAtomValue(hostShell.stateEntryAtom(hostId as HostId));
  const createProject = useAtomAction(projectHost.create, { reportFailure: false });
  const openNewThread = useStartNewThread();

  const activation = typeof window === "undefined" ? undefined : window.shellBridge?.appActivation;
  const daemonConfig = host?.daemonConfig ?? null;
  const ready =
    activation !== undefined &&
    host?.connection.phase === "connected" &&
    daemonConfig !== null &&
    hostId !== null &&
    Option.isSome(shell.snapshot);

  // Always run against the latest closures without re-subscribing.
  const processRequest = useEffectEvent((request: Parameters<typeof handleShellLaunchRequest>[0]) =>
    handleShellLaunchRequest(request, {
      getTarget: () =>
        hostId !== null && daemonConfig !== null
          ? { hostId, platform: daemonConfig.environment.platform.os }
          : null,
      openThread: async (projectRef) => {
        const opened = await openNewThread(hostProjectRef(projectRef.hostId, projectRef.projectId));
        return opened ? { threadId: opened.threadId } : null;
      },
      waitForProject: async (projectRef) => {
        await waitForProject(projectRef);
      },
      createProject: async (targetHostId, workspaceRoot) => {
        const projectId = newProjectId();
        const created = await createProject({
          hostId: targetHostId,
          input: {
            defaultModelSelection: null,
            createWorkspaceRootIfMissing: false,
            workspaceRoot,
            title: inferProjectTitleFromPath(workspaceRoot),
            projectId,
          },
        });
        if (created._tag === "Failure") {
          const cause = squashAtomActionFailure(created);
          throw new Error(
            cause instanceof Error && cause.message
              ? cause.message
              : "Kora could not add the project.",
          );
        }
        return projectId;
      },
      findProject: (targetHostId, workspaceRoot) =>
        findProjectByPath(
          readProjects().filter((project) => project.hostId === targetHostId),
          workspaceRoot,
        ) ?? null,
    }),
  );

  useEffect(() => {
    if (!ready || !activation) return;
    let active = true;
    let queue: Promise<unknown> = Promise.resolve();

    const unsubscribe = activation.onRequest((request) => {
      queue = queue
        .then(async () => activation.complete(await processRequest(request)))
        .catch(() => undefined);
    });
    queueMicrotask(() => {
      if (active) void activation.setReady(true).catch(() => undefined);
    });

    return () => {
      active = false;
      void activation.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [ready, activation]);

  return null;
}
