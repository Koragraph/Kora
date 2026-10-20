import * as Contracts from "@kora/contracts";
import type { ChatThread, HostId, ThreadIndexSnapshot } from "@kora/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { LocalLinkTarget } from "../link/model.ts";
import * as Entities from "./entities.ts";
import { createHostProjectAtoms } from "./projectEntities.ts";
import type { HostShellState } from "./shell.ts";
import { applySummaryStreamEvent } from "./shellReducer.ts";
import { createHostSnapshotAtom } from "./snapshots.ts";
import { createHostThreadDetailAtoms, mergeHostThread } from "./threadDetail.ts";
import { createHostThreadShellAtoms } from "./threadShell.ts";
import { EMPTY_HOST_THREAD_STATE, type HostThreadState } from "./threads.ts";

const HOME = Contracts.HostId.make("h-home");
const P1 = Contracts.ProjectId.make("pj-one");
const P2 = Contracts.ProjectId.make("pj-two");
const T1 = Contracts.ThreadId.make("th-one");
const T2 = Contracts.ThreadId.make("th-two");
const DAY = "2025-04-04T00:00:00.000Z";

/** What `run` threw. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("scoped keys", () => {
  it.each([
    [
      "project",
      Entities.parseProjectKey,
      Entities.InvalidScopedProjectKeyError,
      "no-separator-here",
    ],
    ["thread", Entities.parseThreadKey, Entities.InvalidScopedThreadKeyError, "also-no-separator"],
  ] as const)(
    "reports a malformed %s key as structured error data",
    (_kind, parse, ErrorClass, key) => {
      expect(thrown(() => parse(key))).toEqual(new ErrorClass({ key }));
    },
  );

  it("keeps the input and the JSON cause for a malformed project ref collection", () => {
    const error = thrown(() => Entities.parseProjectRefCollectionKey("{oops"));
    expect(error).toBeInstanceOf(Entities.InvalidScopedProjectRefCollectionKeyError);
    expect(error).toMatchObject({ key: "{oops", cause: expect.anything() });
  });

  it("refuses a collection with the wrong shape", () => {
    expect(() =>
      Entities.parseProjectRefCollectionKey(JSON.stringify([["only-a-host"]])),
    ).toThrowError(Entities.InvalidScopedProjectRefCollectionKeyError);
  });
});

// ---------------------------------------------------------------------------
// A small world of hosts, projects and threads
// ---------------------------------------------------------------------------

const SHELL = {
  ...Object.fromEntries(
    [
      "latestTurn",
      "session",
      "latestUserMessageAt",
      "branch",
      "worktreePath",
      "archivedAt",
      "settledAt",
      "settledOverride",
    ].map((k) => [k, null]),
  ),
  ...Object.fromEntries(
    ["hasPendingApprovals", "hasPendingUserInput", "hasActionableProposedPlan"].map((k) => [
      k,
      false,
    ]),
  ),
  id: T1,
  projectId: P1,
  title: "First thread",
  pullRequests: [],
  agentMode: "chat",
  interactionMode: "default",
  runtimeMode: "full-access",
  modelSelection: { instanceId: Contracts.AgentProfileId.make("codex"), model: "m-1" },
  createdAt: DAY,
  updatedAt: DAY,
} as unknown as ThreadIndexSnapshot["threads"][number];

const project = (id: Contracts.ProjectId, title: string, workspaceRoot: string) => ({
  id,
  title,
  workspaceRoot,
  scripts: [],
  defaultModelSelection: null,
  repositoryIdentity: null,
  createdAt: DAY,
  updatedAt: DAY,
});

const INDEX: ThreadIndexSnapshot = {
  seq: 1,
  updatedAt: DAY,
  projects: [project(P1, "One", "/src/one"), project(P2, "Two", "/src/two")],
  threads: [SHELL, { ...SHELL, id: T2, projectId: P2, title: "Second thread" }],
};

const live = (snapshot: ThreadIndexSnapshot): HostShellState => ({
  status: "live",
  error: Option.none(),
  snapshot: Option.some(snapshot),
});

const detailOf = (shell: typeof SHELL): ChatThread => ({
  ...(shell as unknown as ChatThread),
  deletedAt: null,
  ...{ messages: [], activities: [], checkpoints: [], proposedPlans: [] },
});

function world(
  hosts: ReadonlyArray<HostId> = [HOME],
  switchedOff: ReadonlySet<HostId> = new Set(),
) {
  const shells = Atom.family((_host: HostId) => Atom.make(AsyncResult.success(live(INDEX))));
  const threadStates = Atom.family((_key: string) =>
    Atom.make(AsyncResult.success(EMPTY_HOST_THREAD_STATE)),
  );
  const entry = (hostId: HostId) => ({
    enabled: !switchedOff.has(hostId),
    profile: Option.none(),
    target: new LocalLinkTarget({
      hostId,
      label: "Host",
      httpBaseUrl: "https://h.test",
      wsBaseUrl: "wss://h.test",
    }),
  });
  const catalogEntryAtom = Atom.make({
    isReady: true,
    entries: new Map(hosts.map((id) => [id, entry(id)])),
  });
  const snapshotAtom = createHostSnapshotAtom(shells);
  const stateKey = (hostId: HostId, threadId: Contracts.ThreadId) => `${hostId}\u0000${threadId}`;
  const registry = AtomRegistry.make();
  return {
    registry,
    catalogEntryAtom,
    projects: createHostProjectAtoms({ snapshotAtom, catalogEntryAtom }),
    shells: createHostThreadShellAtoms({ snapshotAtom, catalogEntryAtom }),
    details: createHostThreadDetailAtoms((hostId, threadId) =>
      threadStates(stateKey(hostId, threadId)),
    ),
    get: <A>(atom: Atom.Atom<A>) => registry.get(atom),
    /** Publish a new thread index for `host`. */
    publish: (snapshot: ThreadIndexSnapshot, host: HostId = HOME) =>
      registry.set(shells(host), AsyncResult.success(live(snapshot))),
    /** Publish a thread detail for HOME. */
    showDetail: (threadId: Contracts.ThreadId, thread: ChatThread) =>
      registry.set(
        threadStates(stateKey(HOME, threadId)),
        AsyncResult.success<HostThreadState>({
          status: "live",
          data: Option.some(thread),
          page: Option.none(),
          error: Option.none(),
        }),
      ),
  };
}

