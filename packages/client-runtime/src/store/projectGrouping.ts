import type { ClientPrefs, HostId, NavProjectGroupingMode, HostProjectRef } from "@kora/contracts";

import { hostProjectRef, hostProjectKey } from "../host/scoped.ts";
import type { HostProject } from "./models.ts";
import { canonicalProjectPath } from "./projects.ts";

export interface ProjectGroupingPrefs {
  readonly sidebarProjectGroupingMode: NavProjectGroupingMode;
  readonly sidebarProjectGroupingOverrides: Record<string, NavProjectGroupingMode>;
}

export type ProjectGroupingMode = NavProjectGroupingMode;

export function selectProjectGroupingPrefs(settings: ClientPrefs): ProjectGroupingPrefs {
  return {
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  };
}

/** One folder on one host, however many project records point at it. */
export function derivePhysicalProjectKeyFromPath(hostId: string, cwd: string): string {
  return `${hostId}:${canonicalProjectPath(cwd)}`;
}

type ProjectLocation = Pick<HostProject, "hostId" | "workspaceRoot">;

export function derivePhysicalProjectKey({ hostId, workspaceRoot }: ProjectLocation): string {
  return derivePhysicalProjectKeyFromPath(hostId, workspaceRoot);
}

/** Projects are ordered by where they live, so the order key is the physical key. */
export const getProjectOrderKey = (project: ProjectLocation): string =>
  derivePhysicalProjectKey(project);

export function resolveProjectGroupingMode(
  project: Pick<HostProject, "hostId" | "workspaceRoot">,
  settings: ProjectGroupingPrefs,
): NavProjectGroupingMode {
  return (
    settings.sidebarProjectGroupingOverrides[derivePhysicalProjectKey(project)] ??
    settings.sidebarProjectGroupingMode
  );
}

/** The project's folder relative to its repository root, with `/` separators; null when it cannot be told. */
function relativeToRepositoryRoot(
  workspaceRoot: string,
  rootPath: string | undefined,
): string | null {
  if (rootPath === undefined) return null;
  const root = canonicalProjectPath(rootPath);
  const path = canonicalProjectPath(workspaceRoot);
  const separator = root.includes("\\") ? "\\" : "/";
  if (path === root || !path.startsWith(root + separator)) return null;
  return path.slice(root.length + separator.length).replaceAll("\\", "/");
}

type LogicalKeyProject = Pick<
  HostProject,
  "hostId" | "id" | "workspaceRoot" | "repositoryIdentity"
>;

export function deriveLogicalProjectKey(
  project: LogicalKeyProject,
  options?: { readonly groupingMode?: NavProjectGroupingMode },
): string {
  const mode = options?.groupingMode ?? "repository";
  const physicalKey =
    project.workspaceRoot.length > 0
      ? derivePhysicalProjectKey(project)
      : hostProjectKey(hostProjectRef(project.hostId, project.id));
  if (mode === "separate") return physicalKey;

  const identity = project.repositoryIdentity;
  if (!identity?.canonicalKey) return physicalKey;
  if (mode === "repository") return identity.canonicalKey;

  const relative = relativeToRepositoryRoot(project.workspaceRoot, identity.rootPath);
  return relative === null || relative.length === 0
    ? identity.canonicalKey
    : `${identity.canonicalKey}::${relative}`;
}

export function deriveLogicalProjectKeyFromPrefs(
  project: LogicalKeyProject,
  settings: ProjectGroupingPrefs,
): string {
  return deriveLogicalProjectKey(project, {
    groupingMode: resolveProjectGroupingMode(project, settings),
  });
}

export interface ProjectGroupMember<T extends HostProject = HostProject> {
  readonly physicalProjectKey: string;
  readonly project: T;
}

export interface ProjectGroup<T extends HostProject = HostProject> {
  readonly key: string;
  readonly label: string;
  readonly representative: T;
  readonly members: ReadonlyArray<ProjectGroupMember<T>>;
  readonly memberProjectRefs: ReadonlyArray<HostProjectRef>;
}

const freshness = (project: HostProject): number => {
  const parsed = Date.parse(project.updatedAt);
  if (!Number.isNaN(parsed)) return parsed;
  const created = Date.parse(project.createdAt);
  return Number.isNaN(created) ? 0 : created;
};

