import { dockGroupOf, resolveDockSelection, surfacesInGroup } from "./rightDock.logic";

import type { DockSurface } from "~/stores/dockStore";
import { describe, expect, it } from "vite-plus/test";

const files: DockSurface = { id: "files", kind: "files" };
const readme: DockSurface = {
  revealRequestId: 0,
  revealLine: null,
  relativePath: "README.md",
  kind: "file",
  id: "file:README.md",
};
const pageA: DockSurface = { id: "browser:a", kind: "preview", resourceId: "a" };
const pageB: DockSurface = { id: "browser:b", kind: "preview", resourceId: "b" };
const fleet: DockSurface = { id: "fleet", kind: "fleet" };
const term: DockSurface = {
  activeTerminalId: "t1",
  terminalIds: ["t1"],
  resourceId: "t1",
  kind: "terminal",
  id: "terminal:t1",
};

describe("resolveDockSelection", () => {
  const surfaces = [files, pageA, readme, pageB, fleet];

  it("creates the first item of an empty group", () => {
    expect(
      resolveDockSelection({
        activeSurfaceId: fleet.id,
        surfaces,
        panelOpen: true,
        group: "terminal",
      }),
    ).toEqual({ action: "create" });
  });

  it("returns to the item last shown in a group, else its newest", () => {
    expect(
      resolveDockSelection({
        lastSurfaceIdByGroup: { files: files.id },
        activeSurfaceId: fleet.id,
        surfaces,
        panelOpen: true,
        group: "files",
      }),
    ).toEqual({ action: "activate", surfaceId: files.id });
    expect(
      resolveDockSelection({
        activeSurfaceId: fleet.id,
        surfaces,
        panelOpen: true,
        group: "files",
      }),
    ).toEqual({ action: "activate", surfaceId: readme.id });
    expect(
      resolveDockSelection({
        lastSurfaceIdByGroup: { files: "file:gone.ts" },
        activeSurfaceId: fleet.id,
        surfaces,
        panelOpen: true,
        group: "files",
      }),
    ).toEqual({ action: "activate", surfaceId: readme.id });
  });

  it("reopens the group's shown item when the panel is hidden", () => {
    expect(
      resolveDockSelection({
        activeSurfaceId: pageA.id,
        surfaces,
        panelOpen: false,
        group: "browser",
      }),
    ).toEqual({ action: "activate", surfaceId: pageA.id });
  });

  it("hides the panel when the clicked group is the one showing", () => {
    expect(
      resolveDockSelection({
        activeSurfaceId: pageB.id,
        surfaces,
        panelOpen: true,
        group: "browser",
      }),
    ).toEqual({ action: "close" });
  });
});

describe("dockGroupOf", () => {
  it("groups the file tree with open files and maps the rest one to one", () => {
    expect([files, readme, pageA, fleet, term].map(dockGroupOf)).toEqual([
      "files",
      "files",
      "browser",
      "workers",
      "terminal",
    ]);
    expect(surfacesInGroup([files, pageA, readme], "files")).toEqual([files, readme]);
  });
});