const renamed = (
  snapshot: ThreadIndexSnapshot,
  id: Contracts.ThreadId,
  title: string,
): ThreadIndexSnapshot => ({
  ...snapshot,
  seq: snapshot.seq + 1,
  threads: snapshot.threads.map((thread) => (thread.id === id ? { ...thread, title } : thread)),
});

describe("entity projections", () => {
  it("takes workspace metadata from the shell and collections from the detail", () => {
    const messages: ChatThread["messages"] = [];
    const detail = {
      ...detailOf(SHELL),
      messages,
      hostId: HOME,
      title: "Old title",
      branch: "old-branch",
      worktreePath: "/src/one/.wt/old",
      activeOrderKey: "z",
      unsettledAt: "2025-04-03T08:00:00.000Z",
    } satisfies ChatThread & { readonly hostId: HostId };
    const fresh = {
      title: "New title",
      branch: "new-branch",
      worktreePath: "/src/one/.wt/new",
      activeOrderKey: "c",
      unsettledAt: "2025-04-03T09:00:00.000Z",
    };
    const merged = mergeHostThread(detail, { ...SHELL, hostId: HOME, ...fresh });
    expect(merged).toMatchObject(fresh);
    expect(merged?.messages).toBe(messages);
  });

  it("keeps project and thread identities when an unrelated thread changes", () => {
    const w = world();
    const atoms = [
      w.projects.hostProjectRefsAtom(HOME),
      w.shells.hostThreadRefsAtom(HOME),
      w.projects.projectsAtom,
      w.projects.projectAtom({ hostId: HOME, projectId: P1 }),
      w.shells.threadShellAtom({ hostId: HOME, threadId: T1 }),
    ] as const;
    const before = atoms.map((atom) => w.get(atom as Atom.Atom<unknown>));
    w.publish(renamed(INDEX, T2, "Second, renamed"));
    atoms.forEach((atom, n) => expect(w.get(atom as Atom.Atom<unknown>)).toBe(before[n]));
  });

  it("keeps a project's thread collection when another project's thread changes", () => {
    const w = world();
    const byProject = w.shells.hostThreadRefsByProjectAtom(HOME);
    const forOne = w.shells.threadShellsForProjectRefsAtom([{ hostId: HOME, projectId: P1 }]);
    const membership = w.get(byProject);
    const refsOfOne = membership.get(P1);
    const threadsOfOne = w.get(forOne);
    expect(threadsOfOne.map(({ id }) => id)).toEqual([T1]);

    w.publish(renamed(INDEX, T2, "Changed over there"));
    expect(w.get(byProject)).toBe(membership);
    expect(w.get(byProject).get(P1)).toBe(refsOfOne);
    expect(w.get(forOne)).toBe(threadsOfOne);
  });

  it("serves list and point reads from the same values without an atom per listed thread", () => {
    const w = world();
    let index: ThreadIndexSnapshot = {
      ...INDEX,
      threads: Array.from({ length: 200 }, (_, n) => ({
        ...SHELL,
        id: Contracts.ThreadId.make(`row-${n}`),
      })),
    };
    w.publish(index);
    const all = w.shells.threadShellsAtom;
    const forOne = w.shells.threadShellsForProjectRefsAtom([{ hostId: HOME, projectId: P1 }]);
    const unmounts = [w.registry.mount(all), w.registry.mount(forOne)];
    try {
      const before = w.get(all);
      expect(before.length).toBe(200);
      expect(w.get(forOne)).toEqual(before);
      expect(w.registry.getNodes().size).toBeLessThan(20);
      const head = w.shells.threadShellAtom({ hostId: HOME, threadId: index.threads[0]!.id });
      expect(w.get(head)).toBe(before[0]);

      index = applySummaryStreamEvent(index, {
        kind: "thread-upserted",
        sequence: 2,
        thread: { ...index.threads.at(-1)!, title: "Last one, edited" },
      });
      w.publish(index);
      const after = w.get(all);
      expect(after[0]).toBe(before[0]);
      expect(after.at(-1)).not.toBe(before.at(-1));
      expect(after.at(-1)?.title).toBe("Last one, edited");
      expect(w.get(forOne).at(-1)).toBe(after.at(-1));
      expect(w.get(head)).toBe(after[0]);
      expect(w.registry.getNodes().size).toBeLessThan(20);
    } finally {
      unmounts.reverse().forEach((unmount) => unmount());
      w.registry.dispose();
    }
  });

  it("hides a switched-off host's rows but keeps its cached snapshot", () => {
    const away = Contracts.HostId.make("h-away");
    const w = world([HOME, away], new Set([away]));
    for (const rows of [w.get(w.projects.projectsAtom), w.get(w.shells.threadShellsAtom)]) {
      expect(rows.length).toBe(2);
      expect(rows.every(({ hostId }) => hostId === HOME)).toBe(true);
    }
    // Per-host atoms still read the cache, so switching it back on needs no refetch.
    expect(w.get(w.projects.hostProjectsAtom(away)).length).toBe(2);
  });

  it("keeps scoped identities and list order through moves, removals, additions and host changes", () => {
    const remote = Contracts.HostId.make("h-remote");
    const [homeRef, remoteRef] = [HOME, remote].map((hostId) => ({ hostId, threadId: T1 }));
    const w = world([HOME, remote]);
    const { threadShellsAtom: all } = w.shells;
    // Asked for out of order and with a duplicate.
    const picked = w.shells.threadShellsForProjectRefsAtom([
      { hostId: remote, projectId: P1 },
      { hostId: HOME, projectId: P2 },
      { hostId: remote, projectId: P1 },
      { hostId: HOME, projectId: P1 },
    ]);
    const unmounts = [w.registry.mount(all), w.registry.mount(picked)];
    try {
      const start = w.get(all);
      const homeOne = w.get(w.shells.threadShellAtom(homeRef!));
      const remoteOne = w.get(w.shells.threadShellAtom(remoteRef!));
      expect(start.length).toBe(4);
      expect([start[0], start[2]]).toEqual([homeOne, remoteOne]);
      expect(start[0]).toBe(homeOne);
      expect(start[2]).toBe(remoteOne);
      expect(homeOne).not.toBe(remoteOne);
      expect([homeOne?.hostId, remoteOne?.hostId]).toEqual([HOME, remote]);
      // Duplicate refs collapse and the requested project order is kept.
      expect(w.get(picked)).toEqual([remoteOne, start[1], homeOne]);

      // A reordered index changes the per-project membership order.
      w.publish({ ...INDEX, threads: [...INDEX.threads].reverse() }, remote);
      expect([...w.get(w.shells.hostThreadRefsByProjectAtom(remote)).keys()]).toEqual([P2, P1]);
      w.publish(INDEX, remote);

      // Move T1 to the second project.
      let index = applySummaryStreamEvent(INDEX, {
        kind: "thread-upserted",
        sequence: 2,
        thread: { ...SHELL, projectId: P2, title: "Moved over" },
      });
      w.publish(index);
      const moved = w.get(w.shells.threadShellAtom(homeRef!));
      expect(w.get(picked)).toEqual([remoteOne, moved, start[1]]);
      expect(w.get(all)[2]).toBe(remoteOne);

      // Remove T2.
      index = applySummaryStreamEvent(index, { kind: "thread-removed", sequence: 3, threadId: T2 });
      w.publish(index);
      expect(w.get(picked)).toEqual([remoteOne, moved]);
      expect(w.get(w.shells.threadShellAtom({ hostId: HOME, threadId: T2 }))).toBeNull();

      // Add a thread.
      const addedId = Contracts.ThreadId.make("th-added");
      index = applySummaryStreamEvent(index, {
        kind: "thread-upserted",
        sequence: 4,
        thread: { ...SHELL, id: addedId },
      });
      w.publish(index);
      const added = w.get(all)[1];
      expect(added?.id).toBe(addedId);
      expect(w.get(picked)).toEqual([remoteOne, moved, added]);

      // Host order follows the catalog; dropping a host drops its rows.
      const catalog = w.get(w.catalogEntryAtom);
      w.registry.set(w.catalogEntryAtom, {
        ...catalog,
        entries: new Map([...catalog.entries].reverse()),
      });
      expect(w.get(all)).toEqual([remoteOne, start[3], moved, added]);
      w.registry.set(w.catalogEntryAtom, {
        ...catalog,
        entries: new Map([[remote, catalog.entries.get(remote)!]]),
      });
      expect(w.get(all)).toEqual([remoteOne, start[3]]);
      w.publish({ ...INDEX, threads: [] }, remote);
      expect(w.get(all)).toEqual([]);
      expect(w.get(w.shells.threadShellAtom(remoteRef!))).toBeNull();
    } finally {
      unmounts.reverse().forEach((unmount) => unmount());
      w.registry.dispose();
    }
  });

  it("updates only the thread whose detail changed and keeps untouched fields by reference", () => {
    const w = world();
    const ref = { hostId: HOME, threadId: T1 };
    const detailAtom = w.details.detailAtom(ref);
    const messagesAtom = w.details.messagesAtom(ref);
    const activitiesAtom = w.details.activitiesAtom(ref);
    const otherAtom = w.details.detailAtom({ hostId: HOME, threadId: T2 });
    const otherBefore = w.get(otherAtom);
    const detail = detailOf(SHELL);

    w.showDetail(T1, detail);
    expect(w.get(detailAtom)).toEqual({ ...detail, hostId: HOME });
    expect(w.get(w.details.statusAtom(ref))).toBe("live");
    expect(w.get(otherAtom)).toBe(otherBefore);
    const messages = w.get(messagesAtom);
    const activities = w.get(activitiesAtom);

    w.showDetail(T1, {
      ...detail,
      session: {
        threadId: T1,
        lastError: null,
        activeTurnId: null,
        runtimeMode: "full-access",
        providerName: "codex",
        status: "ready",
        updatedAt: "2025-04-04T00:05:00.000Z",
      },
    });
    expect(w.get(messagesAtom)).toBe(messages);
    expect(w.get(activitiesAtom)).toBe(activities);
  });
});
