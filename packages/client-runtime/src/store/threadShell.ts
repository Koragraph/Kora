import type {
  ThreadIndexSnapshot,
  ThreadId,
  HostThreadRef,
  HostProjectRef,
  ProjectId,
  HostId,
  ChatThreadHead,
} from "@kora/contracts";
import { Atom } from "effect/unstable/reactivity";

import { enabledHostIds, type HostCatalogState } from "./connections.ts";
import {
  threadRefsEqual,
  threadKey,
  projectRefCollectionKey,
  parseThreadKey,
  parseProjectRefCollectionKey,
  arrayElementsEqual,
} from "./entities.ts";
import { scopeThreadSummary, type HostThreadShell } from "./models.ts";

const NO_THREADS: ReadonlyArray<ChatThreadHead> = Object.freeze([]);
const NO_INDEX: ReadonlyMap<ThreadId, ChatThreadHead> = new Map();
const NO_REFS_BY_PROJECT: ReadonlyMap<ProjectId, ReadonlyArray<HostThreadRef>> = new Map();

type RefsByProject = ReadonlyMap<ProjectId, ReadonlyArray<HostThreadRef>>;

/**
 * Thread-list atoms derived from each host's thread-index snapshot. Every derived collection
 * keeps its previous instance while its contents are unchanged, because consumers compare by
 * reference to decide whether to re-render.
 */
