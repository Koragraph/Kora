import { HostId, ProjectId, ThreadId } from "@kora/contracts";
import { describe, expect, test, vi } from "vite-plus/test";

import { handleShellLaunchRequest, type ShellLaunchDependencies } from "./shellLaunch";

const HOST = HostId.make("primary");
const THREAD = ThreadId.make("thread-1");
const NEW_PROJECT = ProjectId.make("project-created");
const OLD_PROJECT = ProjectId.make("project-existing");

const REQUEST = {
  version: 1,
  type: "open-workspace",
  requestId: "req-1",
  platform: "linux",
  workspaceRoot: "/workspace/project",
} as const;

function wiring(over: Partial<ShellLaunchDependencies> = {}): ShellLaunchDependencies {
  return {
    getTarget: () => ({ hostId: HOST, platform: "linux" }),
    findProject: () => ({ id: OLD_PROJECT, hostId: HOST, workspaceRoot: REQUEST.workspaceRoot }),
    createProject: vi.fn(async () => NEW_PROJECT),
    waitForProject: vi.fn(async () => undefined),
    openThread: vi.fn(async () => ({ threadId: THREAD })),
    ...over,
  };
}

describe("handleShellLaunchRequest", () => {
  test("an existing project is reused and gets a new thread", async () => {
    const deps = wiring();
    const reply = await handleShellLaunchRequest(REQUEST, deps);

    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.openThread).toHaveBeenCalledWith({ hostId: HOST, projectId: OLD_PROJECT });
    expect(reply).toEqual({
      ok: true,
      version: 1,
      requestId: "req-1",
      projectId: OLD_PROJECT,
      threadId: THREAD,
    });
  });

  test("a new project is created, awaited until it exists, and only then is the thread opened", async () => {
    const steps: string[] = [];
    const deps = wiring({
      findProject: () => null,
      createProject: vi.fn(async () => (steps.push("create"), NEW_PROJECT)),
      waitForProject: vi.fn(async () => void steps.push("project-visible")),
      openThread: vi.fn(async () => (steps.push("open-thread"), { threadId: THREAD })),
    });

    const reply = await handleShellLaunchRequest(REQUEST, deps);

    expect(steps).toEqual(["create", "project-visible", "open-thread"]);
    expect(reply).toMatchObject({ ok: true, projectId: NEW_PROJECT });
  });

  test("a failure creating the project is reported and no thread is opened", async () => {
    const openThread = vi.fn(async () => ({ threadId: THREAD }));
    const reply = await handleShellLaunchRequest(
      REQUEST,
      wiring({
        findProject: () => null,
        openThread,
        createProject: vi.fn(async () => {
          throw new Error("Project path is not available.");
        }),
      }),
    );

    expect(reply).toMatchObject({
      ok: false,
      code: "project-create-failed",
      message: "Project path is not available.",
    });
    expect(openThread).not.toHaveBeenCalled();
  });

  test("a Windows path sent to a Linux (WSL) host is refused", async () => {
    const reply = await handleShellLaunchRequest({ ...REQUEST, platform: "win32" }, wiring());
    expect(reply).toMatchObject({ ok: false, code: "platform-mismatch" });
  });
});
