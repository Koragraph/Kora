import type { HostId, HostProjectRef } from "@kora/contracts";

import { buildProjectGroups, type ProjectGroupingPrefs } from "./workspace/logicalProject";
import type { Project } from "./types";

export type HostPresence = "local-only" | "remote-only" | "mixed";

export interface NavProjectGroupMember extends Project {
  physicalProjectKey: string;
  hostLabel: string | null;
}

export interface NavProjectSnapshot extends Project {
  remoteHostLabels: readonly string[];
  memberProjectRefs: readonly HostProjectRef[];
  memberProjects: readonly NavProjectGroupMember[];
  allRemoteMembersAreWsl: boolean;
  allRemoteMembersAreDesktopLocal: boolean;
  hostPresence: HostPresence;
  groupedProjectCount: number;
  displayName: string;
  projectKey: string;
}

export interface NavProjectPickerEntry {
  group: NavProjectSnapshot;
  targetProject: NavProjectGroupMember;
  isPreferred: boolean;
}

export function buildPhysicalToLogicalProjectKeyMap(args: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingPrefs;
  primaryHostId: HostId | null;
}): Map<string, string> {
  const table = new Map<string, string>();
  const groups = buildProjectGroups({
    projects: args.projects,
    settings: args.settings,
    preferredHostId: args.primaryHostId,
  });
  for (const group of groups) {
    for (const member of group.members) table.set(member.physicalProjectKey, group.key);
  }
  return table;
}

export function buildNavProjectSnapshots(args: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingPrefs;
  primaryHostId: HostId | null;
  resolveHostLabel: (hostKey: HostId) => string | null;
  isDesktopLocalHost?: (hostKey: HostId) => boolean;
  isWslHost?: (hostKey: HostId) => boolean;
}): NavProjectSnapshot[] {
  const { primaryHostId, resolveHostLabel } = args;
  const isDesktopLocal = args.isDesktopLocalHost ?? (() => false);
  const isWsl = args.isWslHost ?? (() => false);

  const groups = buildProjectGroups({
    projects: args.projects,
    settings: args.settings,
    preferredHostId: primaryHostId,
  });

  return groups.map((group) => {
    const members: NavProjectGroupMember[] = group.members.map(
      ({ physicalProjectKey, project }) => ({
        ...project,
        physicalProjectKey,
        hostLabel: resolveHostLabel(project.hostId),
      }),
    );
    const representative =
      members.find(
        (member) =>
          member.hostId === group.representative.hostId && member.id === group.representative.id,
      ) ?? members[0]!;

    const remote =
      primaryHostId === null ? [] : members.filter((member) => member.hostId !== primaryHostId);
    const hasLocal = members.some((member) => member.hostId === primaryHostId);
    const hostPresence: HostPresence =
      remote.length > 0 && hasLocal ? "mixed" : remote.length > 0 ? "remote-only" : "local-only";

    const labels: string[] = [];
    for (const member of remote) {
      if (member.hostLabel !== null && !labels.includes(member.hostLabel))
        labels.push(member.hostLabel);
    }

    return {
      ...representative,
      hostPresence,
      groupedProjectCount: members.length,
      displayName: group.label,
      projectKey: group.key,
      allRemoteMembersAreDesktopLocal:
        remote.length > 0 && remote.every((member) => isDesktopLocal(member.hostId)),
      allRemoteMembersAreWsl: remote.length > 0 && remote.every((member) => isWsl(member.hostId)),
      memberProjects: members,
      memberProjectRefs: group.memberProjectRefs,
      remoteHostLabels: labels,
    };
  });
}
