import { HostId, type WorkspaceFileReadResult, type WorkspaceListResult } from "@kora/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

const host = vi.hoisted(() => ({
  readFile: vi.fn(),
  optimisticFile: vi.fn(),
  listEntries: vi.fn(),
}));
const active = vi.hoisted(() => ({
  registry: null as { get(atom: object): unknown; refresh(atom: object): void } | null,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: object) => active.registry?.get(atom),
  useAtomRefresh: (atom: object) => () => active.registry?.refresh(atom),
}));
// Hooks run as plain calls: slots by call order, effects fire immediately.
vi.mock("react", async (original) => {
  const { hookStub } = await import("~/test/hookStub");
  return {
    ...(await original<typeof import("react")>()),
    useCallback: hookStub.useCallback,
    useRef: hookStub.useRef,
    useEffect: (effect: () => void) => void effect(),
  };
});
vi.mock("~/atoms/projects", () => ({ projectHost: host }));
vi.mock("~/atoms/queries", () => ({ useProjectPathSearch: vi.fn() }));

import { useWorkspaceMutationRefresh } from "~/hooks/useRefreshOnWorkspaceChange";
import { hookStub } from "~/test/hookStub";

import { useProjectEntriesQuery, useProjectFile } from "./projectFilesQueryState";

const HOST = HostId.make("env-q");

/** A promise the test settles by hand. */
function manual<T>() {
  const box = {} as { done: (v: T) => void };
  const promise = new Promise<T>((resolve) => {
    box.done = resolve;
  });
  return { promise, done: box.done };
}

/** An atom whose every (re)load becomes a request the test answers. */
function requestLog<T>() {
  const requests: Array<ReturnType<typeof manual<T>>> = [];
  const atom = Atom.make(
    Effect.promise(() => {
      const pending = manual<T>();
      requests.push(pending);
      return pending.promise;
    }),
  ).pipe(Atom.swr({ staleTime: 30_000, revalidateOnMount: true }));
  return { atom, requests };
}

const fileResult = (contents: string): WorkspaceFileReadResult => ({
  contents,
  truncated: false,
  relativePath: "src/preview.ts",
  byteLength: new TextEncoder().encode(contents).length,
});
const listing = (...paths: string[]): WorkspaceListResult => ({
  truncated: false,
  entries: paths.map((path) => ({ path, kind: "file" })),
});
const settle = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

beforeEach(() => {
  for (const fn of Object.values(host)) fn.mockReset();
  hookStub.clear();
});

describe("project query refresh", () => {
  test("a disabled image preview never reads the file", async () => {
    const { atom, requests } = requestLog<WorkspaceFileReadResult>();
    const registry = AtomRegistry.make();
    host.readFile.mockReturnValue(atom);
    host.optimisticFile.mockReturnValue(Atom.make(null));
    active.registry = registry;

    try {
      hookStub.startRender();
      const query = useProjectFile(HOST, "/repo", "preview.png", false);
      useWorkspaceMutationRefresh({
        resourceKey: "file:env-q:/repo:preview.png",
        refresh: query.refresh,
        mutationId: "m-1",
        enabled: false,
      });
      await settle();

      expect(host.readFile).not.toHaveBeenCalled();
      expect(requests).toHaveLength(0);
    } finally {
      registry.dispose();
      active.registry = null;
    }
  });

  test("a mutation seen after mount revalidates a cached directory listing", async () => {
    const { atom, requests } = requestLog<WorkspaceListResult>();
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atom);
    host.listEntries.mockReturnValue(atom);
    active.registry = registry;
    let shown: readonly string[] = [];

    const draw = (mutationId: string | null) => {
      hookStub.startRender();
      const query = useProjectEntriesQuery(HOST, "/repo");
      shown = query.data?.entries.map((e) => e.path) ?? [];
      useWorkspaceMutationRefresh({
        resourceKey: "files:env-q:/repo",
        refresh: query.refresh,
        mutationId,
      });
    };

    try {
      await settle();
      expect(requests).toHaveLength(1);
      requests[0]!.done(listing("src/old.ts"));
      await settle();

      draw("m-1");
      expect(shown).toEqual(["src/old.ts"]);
      await settle();
      expect(requests).toHaveLength(2);

      requests[1]!.done(listing("src/new.ts"));
      await settle();
      draw("m-1");
      expect(shown).toEqual(["src/new.ts"]);
      expect(requests).toHaveLength(2);
    } finally {
      unmount();
      registry.dispose();
      active.registry = null;
    }
  });

  test("a mutation during the first read supersedes it, so a late stale answer is ignored", async () => {
    const { atom, requests } = requestLog<WorkspaceFileReadResult>();
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atom);
    host.readFile.mockReturnValue(atom);
    host.optimisticFile.mockReturnValue(Atom.make(null));
    active.registry = registry;
    let latest: string | null = null;

    const render = (mutationId: string | null) => {
      hookStub.startRender();
      const query = useProjectFile(HOST, "/repo", "src/preview.ts");
      latest = query.data?.contents ?? null;
      useWorkspaceMutationRefresh({
        resourceKey: "file:env-q:/repo:src/preview.ts",
        refresh: query.refresh,
        mutationId,
      });
    };

    try {
      render(null);
      await settle();
      expect(requests).toHaveLength(1);

      render("m-1");
      await settle();
      expect(requests).toHaveLength(2);

      requests[1]!.done(fileResult("fresh"));
      await settle();
      render("m-1");
      expect(latest).toBe("fresh");

      requests[0]!.done(fileResult("stale"));
      await settle();
      render("m-1");
      expect(latest).toBe("fresh");
    } finally {
      unmount();
      registry.dispose();
      active.registry = null;
    }
  });
});
