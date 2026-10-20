import { AgentProfileId, HostId, ProjectId } from "@kora/contracts";
import { describe, expect, test } from "vite-plus/test";

import { orderByPreferredIds } from "./components/NavRows.logic";
import {
  buildNavProjectSnapshots,
  buildPhysicalToLogicalProjectKeyMap,
} from "./navProjectGrouping";
import { legacyProjectCwdPreferenceKey } from "./stores/uiStateStore";
import type { Project } from "./types";
import {
  derivePhysicalProjectKey,
  deriveLogicalProjectKey,
  deriveLogicalProjectKeyFromPrefs,
  getProjectOrderKey,
  resolveProjectGroupingMode,
} from "./workspace/logicalProject";

const PRIMARY = HostId.make("env-primary");
const REMOTE = HostId.make("env-remote");

const identity = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    remoteUrl: "https://github.com/example/shared-repo.git",
    remoteName: "origin",
    source: "git-remote" as const,
  },
};
const GROUPED = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};
const SEPARATE = {
  sidebarProjectGroupingMode: "separate" as const,
  sidebarProjectGroupingOverrides: {},
};

function project(over: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("p-primary"),
    hostId: PRIMARY,
    title: "shared-repo",
    workspaceRoot: "/tmp/shared-repo",
    repositoryIdentity: null,
    defaultModelSelection: { instanceId: AgentProfileId.make("codex"), model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...over,
  };
}
const withId = (id: string, over: Partial<Project> = {}) =>
  project({ id: ProjectId.make(id), ...over });
const remoteCopy = (over: Partial<Project> = {}) =>
  withId("p-remote", { hostId: REMOTE, repositoryIdentity: identity, ...over });

const snapshots = (
  projects: Project[],
  settings = GROUPED,
  label: (h: HostId) => string | null = () => null,
) =>
  buildNavProjectSnapshots({ projects, settings, primaryHostId: PRIMARY, resolveHostLabel: label });

describe("which key a project is grouped under", () => {
  test("with repository grouping on, the same repository on two hosts shares one key", () => {
    expect(deriveLogicalProjectKey(project({ repositoryIdentity: identity }))).toBe(
      identity.canonicalKey,
    );
    expect(deriveLogicalProjectKey(remoteCopy())).toBe(identity.canonicalKey);
  });

  test("projects without a repository identity stay scoped to their own host and path", () => {
    const here = project();
    const there = withId("p-remote", { hostId: REMOTE });
    expect(deriveLogicalProjectKey(here)).toBe(derivePhysicalProjectKey(here));
    expect(deriveLogicalProjectKey(there)).toBe(derivePhysicalProjectKey(there));
    expect(deriveLogicalProjectKey(here)).not.toBe(deriveLogicalProjectKey(there));
  });

  test("with repository grouping off the physical key is used", () => {
    const p = project({ repositoryIdentity: identity });
    expect(deriveLogicalProjectKeyFromPrefs(p, SEPARATE)).toBe(derivePhysicalProjectKey(p));
  });

  test("a per-project override beats the global mode in either direction", () => {
    const p = project({ repositoryIdentity: identity });
    const physical = derivePhysicalProjectKey(p);

    expect(
      deriveLogicalProjectKeyFromPrefs(p, {
        sidebarProjectGroupingMode: "separate",
        sidebarProjectGroupingOverrides: { [physical]: "repository" },
      }),
    ).toBe(identity.canonicalKey);
    expect(
      deriveLogicalProjectKeyFromPrefs(p, {
        ...GROUPED,
        sidebarProjectGroupingOverrides: { [physical]: "separate" },
      }),
    ).toBe(physical);
  });

  test("the effective mode reflects an override", () => {
    const p = project({ repositoryIdentity: identity });
    expect(resolveProjectGroupingMode(p, GROUPED)).toBe("repository");
    expect(
      resolveProjectGroupingMode(p, {
        ...GROUPED,
        sidebarProjectGroupingOverrides: { [derivePhysicalProjectKey(p)]: "separate" },
      }),
    ).toBe("separate");
  });
});

describe("sidebar snapshots", () => {
  test("the user's manual order is kept for the grouped entries", () => {
    const primary = project({ repositoryIdentity: identity });
    const standalone = withId("p-sep", { title: "separate", workspaceRoot: "/tmp/separate" });
    const ordered = orderByPreferredIds({
      items: [primary, remoteCopy(), standalone],
      preferredIds: [getProjectOrderKey(standalone), getProjectOrderKey(primary)],
      getId: getProjectOrderKey,
      getPreferenceIds: (p) => [
        getProjectOrderKey(p),
        legacyProjectCwdPreferenceKey(p.workspaceRoot),
      ],
    });
    expect(snapshots(ordered).map((s) => s.displayName)).toEqual(["separate", "shared-repo"]);
  });

  test("copies on several hosts count as one choice for starting a new thread", () => {
    expect(snapshots([project({ repositoryIdentity: identity }), remoteCopy()])).toHaveLength(1);
  });

  test("duplicate rows for one host and path collapse; the fresher row wins even if the stale one comes first", () => {
    const stale = withId("p-stale", {
      repositoryIdentity: identity,
      workspaceRoot: "/tmp/shared-repo/",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const fresh = withId("p-fresh", {
      repositoryIdentity: identity,
      workspaceRoot: "/tmp/shared-repo",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const [only, ...rest] = snapshots([stale, fresh], GROUPED, () => "primary");
    expect(rest).toHaveLength(0);
    expect(only?.memberProjects.map((p) => p.id)).toEqual([fresh.id]);
    expect(only?.id).toBe(fresh.id);
  });

  test("a duplicate on the primary host is dropped while the remote copy is kept as a second member", () => {
    const dupe = withId("p-dupe", {
      repositoryIdentity: identity,
      workspaceRoot: "/tmp/shared-repo/",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const primary = project({
      repositoryIdentity: identity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const remote = remoteCopy({ workspaceRoot: "/tmp/shared-repo" });

    const [group] = snapshots([primary, dupe, remote], GROUPED, (h) =>
      h === REMOTE ? "remote" : "primary",
    );
    expect(group?.groupedProjectCount).toBe(2);
    expect(group?.memberProjects.map((p) => p.id)).toEqual([primary.id, remote.id]);
  });

  test("a stale row without identity maps to the winning logical group, which deriving from it alone would miss", () => {
    const stale = withId("p-old", {
      repositoryIdentity: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const canonical = withId("p-new", {
      repositoryIdentity: identity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const map = buildPhysicalToLogicalProjectKeyMap({
      projects: [stale, canonical],
      settings: GROUPED,
      primaryHostId: PRIMARY,
    });

    expect(map.get(derivePhysicalProjectKey(stale))).toBe(identity.canonicalKey);
    expect(deriveLogicalProjectKeyFromPrefs(stale, GROUPED)).not.toBe(identity.canonicalKey);
  });
});
