import { DEFAULT_DAEMON_PREFS, HostId, ProjectId, type DaemonPrefs } from "@kora/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { NavProjectGroupMember, NavProjectSnapshot } from "../../navProjectGrouping";
import { resolvePrefsScope } from "./prefsScope";
import {
  isProjectScopedSettingKey,
  listProjectOverrides,
  persistScopedPrefsPatch,
  planProjectOverridesClear,
  planScopedPrefsClear,
  planScopedPrefsPatch,
  resolveScopedPrefsTargets,
  scopedPrefsAreMixed,
  scopedPrefsSource,
  selectScopedPrefsHosts,
} from "./scopedPrefs";

interface HostOptions {
  online?: boolean;
  loaded?: boolean;
  supportsOverrides?: boolean;
  settings?: Partial<DaemonPrefs>;
}

/** A host record shaped like the client's environment list entries. */
function fakeHost(name: string, options: HostOptions = {}) {
  const { online = true, loaded = true, supportsOverrides = true, settings } = options;
  return {
    hostId: HostId.make(name),
    label: `Host-${name}`,
    connection: { phase: online ? ("connected" as const) : ("offline" as const) },
    daemonConfig: loaded
      ? {
          settings: { ...DEFAULT_DAEMON_PREFS, ...settings },
          environment: { capabilities: { projectSettingsOverrides: supportsOverrides } },
        }
      : null,
  };
}

interface Checkout {
  hostId: HostId;
  projectId: ProjectId;
  path: string;
}

/** A project that exists as one checkout per entry in `checkouts`. */
function fakeProject(slug: string, checkouts: Checkout[]): NavProjectSnapshot {
  const members: NavProjectGroupMember[] = checkouts.map((checkout) => ({
    id: checkout.projectId,
    hostId: checkout.hostId,
    title: slug,
    workspaceRoot: checkout.path,
    physicalProjectKey: `${checkout.hostId}:${checkout.path}`,
    hostLabel: `Host-${checkout.hostId}`,
    scripts: [],
    defaultModelSelection: null,
    createdAt: "2026-07-01T09:00:00Z",
    updatedAt: "2026-07-01T09:00:00Z",
  }));
  return {
    ...members[0]!,
    projectKey: slug,
    displayName: slug,
    groupedProjectCount: members.length,
    memberProjects: members,
    memberProjectRefs: checkouts.map((c) => ({ hostId: c.hostId, projectId: c.projectId })),
    hostPresence: "remote-only",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    remoteHostLabels: checkouts.map((c) => `Host-${c.hostId}`),
  };
}

/** Scope for one checkout of `project`, pinned to its host. */
function checkoutScope(
  project: NavProjectSnapshot,
  hosts: Array<ReturnType<typeof fakeHost>>,
  memberIndex = 0,
) {
  const member = project.memberProjects[memberIndex]!;
  return resolvePrefsScope(
    { project: project.projectKey, machine: member.hostId, checkout: member.physicalProjectKey },
    [project],
    hosts,
  );
}

describe("selectScopedPrefsHosts", () => {
  it("prefers the requested primary host when it is connected and loaded", () => {
    const north = fakeHost("north");
    const south = fakeHost("south");
    const hosts = [
      north,
      south,
      fakeHost("east", { online: false }),
      fakeHost("west", { loaded: false }),
    ];
    const scope = resolvePrefsScope({}, [], hosts);

    const picked = selectScopedPrefsHosts(scope, hosts, south.hostId);

    expect(picked.environment).toBe(south);
    expect(picked.connectedHosts).toEqual([north, south]);
    expect(picked.environments).toHaveLength(4);
  });

  it("uses the first usable host when the preferred one is offline", () => {
    const up = fakeHost("up");
    const down = fakeHost("down", { online: false });
    const scope = resolvePrefsScope({}, [], [up, down]);

    expect(selectScopedPrefsHosts(scope, [up, down], down.hostId).environment).toBe(up);
  });

  it("has no representative when the one targeted host is offline", () => {
    const lonely = fakeHost("lonely", { online: false });
    const scope = resolvePrefsScope({ machine: lonely.hostId }, [], [lonely]);

    const picked = selectScopedPrefsHosts(scope, [lonely], null);

    expect(picked.environment).toBeNull();
    expect(picked.connectedHosts).toHaveLength(0);
    expect(picked.environments).toEqual([lonely]);
  });
});

describe("isProjectScopedSettingKey", () => {
  it.each([
    ["defaultAutoPull", true],
    ["enableAgentDeviceAccess", true],
    ["sourceControlWritingStyle", true],
    ["sidebarAutoSettleAfterDays", true],
    ["enableProviderUpdateChecks", false],
  ])("%s -> %s", (key, expected) => {
    expect(isProjectScopedSettingKey(key)).toBe(expected);
  });
});