/** Newest wins; on a tie the greater id does. */
const isFresher = (candidate: HostProject, current: HostProject): boolean => {
  const a = freshness(candidate);
  const b = freshness(current);
  return a !== b ? a > b : candidate.id > current.id;
};

const trimmed = (value: string | undefined): string | null => {
  const text = value?.trim();
  return text ? text : null;
};

function deriveProjectGroupLabel(
  members: ReadonlyArray<ProjectGroupMember>,
  representative: HostProject,
): string {
  const titles = new Set<string>();
  const displayNames = new Set<string>();
  const names = new Set<string>();
  for (const { project } of members) {
    const title = trimmed(project.title);
    if (title !== null) titles.add(title);
    const displayName = trimmed(project.repositoryIdentity?.displayName);
    if (displayName !== null) displayNames.add(displayName);
    const name = trimmed(project.repositoryIdentity?.name);
    if (name !== null) names.add(name);
  }
  const only = (set: Set<string>): string | null => (set.size === 1 ? [...set][0]! : null);

  const title = only(titles);
  // A title that merely repeats the repository's own name carries no information.
  if (title !== null && !displayNames.has(title) && !names.has(title)) return title;
  return only(displayNames) ?? only(names) ?? representative.title;
}

export function buildProjectGroups<T extends HostProject>(input: {
  readonly projects: ReadonlyArray<T>;
  readonly settings: ProjectGroupingPrefs;
  readonly preferredHostId?: HostId | null;
}): ReadonlyArray<ProjectGroup<T>> {
  const { projects, settings } = input;

  // One bucket per physical folder; its freshest record stands for it.
  const buckets = new Map<string, T[]>();
  for (const project of projects) {
    const key = derivePhysicalProjectKey(project);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [project]);
    else bucket.push(project);
  }

  const membersByLogicalKey = new Map<string, ProjectGroupMember<T>[]>();
  const logicalKeyByPhysicalKey = new Map<string, string>();
  for (const [physicalProjectKey, bucket] of buckets) {
    const winner = bucket.reduce((best, project) => (isFresher(project, best) ? project : best));
    const identitySource =
      winner.repositoryIdentity !== null && winner.repositoryIdentity !== undefined
        ? winner
        : (bucket
            .filter((project) => project.repositoryIdentity != null)
            .reduce<T | null>(
              (best, project) => (best === null || isFresher(project, best) ? project : best),
              null,
            ) ?? winner);
    const logicalKey = deriveLogicalProjectKey(identitySource, {
      groupingMode: resolveProjectGroupingMode(winner, settings),
    });
    logicalKeyByPhysicalKey.set(physicalProjectKey, logicalKey);
    const members = membersByLogicalKey.get(logicalKey) ?? [];
    members.push({ physicalProjectKey, project: winner });
    membersByLogicalKey.set(logicalKey, members);
  }

  // Every input project, duplicates of a folder included, is a member ref of its folder's group.
  const refsByLogicalKey = new Map<string, HostProjectRef[]>();
  const seenRefs = new Set<string>();
  for (const project of projects) {
    const ref = hostProjectRef(project.hostId, project.id);
    const refKey = hostProjectKey(ref);
    if (seenRefs.has(refKey)) continue;
    seenRefs.add(refKey);
    const logicalKey =
      logicalKeyByPhysicalKey.get(derivePhysicalProjectKey(project)) ??
      deriveLogicalProjectKeyFromPrefs(project, settings);
    const refs = refsByLogicalKey.get(logicalKey) ?? [];
    refs.push(ref);
    refsByLogicalKey.set(logicalKey, refs);
  }

  return [...membersByLogicalKey].map(([key, members]) => {
    const representative =
      (input.preferredHostId != null
        ? members.find(({ project }) => project.hostId === input.preferredHostId)
        : undefined) ?? members[0]!;
    return {
      key,
      label:
        members.length === 1
          ? representative.project.title
          : deriveProjectGroupLabel(members, representative.project),
      representative: representative.project,
      members,
      memberProjectRefs: refsByLogicalKey.get(key) ?? [],
    };
  });
}
