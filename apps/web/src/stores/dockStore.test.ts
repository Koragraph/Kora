import {
  useDockStore,
  selectThreadDockState,
  selectActiveDockSurface,
  migratePersistedDockState,
} from "./dockStore";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { type HostId, ThreadId } from "@kora/contracts";
import { hostThreadRef } from "@kora/client-runtime/host";

const firstThread = hostThreadRef("env-1" as HostId, ThreadId.make("thread-A"));
const secondThread = hostThreadRef("env-1" as HostId, ThreadId.make("thread-B"));

beforeEach(() => {
  useDockStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
});

describe("dockStore", () => {
  it("reconciles browser surfaces without deleting other surface kinds", () => {
    useDockStore.getState().openTerminal(firstThread, "term-1");
    useDockStore.getState().openBrowser(firstThread, "tab-a");
    useDockStore.getState().openBrowser(firstThread, "tab-b");
    useDockStore.getState().reconcileBrowserSurfaces(firstThread, ["tab-b", "tab-c"]);

    expect(
      selectThreadDockState(useDockStore.getState().byThreadKey, firstThread).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["terminal:term-1", "browser:tab-b", "browser:tab-c"]);
  });

  it("closing the final surface closes the panel", () => {
    useDockStore.getState().openTerminal(firstThread, "term-1");
    useDockStore.getState().closeSurface(firstThread, "terminal:term-1");

    expect(selectThreadDockState(useDockStore.getState().byThreadKey, firstThread)).toEqual({
      surfaces: [],
      activeSurfaceId: null,
      isOpen: false,
    });
  });

  it("closing the active surface activates a neighboring surface", () => {
    useDockStore.getState().openBrowser(firstThread, "tab-a");
    useDockStore.getState().openTerminal(firstThread, "term-1");
    useDockStore.getState().closeSurface(firstThread, "terminal:term-1");

    expect(selectActiveDockSurface(useDockStore.getState().byThreadKey, firstThread)?.id).toBe(
      "browser:tab-a",
    );
  });

  it("closing the final terminal pane removes its surface and closes the panel", () => {
    useDockStore.getState().openTerminal(firstThread, "term-1");
    useDockStore.getState().closeTerminal(firstThread, "terminal:term-1", "term-1");

    expect(selectThreadDockState(useDockStore.getState().byThreadKey, firstThread)).toEqual({
      surfaces: [],
      activeSurfaceId: null,
      isOpen: false,
    });
  });

  it("tracks vertical layout for a terminal surface", () => {
    useDockStore.getState().openTerminal(firstThread, "term-1");
    useDockStore.getState().splitTerminal(firstThread, "terminal:term-1", "term-2", "vertical");

    expect(selectActiveDockSurface(useDockStore.getState().byThreadKey, firstThread)).toEqual({
      splitDirection: "vertical",
      activeTerminalId: "term-2",
      terminalIds: ["term-1", "term-2"],
      resourceId: "term-1",
      kind: "terminal",
      id: "terminal:term-1",
    });
  });

  it("tracks split panes and the active pane within a terminal surface", () => {
    useDockStore.getState().openTerminal(firstThread, "term-1");
    useDockStore.getState().splitTerminal(firstThread, "terminal:term-1", "term-2");

    expect(selectActiveDockSurface(useDockStore.getState().byThreadKey, firstThread)).toEqual({
      activeTerminalId: "term-2",
      terminalIds: ["term-1", "term-2"],
      resourceId: "term-1",
      kind: "terminal",
      id: "terminal:term-1",
    });

    useDockStore.getState().activateTerminal(firstThread, "terminal:term-1", "term-1");
    useDockStore.getState().closeTerminal(firstThread, "terminal:term-1", "term-1");
    expect(selectActiveDockSurface(useDockStore.getState().byThreadKey, firstThread)).toEqual({
      activeTerminalId: "term-2",
      terminalIds: ["term-2"],
      resourceId: "term-1",
      kind: "terminal",
      id: "terminal:term-1",
    });
  });

  it("tracks one surface per terminal session", () => {
    useDockStore.getState().openTerminal(firstThread, "term-1");
    useDockStore.getState().openTerminal(firstThread, "term-2");

    const state = selectThreadDockState(useDockStore.getState().byThreadKey, firstThread);
    expect(state.surfaces).toEqual([
      {
        activeTerminalId: "term-1",
        terminalIds: ["term-1"],
        resourceId: "term-1",
        kind: "terminal",
        id: "terminal:term-1",
      },
      {
        activeTerminalId: "term-2",
        terminalIds: ["term-2"],
        resourceId: "term-2",
        kind: "terminal",
        id: "terminal:term-2",
      },
    ]);
    expect(state.activeSurfaceId).toBe("terminal:term-2");
  });

  it("tracks one surface per browser session", () => {
    useDockStore.getState().openBrowser(firstThread, "tab-a");
    useDockStore.getState().openBrowser(firstThread, "tab-b");

    const state = selectThreadDockState(useDockStore.getState().byThreadKey, firstThread);
    expect(state.surfaces.map((surface) => surface.id)).toEqual(["browser:tab-a", "browser:tab-b"]);
    expect(selectActiveDockSurface(useDockStore.getState().byThreadKey, firstThread)).toEqual({
      resourceId: "tab-b",
      kind: "preview",
      id: "browser:tab-b",
    });
  });

  it("close on never-opened thread is a no-op", () => {
    useDockStore.getState().close(firstThread);
    expect(useDockStore.getState().byThreadKey).toEqual({});
  });

  it("removes persisted file surfaces when their workspace no longer exists", () => {
    useDockStore.getState().openFile(firstThread, "src/index.ts");
    useDockStore.getState().open(firstThread, "fleet");
    useDockStore.getState().openFile(firstThread, "README.md");

    useDockStore.getState().reconcileFileSurfaces(firstThread, false);

    expect(selectThreadDockState(useDockStore.getState().byThreadKey, firstThread)).toEqual({
      surfaces: [{ id: "fleet", kind: "fleet" }],
      activeSurfaceId: "fleet",
      isOpen: true,
    });

    useDockStore.getState().openFile(secondThread, "conductor.json");
    useDockStore.getState().reconcileFileSurfaces(secondThread, false);
    expect(selectThreadDockState(useDockStore.getState().byThreadKey, secondThread)).toEqual({
      surfaces: [],
      activeSurfaceId: null,
      isOpen: false,
    });
  });

  it("updates line reveal requests when reopening a file surface", () => {
    useDockStore.getState().openFile(firstThread, "src/index.ts", 42);
    useDockStore.getState().openFile(firstThread, "src/index.ts", 87);

    expect(selectThreadDockState(useDockStore.getState().byThreadKey, firstThread)).toEqual({
      surfaces: [
        {
          revealRequestId: 2,
          revealLine: 87,
          relativePath: "src/index.ts",
          kind: "file",
          id: "file:src/index.ts",
        },
      ],
      activeSurfaceId: "file:src/index.ts",
      isOpen: true,
    });

    useDockStore.getState().openFile(firstThread, "src/index.ts");

    expect(selectThreadDockState(useDockStore.getState().byThreadKey, firstThread)).toEqual({
      surfaces: [
        {
          revealRequestId: 3,
          revealLine: null,
          relativePath: "src/index.ts",
          kind: "file",
          id: "file:src/index.ts",
        },
      ],
      activeSurfaceId: "file:src/index.ts",
      isOpen: true,
    });
  });

  it("replaces the standalone explorer with peer file surfaces", () => {
    useDockStore.getState().open(firstThread, "files");
    useDockStore.getState().openFile(firstThread, "src/index.ts");
    useDockStore.getState().openFile(firstThread, "src/index.ts");
    useDockStore.getState().openFile(firstThread, "README.md");

    expect(selectThreadDockState(useDockStore.getState().byThreadKey, firstThread)).toEqual({
      surfaces: [
        {
          revealRequestId: 2,
          revealLine: null,
          relativePath: "src/index.ts",
          kind: "file",
          id: "file:src/index.ts",
        },
        {
          revealRequestId: 1,
          revealLine: null,
          relativePath: "README.md",
          kind: "file",
          id: "file:README.md",
        },
      ],
      activeSurfaceId: "file:README.md",
      isOpen: true,
    });
  });

  it("keeps files as a singleton surface", () => {
    useDockStore.getState().open(firstThread, "files");
    useDockStore.getState().open(firstThread, "files");
    expect(selectThreadDockState(useDockStore.getState().byThreadKey, firstThread)).toEqual({
      surfaces: [{ id: "files", kind: "files" }],
      activeSurfaceId: "files",
      isOpen: true,
    });
  });

  it("reopening an inactive singleton activates its existing surface", () => {
    useDockStore.getState().open(firstThread, "files");
    useDockStore.getState().open(firstThread, "fleet");
    useDockStore.getState().open(firstThread, "files");

    expect(selectThreadDockState(useDockStore.getState().byThreadKey, firstThread)).toEqual({
      surfaces: [
        { id: "files", kind: "files" },
        { id: "fleet", kind: "fleet" },
      ],
      activeSurfaceId: "files",
      isOpen: true,
    });
  });

  it("drops retired plan and diff surfaces and does not reopen an empty panel", () => {
    expect(
      migratePersistedDockState({
        byThreadKey: {
          "env-1:thread-B": {
            surfaces: [
              { id: "plan", kind: "plan" },
              { id: "diff", kind: "diff" },
            ],
            activeSurfaceId: "plan",
            isOpen: true,
          },
          "env-1:thread-A": {
            surfaces: [{ id: "plan", kind: "plan" }],
            activeSurfaceId: "plan",
            isOpen: true,
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-B": {
          surfaces: [],
          activeSurfaceId: null,
          isOpen: false,
        },
        "env-1:thread-A": {
          surfaces: [],
          activeSurfaceId: null,
          isOpen: false,
        },
      },
    });
  });

  it("drops the retired Agents surface and falls back to a surviving surface", () => {
    expect(
      migratePersistedDockState({
        byThreadKey: {
          "env-1:thread-A": {
            surfaces: [
              { id: "agents", kind: "agents" },
              { id: "fleet", kind: "fleet" },
            ],
            activeSurfaceId: "agents",
            isOpen: true,
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          surfaces: [{ id: "fleet", kind: "fleet" }],
          activeSurfaceId: "fleet",
          isOpen: true,
        },
      },
    });
  });

  it("upgrades saved file surfaces with neutral reveal state", () => {
    expect(
      migratePersistedDockState({
        byThreadKey: {
          "env-1:thread-A": {
            surfaces: [{ id: "file:src/index.ts", kind: "file", relativePath: "src/index.ts" }],
            activeSurfaceId: "file:src/index.ts",
            isOpen: true,
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          surfaces: [
            {
              revealRequestId: 0,
              revealLine: null,
              relativePath: "src/index.ts",
              kind: "file",
              id: "file:src/index.ts",
            },
          ],
          activeSurfaceId: "file:src/index.ts",
          isOpen: true,
        },
      },
    });
  });

  it("upgrades saved single-session terminal surfaces to split-capable surfaces", () => {
    expect(
      migratePersistedDockState({
        byThreadKey: {
          "env-1:thread-A": {
            surfaces: [{ id: "terminal:term-1", kind: "terminal", resourceId: "term-1" }],
            activeSurfaceId: "terminal:term-1",
            isOpen: true,
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          surfaces: [
            {
              activeTerminalId: "term-1",
              terminalIds: ["term-1"],
              resourceId: "term-1",
              kind: "terminal",
              id: "terminal:term-1",
            },
          ],
          activeSurfaceId: "terminal:term-1",
          isOpen: true,
        },
      },
    });
  });
  it("drops the legacy singleton terminal surface during migration", () => {
    expect(
      migratePersistedDockState({
        byThreadKey: {
          "env-1:thread-A": {
            surfaces: [
              { id: "browser:tab-a", kind: "preview", resourceId: "tab-a" },
              { id: "terminal", kind: "terminal" },
            ],
            activeSurfaceId: "terminal",
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
          activeSurfaceId: null,
          isOpen: false,
        },
      },
    });
  });
});