describe("comparing settings across targets", () => {
  it("is not mixed when two hosts hold structurally equal objects", () => {
    const style = {
      mode: "custom" as const,
      customInstructions: "Be concise in commit messages",
      followChangeRequestTemplates: true,
    };
    const a = fakeHost("a", { settings: { sourceControlWritingStyle: { ...style } } });
    const b = fakeHost("b", { settings: { sourceControlWritingStyle: { ...style } } });
    const targets = resolveScopedPrefsTargets(resolvePrefsScope({}, [], [a, b]), [a, b]);

    expect(scopedPrefsAreMixed(targets, ["sourceControlWritingStyle"])).toBe(false);
  });

  it("is mixed only for a key on which the hosts differ", () => {
    const plain = fakeHost("plain");
    const tweaked = fakeHost("tweaked", { settings: { enableAgentBrowserAccess: false } });
    const targets = resolveScopedPrefsTargets(resolvePrefsScope({}, [], [plain, tweaked]), [
      plain,
      tweaked,
    ]);

    expect(scopedPrefsAreMixed(targets, ["enableAgentBrowserAccess"])).toBe(true);
    expect(scopedPrefsAreMixed(targets, ["sidebarAutoSettleOnMerge"])).toBe(false);
  });

  it("is never mixed without targets", () => {
    expect(scopedPrefsAreMixed([], ["defaultAutoPull"])).toBe(false);
  });

  it("reports whether values come from the project, the environment, or both", () => {
    const first = ProjectId.make("proj-one");
    const second = ProjectId.make("proj-two");
    const hostOne = fakeHost("h1");
    const hostTwo = fakeHost("h2", {
      settings: {
        defaultAutoPull: false,
        projectSettingsOverrides: { [second]: { defaultAutoPull: true } },
      },
    });
    const project = fakeProject("shared", [
      { hostId: hostOne.hostId, projectId: first, path: "/a" },
      { hostId: hostTwo.hostId, projectId: second, path: "/b" },
    ]);
    const scope = resolvePrefsScope({ project: project.projectKey }, [project], [hostOne, hostTwo]);

    const targets = resolveScopedPrefsTargets(scope, [hostOne, hostTwo]);

    expect(targets.map((t) => [t.projectId, t.settings.defaultAutoPull])).toEqual([
      [first, false],
      [second, true],
    ]);
    expect(scopedPrefsSource(targets, ["defaultAutoPull"])).toBe("mixed");
    expect(scopedPrefsSource([targets[1]!], ["defaultAutoPull"])).toBe("project");
    expect(scopedPrefsSource(targets, ["enableProviderUpdateChecks"])).toBe("environment");
  });
});

describe("planScopedPrefsPatch", () => {
  it("sends client keys to the local store and daemon keys to the selected host", () => {
    const host = fakeHost("solo");
    const scope = resolvePrefsScope({ machine: host.hostId }, [], [host]);

    const plan = planScopedPrefsPatch(scope, [host], {
      diffIgnoreWhitespace: true,
      enableProviderUpdateChecks: false,
    });

    expect(plan.hasClientWrite).toBe(true);
    expect(plan.clientPatch).toEqual({ diffIgnoreWhitespace: true });
    expect(plan.serverWrites).toEqual([
      { hostId: host.hostId, label: host.label, patch: { enableProviderUpdateChecks: false } },
    ]);
    expect(plan.unavailableReason).toBeNull();
  });

  it("fans a daemon key out to every connected host in the global scope", () => {
    const a = fakeHost("a");
    const b = fakeHost("b");
    const c = fakeHost("c", { online: false });
    const scope = resolvePrefsScope({}, [], [a, b, c]);

    const plan = planScopedPrefsPatch(scope, [a, b, c], { sidebarAutoSettleOnMerge: false });

    expect(plan.serverWrites.map((write) => write.hostId)).toEqual([a.hostId, b.hostId]);
    expect(plan.hasClientWrite).toBe(false);
  });

  it("merges a partial object into the project's existing override instead of replacing it", () => {
    const projectId = ProjectId.make("engine-core");
    const shortStyle = {
      customInstructions: "Keep it short",
      followChangeRequestTemplates: false,
      mode: "custom" as const,
    };
    const host = fakeHost("workstation", {
      settings: {
        projectSettingsOverrides: { [projectId]: { sourceControlWritingStyle: shortStyle } },
      },
    });
    const project = fakeProject("engine", [
      { hostId: host.hostId, projectId, path: "/work/engine" },
    ]);
    const scope = resolvePrefsScope({ project: project.projectKey }, [project], [host]);

    const plan = planScopedPrefsPatch(scope, [host], {
      sourceControlWritingStyle: { customInstructions: "Longer explanations" },
    });

    const merged = { ...shortStyle, customInstructions: "Longer explanations" };
    expect(plan.serverWrites[0]?.patch).toEqual({
      projectSettingsOverrides: { [projectId]: { sourceControlWritingStyle: merged } },
    });
  });

  it("refuses an environment-wide key while a project is selected", () => {
    const host = fakeHost("only");
    const project = fakeProject("app", [
      { hostId: host.hostId, projectId: ProjectId.make("app-1"), path: "/srv/app" },
    ]);
    const scope = resolvePrefsScope({ project: project.projectKey }, [project], [host]);

    const plan = planScopedPrefsPatch(scope, [host], { enableProviderUpdateChecks: false });

    expect(plan.serverWrites).toHaveLength(0);
    expect(plan.unavailableReason).toBe(
      "This setting is environment-wide and cannot be overridden by a project.",
    );
  });

  it("refuses a project override on a host that predates the capability", () => {
    const old = fakeHost("old", { supportsOverrides: false });
    const project = fakeProject("legacy", [
      { hostId: old.hostId, projectId: ProjectId.make("legacy-1"), path: "/srv/legacy" },
    ]);

    const plan = planScopedPrefsPatch(checkoutScope(project, [old]), [old], {
      defaultAutoPull: true,
    });

    expect(plan.serverWrites).toHaveLength(0);
    expect(plan.unavailableReason).toContain("update");
  });
});

