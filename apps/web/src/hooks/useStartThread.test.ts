import type { AccessMode } from "@kora/contracts";
import { describe, expect, test, vi } from "vite-plus/test";

type EnvMode = "local" | "worktree";
type StoredDraft = { draftId: string; hostId: string; promotedTo: null; threadId: string } | null;

const rig = vi.hoisted(() => {
  const state = {
    stored: null as StoredDraft,
    env: {
      defaultRuntimeMode: "full-access" as AccessMode,
      defaultModelSelection: null,
      newWorktreesStartFromOrigin: false,
      defaultThreadEnvMode: "local" as EnvMode,
    },
    finishFileRead: (_: null) => {},
    fileRead: Promise.resolve<null>(null),
  };
  const router = {
    state: { matches: [{ params: {} }], location: { href: "/" } },
    navigate: vi.fn(async (req: { params: { draftId: string } }) => {
      router.state.location.href = `/draft/${req.params.draftId}`;
    }),
  };
  const drafts = {
    setModelSelection: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setDraftThreadContext: vi.fn(),
    applyStickyState: vi.fn(),
    getDraftThread: vi.fn(() => null),
    getDraftSession: vi.fn(() => null),
    getDraftSessionByLogicalProjectKey: vi.fn(() => state.stored),
    getComposerDraft: vi.fn(() => ({})),
  };
  function arrange(
    stored: StoredDraft,
    env: { origin: boolean; mode: EnvMode } = { origin: false, mode: "local" },
  ) {
    state.stored = stored;
    state.env = {
      defaultRuntimeMode: "full-access",
      defaultModelSelection: null,
      newWorktreesStartFromOrigin: env.origin,
      defaultThreadEnvMode: env.mode,
    };
    router.state.location.href = "/";
    router.navigate.mockClear();
    drafts.setDraftThreadContext.mockClear();
    drafts.setLogicalProjectDraftThreadId.mockClear();
    state.fileRead = new Promise<null>((resolve) => {
      state.finishFileRead = resolve;
    });
  }
  return { state, router, drafts, arrange };
});

// The hook's collaborators, each reduced to what this behaviour needs.
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => {
    const flipped = !rig.state.env.newWorktreesStartFromOrigin;
    if (atom === "primary-settings") return { newWorktreesStartFromOrigin: flipped };
    return new Map([
      [
        "environment-primary",
        { settings: { ...rig.state.env, newWorktreesStartFromOrigin: flipped } },
      ],
      ["environment-ssh", { settings: rig.state.env }],
    ]);
  },
}));
vi.mock("react", () => ({
  useMemo: <T>(make: () => T) => make(),
  useCallback: <T>(fn: T) => fn,
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => rig.router, useParams: () => null }));
vi.mock("@kora/client-runtime/host", () => ({
  hostThreadRef: (hostId: string, threadId: string) => ({ hostId, threadId }),
  hostProjectRef: (hostId: string, projectId: string) => ({ hostId, projectId }),
  hostProjectKey: () => "remote-project",
}));
vi.mock("@kora/contracts", () => ({ DEFAULT_DAEMON_PREFS: {}, DEFAULT_ACCESS_MODE: "default" }));
vi.mock("@kora/shared/projectPrefs", () => ({
  resolveProjectPrefs: (settings: Record<string, unknown>) => ({
    settings,
    overrides: {},
    sources: { defaultModelSelection: "environment", defaultThreadEnvMode: "environment" },
  }),
}));
vi.mock("@kora/shared/threadWorkspaceMode", () => ({
  resolveDefaultThreadEnvMode: (i: { projectFile: EnvMode | null; globalDefault: EnvMode }) =>
    i.projectFile ?? i.globalDefault,
}));
vi.mock("./usePrefs", () => ({ useClientPrefs: () => ({}) }));
vi.mock("../components/NavRows.logic", () => ({ orderByPreferredIds: () => [] }));
vi.mock("../stores/promptDraftStore", () => ({
  usePromptDraftStore: Object.assign(() => null, { getState: () => rig.drafts }),
  markDraftPromoted: vi.fn(),
  promptDraftHasUserContent: () => false,
}));
vi.mock("../stores/uiStateStore", () => ({
  useViewStateStore: () => [],
  legacyProjectCwdPreferenceKey: () => "remote-project",
}));
vi.mock("../util/chatThreadActions", async (loadReal) => ({
  ...(await loadReal<typeof import("../util/chatThreadActions")>()),
  hasExplicitPromptModelPick: () => false,
  resolveNewThreadModelPickOverride: () => null,
}));
vi.mock("../util/koraProjectFileDefaults", () => ({
  readKoraProjectFileDefaultThreadEnvMode: () => rig.state.fileRead,
}));
vi.mock("../util/utils", () => ({
  newThreadId: () => "thread-delayed",
  newDraftId: () => "draft-delayed",
}));
vi.mock("../workspace/logicalProject", () => ({
  selectProjectGroupingPrefs: () => ({}),
  getProjectOrderKey: () => "remote-project",
  deriveLogicalProjectKeyFromPrefs: () => "remote-project",
}));
vi.mock("../thread/threadRoutes", () => ({ threadPageTarget: () => null }));
vi.mock("../atoms/server", () => ({
  primaryDaemonPrefsAtom: "primary-settings",
  hostDaemonConfigsAtom: {},
}));
vi.mock("../atoms/entities", () => ({
  useThread: () => null,
  useProjects: () => [],
  readThreadSummary: () => null,
  readProjects: () => [
    {
      id: "project-remote",
      hostId: "environment-ssh",
      workspaceRoot: "/remote/project",
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
    },
  ],
}));

