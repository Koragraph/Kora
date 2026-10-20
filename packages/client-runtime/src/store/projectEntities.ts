import type {
  ChatProjectHead,
  HostId,
  ProjectId,
  HostProjectRef,
  ThreadIndexSnapshot,
} from "@kora/contracts";
import { Atom } from "effect/unstable/reactivity";

import { enabledHostIds, type HostCatalogState } from "./connections.ts";
import { parseProjectKey, projectKey, projectRefsEqual } from "./entities.ts";
import { scopeProject, type HostProject } from "./models.ts";

const NO_PROJECTS: ReadonlyArray<ChatProjectHead> = Object.freeze([]);
const NO_INDEX: ReadonlyMap<ProjectId, ChatProjectHead> = new Map();

/**
 * Project atoms derived from the thread-index snapshot. Subscribers re-render only when
 * something they read changed, so every derived list keeps its previous instance when equal.
 */
export function createHostProjectAtoms(input: {
  readonly catalogEntryAtom: Atom.Atom<HostCatalogState>;
  readonly snapshotAtom: (hostId: HostId) => Atom.Atom<ThreadIndexSnapshot | null>;
}) {
  const hostProjectsAtom = Atom.family((hostId: HostId) =>
    Atom.make(
      (get): ReadonlyArray<ChatProjectHead> =>
        get(input.snapshotAtom(hostId))?.projects ?? NO_PROJECTS,
    ).pipe(Atom.withLabel(`environment-projects:${hostId}`)),
  );

  const hostProjectIndexAtom = Atom.family((hostId: HostId) =>
    Atom.make((get): ReadonlyMap<ProjectId, ChatProjectHead> => {
      const projects = get(hostProjectsAtom(hostId));
      return projects.length === 0
        ? NO_INDEX
        : new Map(projects.map((project) => [project.id, project]));
    }).pipe(Atom.withLabel(`environment-project-index:${hostId}`)),
  );

  const hostProjectRefsAtom = Atom.family((hostId: HostId) => {
    let previous: ReadonlyArray<HostProjectRef> = [];
    return Atom.make((get): ReadonlyArray<HostProjectRef> => {
      const next = get(hostProjectsAtom(hostId)).map((project) => ({
        hostId,
        projectId: project.id,
      }));
      if (projectRefsEqual(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-project-refs:${hostId}`));
  });

  let previousRefs: ReadonlyArray<HostProjectRef> = [];
  const projectRefsAtom = Atom.make((get): ReadonlyArray<HostProjectRef> => {
    const next: HostProjectRef[] = [];
    for (const hostId of enabledHostIds(get(input.catalogEntryAtom))) {
      next.push(...get(hostProjectRefsAtom(hostId)));
    }
    if (projectRefsEqual(previousRefs, next)) return previousRefs;
    previousRefs = next;
    return next;
  }).pipe(Atom.withLabel("environment-project-refs"));

  const projectByKey = Atom.family((key: string) => {
    const ref = parseProjectKey(key);
    // The scoped object is rebuilt only when the source head changes.
    let source: ChatProjectHead | undefined;
    let scoped: HostProject | null = null;
    return Atom.make((get): HostProject | null => {
      const head = get(hostProjectIndexAtom(ref.hostId)).get(ref.projectId);
      if (head === undefined) return null;
      if (head !== source) {
        source = head;
        scoped = scopeProject(ref.hostId, head);
      }
      return scoped;
    }).pipe(Atom.withLabel(`environment-project:${key}`));
  });
  const projectAtom = (ref: HostProjectRef) => projectByKey(projectKey(ref));

  let previousProjects: ReadonlyArray<HostProject> = [];
  const projectsAtom = Atom.make((get): ReadonlyArray<HostProject> => {
    const next: HostProject[] = [];
    for (const ref of get(projectRefsAtom)) {
      const project = get(projectAtom(ref));
      if (project !== null) next.push(project);
    }
    if (
      previousProjects.length === next.length &&
      previousProjects.every((project, index) => project === next[index])
    ) {
      return previousProjects;
    }
    previousProjects = next;
    return next;
  }).pipe(Atom.withLabel("environment-project-list"));

  return {
    hostProjectsAtom,
    hostProjectIndexAtom,
    hostProjectRefsAtom,
    projectRefsAtom,
    projectsAtom,
    projectAtom,
  };
}
