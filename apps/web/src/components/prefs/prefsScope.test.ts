import { findProjectGroup, resolvePrefsScope, validatePrefsScopeSearch } from "./prefsScope";

import type { NavProjectGroupMember, NavProjectSnapshot } from "../../navProjectGrouping";
import { describe, expect, it } from "vite-plus/test";
import { HostId, ProjectId } from "@kora/contracts";

const daemonId = HostId.make("server");

const laptopId = HostId.make("laptop");
const environments = [
  { hostId: laptopId, label: "Laptop" },
  { hostId: daemonId, label: "Server" },
];

function member(id: string, hostId: HostId): NavProjectGroupMember {
  return {
    updatedAt: "2026-09-07T00:00:00.000Z",
    createdAt: "2026-09-07T00:00:00.000Z",
    scripts: [],
    defaultModelSelection: null,
    hostLabel: environments.find((environment) => environment.hostId === hostId)?.label ?? null,
    physicalProjectKey: `${hostId}:/repos/${id}`,
    workspaceRoot: `/repos/${id}`,
    title: "Kora",
    hostId,
    id: ProjectId.make(id),
  };
}

const first = member("first", laptopId);
const second = member("second", laptopId);
const third = member("third", daemonId);
const other = member("other", daemonId);

function group(projectKey: string, members: readonly NavProjectGroupMember[]): NavProjectSnapshot {
  return {
    ...members[0]!,
    projectKey,
    displayName: projectKey,
    memberProjects: members,
    memberProjectRefs: members.map((project) => ({
      projectId: project.id,
      hostId: project.hostId,
    })),
    groupedProjectCount: members.length,
    hostPresence: "mixed",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    remoteHostLabels: [],
  };
}

const groups = [group("kora", [first, second, third]), group("other", [other])];

describe("project group lookup", () => {
  it("resolves a scope given the member-style key instead of reporting the project missing", () => {
    expect(resolvePrefsScope({ project: `${laptopId}:first` }, groups, environments)).toMatchObject(
      {
        kind: "project",
      },
    );
  });
  it("finds a group by its own key or by a member's hostId:projectId key", () => {
    expect(findProjectGroup(groups, "kora")?.projectKey).toBe("kora");
    expect(findProjectGroup(groups, `${daemonId}:other`)?.projectKey).toBe("other");
    expect(findProjectGroup(groups, `${laptopId}:second`)?.projectKey).toBe("kora");
    expect(findProjectGroup(groups, "nope")).toBeUndefined();
    expect(findProjectGroup(groups, null)).toBeUndefined();
  });
});

describe("settings scope resolution", () => {
  it("rejects a cached checkout whose environment was removed", () => {
    expect(
      resolvePrefsScope(
        { project: "kora", checkout: third.physicalProjectKey },
        groups,
        environments.slice(0, 1),
      ),
    ).toMatchObject({
      hostIds: [],
      members: [],
      reason: "environment-missing",
      kind: "unavailable",
    });
  });

  it("does not select another environment after removing a project's last local checkout", () => {
    const search = { project: "kora", machine: laptopId };
    expect(resolvePrefsScope(search, groups, environments)).toMatchObject({
      members: [first, second],
      kind: "project",
    });
    expect(resolvePrefsScope(search, [group("kora", [third])], environments)).toMatchObject({
      hostIds: [],
      members: [],
      kind: "unavailable",
    });
  });

  it("leaves a removed checkout unavailable while sibling checkouts remain", () => {
    const search = {
      checkout: first.physicalProjectKey,
      machine: laptopId,
      project: "kora",
    };
    expect(resolvePrefsScope(search, groups, environments)).toMatchObject({
      members: [first],
      kind: "checkout",
    });
    expect(resolvePrefsScope(search, [group("kora", [second, third])], environments)).toMatchObject(
      { kind: "unavailable", members: [], hostIds: [] },
    );
  });

  it.each([
    { project: "kora", machine: daemonId, checkout: first.physicalProjectKey },
    { project: "other", checkout: first.physicalProjectKey },
    { project: "other", machine: laptopId },
    { project: "kora", checkout: "deleted" },
    { project: "kora", machine: "removed" },
    { machine: "removed" },
    { project: "missing" },
  ])("never widens an invalid or stale target: %j", (search) => {
    expect(resolvePrefsScope(search, groups, environments)).toMatchObject({
      hostIds: [],
      members: [],
      kind: "unavailable",
    });
  });

  it("narrows a checkout target to exactly one member, deriving its environment when omitted", () => {
    expect(
      resolvePrefsScope(
        { project: "kora", checkout: second.physicalProjectKey },
        groups,
        environments,
      ),
    ).toMatchObject({
      hostIds: [laptopId],
      members: [second],
      label: "kora / Laptop · /repos/second",
      hostId: laptopId,
      checkout: second,
      kind: "checkout",
    });
  });

  it("preserves legacy project plus machine aggregates with multiple checkouts", () => {
    expect(
      resolvePrefsScope({ project: "kora", machine: laptopId }, groups, environments),
    ).toMatchObject({
      hostIds: [laptopId],
      members: [first, second],
      label: "kora / Laptop",
      hostId: laptopId,
      kind: "project",
    });
  });

  it("keeps all physical members in a project aggregate, including several on one environment", () => {
    expect(resolvePrefsScope({ project: "kora" }, groups, environments)).toMatchObject({
      hostIds: [laptopId, daemonId],
      members: [first, second, third],
      hostId: null,
      kind: "project",
    });
  });

  it("resolves one environment without targeting its project overrides", () => {
    expect(resolvePrefsScope({ machine: daemonId }, groups, environments)).toMatchObject({
      members: [],
      hostIds: [daemonId],
      hostId: daemonId,
      kind: "environment",
    });
  });
  it("defaults to every environment with no project", () => {
    expect(resolvePrefsScope({}, groups, environments)).toMatchObject({
      hostIds: [laptopId, daemonId],
      members: [],
      kind: "all",
    });
  });
});

describe("settings scope search", () => {
  it("retains an orphan checkout so it cannot turn into all environments", () => {
    const search = validatePrefsScopeSearch({ checkout: first.physicalProjectKey });
    expect(search).toEqual({ checkout: first.physicalProjectKey });
    expect(resolvePrefsScope(search, groups, environments)).toMatchObject({
      hostIds: [],
      members: [],
      reason: "project-required",
      kind: "unavailable",
    });
  });

  it("retains legacy project and machine links without inventing an explicit broad scope", () => {
    expect(validatePrefsScopeSearch({ project: "kora", machine: laptopId, unused: true })).toEqual({
      machine: laptopId,
      project: "kora",
    });
  });
  it("ignores the retired scope key from older links", () => {
    expect(validatePrefsScopeSearch({ scope: "device", project: "kora" })).toEqual({
      project: "kora",
    });
    expect(validatePrefsScopeSearch({ scope: "all" })).toEqual({});
  });
});