describe("clearing overrides", () => {
  it("drops just the named keys, and nulls the entry once none are left", () => {
    const projectId = ProjectId.make("target");
    const host = fakeHost("builder", {
      settings: {
        projectSettingsOverrides: {
          [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
        },
      },
    });
    const project = fakeProject("group", [
      { hostId: host.hostId, projectId, path: "/home/builder" },
    ]);
    const scope = checkoutScope(project, [host]);

    expect(planScopedPrefsClear(scope, [host], ["defaultAutoPull"]).serverWrites[0]?.patch).toEqual(
      {
        projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } },
      },
    );
    expect(
      planScopedPrefsClear(scope, [host], ["defaultAutoPull", "enableAgentBrowserAccess"])
        .serverWrites[0]?.patch,
    ).toEqual({ projectSettingsOverrides: { [projectId]: null } });
  });

  it("lists each host/project pair overriding any of the keys", () => {
    const one = ProjectId.make("p-one");
    const two = ProjectId.make("p-two");
    const alpha = fakeHost("alpha", {
      settings: {
        projectSettingsOverrides: {
          [one]: { defaultThreadEnvMode: "local" },
          [two]: { defaultAutoPull: true },
        },
      },
    });
    const beta = fakeHost("beta", {
      settings: { projectSettingsOverrides: { [two]: { defaultAutoPull: false } } },
    });

    expect(listProjectOverrides([alpha, beta], ["defaultAutoPull"])).toEqual([
      { hostId: alpha.hostId, projectId: two },
      { hostId: beta.hostId, projectId: two },
    ]);
  });

  it("builds one write per host that clears the keys across several projects", () => {
    const first = ProjectId.make("first");
    const second = ProjectId.make("second");
    const host = fakeHost("gamma", {
      settings: {
        projectSettingsOverrides: {
          [first]: { defaultAutoPull: true },
          [second]: { defaultAutoPull: true, defaultThreadEnvMode: "local" },
        },
      },
    });

    const plan = planProjectOverridesClear(
      [host],
      [
        { hostId: host.hostId, projectId: first },
        { hostId: host.hostId, projectId: second },
      ],
      ["defaultAutoPull"],
    );

    expect(plan.serverWrites).toEqual([
      {
        hostId: host.hostId,
        label: host.label,
        patch: {
          projectSettingsOverrides: { [first]: null, [second]: { defaultThreadEnvMode: "local" } },
        },
      },
    ]);
  });
});

describe("persistScopedPrefsPatch", () => {
  it("saves the client patch, tries every host, and reports which hosts failed", async () => {
    const hosts = ["s1", "s2", "s3"].map((name) => fakeHost(name));
    const plan = {
      hasClientWrite: true,
      clientPatch: { diffIgnoreWhitespace: true },
      serverWrites: hosts.map((host) => ({
        hostId: host.hostId,
        label: host.label,
        patch: { defaultAutoPull: true },
      })),
    };
    const saveToHost = vi
      .fn()
      .mockResolvedValueOnce({ _tag: "Success" as const })
      .mockResolvedValueOnce({ _tag: "Failure" as const })
      .mockRejectedValueOnce(new Error("timed out"));
    const saveLocally = vi.fn();

    const outcome = await persistScopedPrefsPatch(plan, saveToHost, saveLocally);

    expect(saveLocally).toHaveBeenCalledWith({ diffIgnoreWhitespace: true });
    expect(saveToHost).toHaveBeenCalledTimes(3);
    expect(outcome.savedHostCount).toBe(1);
    expect(outcome.failedHosts.map((failure) => failure.hostId)).toEqual([
      hosts[1]!.hostId,
      hosts[2]!.hostId,
    ]);
  });
});