import { useStartNewThread } from "./useStartThread";

const PROJECT = { projectId: "project-remote", hostId: "environment-ssh" } as never;
const EXISTING_DRAFT = {
  draftId: "draft-existing",
  threadId: "thread-existing",
  hostId: "environment-ssh",
  promotedTo: null,
} as const;
const filed = () => rig.drafts.setLogicalProjectDraftThreadId;

describe.each([
  ["no filed draft", null],
  ["a reusable filed draft", EXISTING_DRAFT],
] as const)("opening a new thread with %s", (_label, stored) => {
  test.each([true, false])(
    "an explicit start-from-origin of %s beats the environment default",
    async (choice) => {
      rig.arrange(stored, { mode: "worktree", origin: !choice });

      const opened = await useStartNewThread()(PROJECT, {
        envMode: "worktree",
        startFromOrigin: choice,
      });

      expect(filed()).toHaveBeenCalledWith(
        "remote-project",
        PROJECT,
        opened!.draftId,
        expect.objectContaining({ envMode: "worktree", startFromOrigin: choice }),
      );
    },
  );

  test.each([true, false])(
    "otherwise the target environment's start-from-origin (%s) applies",
    async (origin) => {
      rig.arrange(stored, { mode: "worktree", origin });
      const pending = useStartNewThread()(PROJECT);
      rig.state.finishFileRead(null);
      const opened = await pending;

      expect(opened).toEqual({
        draftId: stored?.draftId ?? "draft-delayed",
        threadId: stored?.threadId ?? "thread-delayed",
      });
      const expected = expect.objectContaining({ envMode: "worktree", startFromOrigin: origin });
      expect(filed()).toHaveBeenCalledWith("remote-project", PROJECT, opened!.draftId, expected);
      if (stored)
        expect(rig.drafts.setDraftThreadContext).toHaveBeenCalledWith(stored.draftId, expected);
    },
  );

  test.each(["approval-required", "auto-accept-edits", "auto", "full-access"] as const)(
    "new threads start with the environment's %s permissions",
    async (mode) => {
      rig.arrange(stored);
      rig.state.env.defaultRuntimeMode = mode;
      const pending = useStartNewThread()(PROJECT);
      rig.state.finishFileRead(null);
      const opened = await pending;

      expect(filed()).toHaveBeenCalledWith(
        "remote-project",
        PROJECT,
        opened!.draftId,
        expect.objectContaining({ runtimeMode: mode }),
      );
    },
  );

  test("if the user navigates away while the project file is being read, nothing is opened", async () => {
    rig.arrange(stored);
    const pending = useStartNewThread()(PROJECT, { replace: true });

    rig.router.state.location.href = "/usage";
    rig.state.finishFileRead(null);
    await pending;

    expect(rig.router.state.location.href).toBe("/usage");
    expect(rig.router.navigate).not.toHaveBeenCalled();
    expect(filed()).not.toHaveBeenCalled();
  });
});
