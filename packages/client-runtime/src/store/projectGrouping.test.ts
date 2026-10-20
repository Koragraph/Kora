import { HostId, ProjectId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { HostProject } from "./models.ts";
import {
  buildProjectGroups,
  derivePhysicalProjectKey,
  type ProjectGroupingPrefs,
} from "./projectGrouping.ts";

type Mode = ProjectGroupingPrefs["sidebarProjectGroupingMode"];
type Group = ReturnType<typeof buildProjectGroups>[number];

const day = (n: number) => `2026-03-0${n}T12:00:00.000Z`;

const WIDGETS = {
  displayName: "Widgets",
  name: "widgets",
  owner: "acme",
  provider: "github",
  canonicalKey: "github.com/acme/widgets",
  locator: {
    remoteUrl: "https://github.com/acme/widgets.git",
    remoteName: "upstream",
    source: "git-remote" as const,
  },
};

/** The same repository under an older name, as a stale registration might remember it. */
const RENAMED = {
  ...WIDGETS,
  displayName: "Gadgets",
  name: "gadgets",
  canonicalKey: "github.com/acme/gadgets",
};

const project = (id: string, root: string, extra: Partial<HostProject> = {}): HostProject => ({
  ...(extra.repositoryIdentity === undefined ? { repositoryIdentity: WIDGETS } : {}),
  scripts: [],
  defaultModelSelection: null,
  updatedAt: day(1),
  createdAt: day(1),
  workspaceRoot: root,
  title: id,
  id: ProjectId.make(id),
  hostId: HostId.make("environment"),
  ...extra,
});

const groupsOf = (
  projects: ReadonlyArray<HostProject>,
  mode: Mode = "repository",
  overrides: ProjectGroupingPrefs["sidebarProjectGroupingOverrides"] = {},
) =>
  buildProjectGroups({
    settings: { sidebarProjectGroupingOverrides: overrides, sidebarProjectGroupingMode: mode },
    projects: [...projects],
  });

const memberIds = (group: Group | undefined) => group?.members.map(({ project: p }) => p.id);

/** Three clones of the same repository side by side. */
const clones = () => ["w1", "w2", "w3"].map((id) => project(id, `/code/${id}`));

describe("buildProjectGroups", () => {
  it.each(["repository", "repository_path"] as const)(
    "%s mode folds clones into one group and keeps each as a member",
    (mode) => {
      const [only, ...rest] = groupsOf(clones(), mode);
      expect(rest).toEqual([]);
      expect(memberIds(only)).toEqual(["w1", "w2", "w3"]);
      expect(only?.memberProjectRefs.length).toBe(3);
    },
  );

  it.each([
    ["a custom title every clone shares", "Shop front", "Shop front"],
    ["the repository name when the shared title is just its slug", "widgets", "Widgets"],
  ])("labels the group with %s", (_case, title, label) => {
    const projects = [project("a", "/code/w1", { title }), project("b", "/code/w2", { title })];
    expect(groupsOf(projects)[0]?.label).toBe(label);
  });

  it("gives each clone its own group in separate mode", () => {
    const groups = groupsOf(clones(), "separate");
    expect(groups.map(({ label }) => label)).toEqual(["w1", "w2", "w3"]);
    expect(groups.reduce((count, group) => count + group.members.length, 0)).toBe(3);
  });

  it("splits out one overridden clone and leaves the rest grouped", () => {
    const projects = clones();
    const groups = groupsOf(projects, "repository", {
      [derivePhysicalProjectKey(projects[1]!)]: "separate",
    });
    expect(groups.map(memberIds)).toEqual([["w1", "w3"], ["w2"]]);
  });

  describe("several registrations of one folder", () => {
    it("shows the newest and still counts every registration", () => {
      const older = project("old", "/code/w1", { updatedAt: day(1), repositoryIdentity: null });
      const newer = project("new", "/code/w1/", { updatedAt: day(2) });

      const groups = groupsOf([older, newer]);
      expect(groups).toHaveLength(1);
      expect(groups[0]?.representative.id).toBe("new");
      expect([groups[0]?.members.length, groups[0]?.memberProjectRefs.length]).toEqual([1, 2]);
    });

    it("borrows the repository identity from an older registration when the newest has none", () => {
      const projects = [
        project("tagged", "/code/w1", { updatedAt: day(1) }),
        project("newest", "/code/w1/", { updatedAt: day(2), repositoryIdentity: null }),
        project("neighbour", "/code/w2"),
      ];
      expect(groupsOf(projects).map(memberIds)).toEqual([["newest", "neighbour"]]);
    });

    it("trusts the newest registration's identity over an older, different one", () => {
      const projects = [
        project("old", "/code/w1", { updatedAt: day(1), repositoryIdentity: RENAMED }),
        project("newest", "/code/w1/", { updatedAt: day(2) }),
        project("neighbour", "/code/w2"),
      ];
      expect(groupsOf(projects).map(memberIds)).toEqual([["newest", "neighbour"]]);
    });

    it("borrows from the newest registration that has an identity", () => {
      const projects = [
        project("oldest", "/code/w1", { updatedAt: day(1), repositoryIdentity: RENAMED }),
        project("middle", "/code/w1/", { updatedAt: day(2) }),
        project("newest", "/code/w1", { updatedAt: day(3), repositoryIdentity: null }),
        project("neighbour", "/code/w2"),
      ];
      expect(groupsOf(projects).map(memberIds)).toEqual([["newest", "neighbour"]]);
    });
  });
});
