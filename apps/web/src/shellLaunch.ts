import type {
  ThreadId,
  ShellLaunchResponse,
  ShellLaunchRequest,
  ShellLaunchErrorCode,
  HostProjectRef,
  ProjectId,
  HostPlatformOs,
  HostId,
} from "@kora/contracts";

export interface ShellLaunchProject {
  readonly id: ProjectId;
  readonly hostId: HostId;
  readonly workspaceRoot: string;
}

export interface ShellLaunchTarget {
  readonly hostId: HostId;
  readonly platform: HostPlatformOs;
}

export interface ShellLaunchDependencies {
  getTarget(): ShellLaunchTarget | null;
  findProject(hostKey: HostId, workspaceRoot: string): ShellLaunchProject | null;
  createProject(hostKey: HostId, workspaceRoot: string): Promise<ProjectId>;
  waitForProject(projKey: HostProjectRef): Promise<void>;
  openThread(projKey: HostProjectRef): Promise<{ readonly threadId: ThreadId } | null>;
}

const messageOf = (err: unknown, backup: string): string =>
  err instanceof Error && err.message.trim() !== "" ? err.message : backup;

export async function handleShellLaunchRequest(
  req: ShellLaunchRequest,
  dependencies: ShellLaunchDependencies,
): Promise<ShellLaunchResponse> {
  const fail = (code: ShellLaunchErrorCode, msg: string): ShellLaunchResponse => ({
    version: 1,
    requestId: req.requestId,
    ok: false,
    code: code,
    message: msg,
  });

  const dest = dependencies.getTarget();
  if (!dest) {
    return fail(
      "environment-unavailable",
      "The desktop app's primary local environment is not connected.",
    );
  }

  const requested = req.platform === "win32" ? "windows" : req.platform;
  if (requested !== dest.platform) {
    return fail(
      "platform-mismatch",
      `The command path is for ${requested}, but the desktop app's primary environment uses ${dest.platform}. Cross-platform path mapping is not supported.`,
    );
  }

  let projectId = dependencies.findProject(dest.hostId, req.workspaceRoot)?.id;
  if (projectId === undefined) {
    try {
      projectId = await dependencies.createProject(dest.hostId, req.workspaceRoot);
      await dependencies.waitForProject({ hostId: dest.hostId, projectId });
    } catch (err) {
      return fail("project-create-failed", messageOf(err, "Kora could not add the project."));
    }
  }

  const openFailure = "Kora could not open a new thread for the project.";
  try {
    const opened = await dependencies.openThread({ hostId: dest.hostId, projectId });
    if (!opened) return fail("thread-open-failed", openFailure);
    return {
      version: 1,
      requestId: req.requestId,
      ok: true,
      projectId,
      threadId: opened.threadId,
    };
  } catch (err) {
    return fail("thread-open-failed", messageOf(err, openFailure));
  }
}