export function createHostThreadShellAtoms(input: {
  readonly catalogEntryAtom: Atom.Atom<HostCatalogState>;
  readonly snapshotAtom: (hostId: HostId) => Atom.Atom<ThreadIndexSnapshot | null>;
}) {
  // One scoped shell per (head object, host), so no atom per thread is needed to keep identity.
  const scopedByHead = new WeakMap<ChatThreadHead, Map<HostId, HostThreadShell>>();
  const scopedThread = (hostId: HostId, head: ChatThreadHead): HostThreadShell => {
    let byHost = scopedByHead.get(head);
    if (byHost === undefined) {
      byHost = new Map();
      scopedByHead.set(head, byHost);
    }
    let shell = byHost.get(hostId);
    if (shell === undefined) {
      shell = scopeThreadSummary(hostId, head);
      byHost.set(hostId, shell);
    }
    return shell;
  };

  const hostThreadsAtom = Atom.family((hostId: HostId) =>
    Atom.make(
      (get): ReadonlyArray<ChatThreadHead> =>
        get(input.snapshotAtom(hostId))?.threads ?? NO_THREADS,
    ).pipe(Atom.withLabel(`environment-threads:${hostId}`)),
  );

  const hostThreadIndexAtom = Atom.family((hostId: HostId) =>
    Atom.make((get): ReadonlyMap<ThreadId, ChatThreadHead> => {
      const threads = get(hostThreadsAtom(hostId));
      return threads.length === 0
        ? NO_INDEX
        : new Map(threads.map((thread) => [thread.id, thread]));
    }).pipe(Atom.withLabel(`environment-thread-index:${hostId}`)),
  );

  const hostThreadRefsAtom = Atom.family((hostId: HostId) => {
    let previous: ReadonlyArray<HostThreadRef> = [];
    return Atom.make((get): ReadonlyArray<HostThreadRef> => {
      const next = get(hostThreadsAtom(hostId)).map((thread) => ({ hostId, threadId: thread.id }));
      if (threadRefsEqual(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-thread-refs:${hostId}`));
  });

  const hostThreadRefsByProjectAtom = Atom.family((hostId: HostId) => {
    let previous: RefsByProject = NO_REFS_BY_PROJECT;
    return Atom.make((get): RefsByProject => {
      const threads = get(hostThreadsAtom(hostId));
      if (threads.length === 0) {
        previous = NO_REFS_BY_PROJECT;
        return previous;
      }

      const grouped = new Map<ProjectId, HostThreadRef[]>();
      for (const thread of threads) {
        const ref: HostThreadRef = { hostId, threadId: thread.id };
        const list = grouped.get(thread.projectId);
        if (list) list.push(ref);
        else grouped.set(thread.projectId, [ref]);
      }

      // Reuse each project's previous array when equal; reuse the whole map when nothing moved.
      const next = new Map<ProjectId, ReadonlyArray<HostThreadRef>>();
      for (const [projectId, refs] of grouped) {
        const before = previous.get(projectId);
        next.set(projectId, before !== undefined && threadRefsEqual(before, refs) ? before : refs);
      }
      const previousKeys = [...previous.keys()];
      const unchanged =
        previous.size === next.size &&
        [...next.keys()].every((projectId, index) => previousKeys[index] === projectId) &&
        [...next].every(([projectId, refs]) => previous.get(projectId) === refs);
      if (unchanged) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-thread-refs-by-project:${hostId}`));
  });

  const shellByKey = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get): HostThreadShell | null => {
      const head = get(hostThreadIndexAtom(ref.hostId)).get(ref.threadId);
      return head === undefined ? null : scopedThread(ref.hostId, head);
    }).pipe(Atom.withLabel(`environment-thread-shell:${key}`));
  });
  const threadShellAtom = (ref: HostThreadRef) => shellByKey(threadKey(ref));

  const shellsForProjects = Atom.family((key: string) => {
    const projectRefs = parseProjectRefCollectionKey(key);
    let previous: ReadonlyArray<HostThreadShell> = [];
    return Atom.make((get): ReadonlyArray<HostThreadShell> => {
      const next: HostThreadShell[] = [];
      const seen = new Set<string>();
      for (const projectRef of projectRefs) {
        const refs = get(hostThreadRefsByProjectAtom(projectRef.hostId)).get(projectRef.projectId);
        if (refs === undefined || refs.length === 0) continue;
        const index = get(hostThreadIndexAtom(projectRef.hostId));
        for (const ref of refs) {
          const id = threadKey(ref);
          if (seen.has(id)) continue;
          seen.add(id);
          const head = index.get(ref.threadId);
          if (head !== undefined) next.push(scopedThread(ref.hostId, head));
        }
      }
      // Keep the old array when nothing changed so subscribers can skip work.
      if (!arrayElementsEqual(previous, next)) previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-thread-shells-for-projects:${key}`));
  });
  const threadShellsForProjectRefsAtom = (refs: ReadonlyArray<HostProjectRef>) =>
    shellsForProjects(projectRefCollectionKey(refs));

  let previousRefs: ReadonlyArray<HostThreadRef> = [];
  const threadRefsAtom = Atom.make((get): ReadonlyArray<HostThreadRef> => {
    const next: HostThreadRef[] = [];
    for (const hostId of enabledHostIds(get(input.catalogEntryAtom))) {
      next.push(...get(hostThreadRefsAtom(hostId)));
    }
    if (threadRefsEqual(previousRefs, next)) return previousRefs;
    previousRefs = next;
    return next;
  }).pipe(Atom.withLabel("environment-thread-refs"));

  let previousShells: ReadonlyArray<HostThreadShell> = [];
  const threadShellsAtom = Atom.make((get): ReadonlyArray<HostThreadShell> => {
    const next: HostThreadShell[] = [];
    for (const hostId of enabledHostIds(get(input.catalogEntryAtom))) {
      const index = get(hostThreadIndexAtom(hostId));
      for (const thread of get(hostThreadsAtom(hostId))) {
        const head = index.get(thread.id);
        if (head !== undefined) next.push(scopedThread(hostId, head));
      }
    }
    if (arrayElementsEqual(previousShells, next)) return previousShells;
    previousShells = next;
    return next;
  }).pipe(Atom.withLabel("environment-thread-shell-list"));

  return {
    hostThreadsAtom,
    hostThreadIndexAtom,
    hostThreadRefsAtom,
    hostThreadRefsByProjectAtom,
    threadRefsAtom,
    threadShellsAtom,
    threadShellsForProjectRefsAtom,
    threadShellAtom,
  };
}
