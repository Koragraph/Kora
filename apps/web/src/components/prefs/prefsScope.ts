import type { NavProjectGroupMember, NavProjectSnapshot } from "../../navProjectGrouping";
import type { HostPresentation } from "../../atoms/hosts";
import type { HostId } from "@kora/contracts";

export interface PrefsScopeSearch {
  checkout?: string | undefined;
  project?: string | undefined;
  machine?: string | undefined;
}

type ScopeTargets = {
  members: readonly NavProjectGroupMember[];
  hostIds: readonly HostId[];
  label: string;
};

export type ResolvedPrefsScope = ScopeTargets &
  (
    | { kind: "all" }
    | { kind: "environment"; hostId: HostId }
    | { kind: "project"; group: NavProjectSnapshot; hostId: HostId | null }
    | {
        kind: "checkout";
        group: NavProjectSnapshot;
        checkout: NavProjectGroupMember;
        hostId: HostId;
      }
    | {
        reason: "project-required" | "project-missing" | "environment-missing" | "checkout-missing";
        kind: "unavailable";
        message: string;
      }
  );

const SEARCH_KEYS = ["project", "machine", "checkout"] as const;

/** Stale ids survive validation so the resolver can say they are gone instead of silently widening. */
export function validatePrefsScopeSearch(raw: Record<string, unknown>): PrefsScopeSearch {
  const result: PrefsScopeSearch = {};
  for (const key of SEARCH_KEYS) {
    const value = raw[key];
    if (typeof value === "string" && value.trim() !== "") result[key] = value;
  }
  return result;
}

const unavailable = (
  reason: "project-required" | "project-missing" | "environment-missing" | "checkout-missing",
  message: string,
): ResolvedPrefsScope => ({
  label: "Unavailable selection",
  kind: "unavailable",
  members: [],
  hostIds: [],
  message,
  reason,
});

/**
 * The group a `project` search value names. Callers hold either the group's own key (the settings directory) or a
 * member's `hostId:projectId` scoped key (thread menus, the /projects route); both reach the same group.
 */
export function findProjectGroup<G extends NavProjectSnapshot>(
  groups: readonly G[],
  key: string | null | undefined,
): G | undefined {
  if (!key) return undefined;
  return (
    groups.find((candidate) => candidate.projectKey === key) ??
    groups.find((candidate) =>
      candidate.memberProjects.some((member) => `${member.hostId}:${member.id}` === key),
    )
  );
}

export function resolvePrefsScope(
  search: PrefsScopeSearch,
  groups: readonly NavProjectSnapshot[],
  environments: readonly Pick<HostPresentation, "hostId" | "label">[],
): ResolvedPrefsScope {
  const { project, machine, checkout } = search;

  if (checkout && !project) {
    return unavailable("project-required", "Select a project to choose one of its checkouts.");
  }

  const environment = machine ? environments.find((env) => env.hostId === machine) : undefined;
  if (machine && !environment) {
    return unavailable("environment-missing", "This environment is no longer available.");
  }

  if (project) {
    const group = findProjectGroup(groups, project);
    if (!group) return unavailable("project-missing", "This project is no longer available.");

    const members = group.memberProjects.filter(
      (member) =>
        (!machine || member.hostId === machine) &&
        (!checkout || member.physicalProjectKey === checkout),
    );
    if (members.length === 0) {
      const explanation = checkout
        ? "This checkout is no longer available in the selected project and environment."
        : "This project has no checkout on this environment.";
      return unavailable("checkout-missing", explanation);
    }

    if (checkout) {
      const member = members[0]!;
      const memberEnvironment = environments.find((env) => env.hostId === member.hostId);
      if (memberEnvironment === undefined) {
        const gone = "This checkout's environment is no longer available.";
        return unavailable("environment-missing", gone);
      }
      const sharesHost =
        group.memberProjects.filter((other) => other.hostId === member.hostId).length > 1;
      return {
        kind: "checkout",
        group,
        checkout: member,
        hostId: member.hostId,
        hostIds: [member.hostId],
        members: [member],
        label: `${group.displayName} / ${memberEnvironment.label}${sharesHost ? ` · ${member.workspaceRoot}` : ""}`,
      };
    }

    return {
      kind: "project",
      group,
      hostId: environment?.hostId ?? null,
      members,
      hostIds: [...new Set(members.map((member) => member.hostId))],
      label: `${group.displayName} / ${environment?.label ?? "All checkouts"}`,
    };
  }

  if (environment) {
    return {
      kind: "environment",
      hostId: environment.hostId,
      label: environment.label,
      members: [],
      hostIds: [environment.hostId],
    };
  }

  return {
    hostIds: environments.map((env) => env.hostId),
    members: [],
    label: "All environments",
    kind: "all",
  };
}
