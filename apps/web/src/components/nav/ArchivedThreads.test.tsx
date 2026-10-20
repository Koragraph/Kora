import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { HostId, ThreadId } from "@kora/contracts";

const hostId = HostId.make("local");
const archived = (id: string, projectId: string, archivedAt: string) => ({
  archivedAt,
  title: `Chat ${id}`,
  projectId,
  id: ThreadId.make(id),
});

let snapshots: Array<{ hostId: HostId; snapshot: unknown }> = [];
const refresh = vi.fn();
const unarchiveThread = vi.fn(async (_ref: unknown) => ({ _tag: "Success" as const }));
const addToast = vi.fn();
const confirmAndDeleteThread = vi.fn(async (_ref: unknown) => ({ _tag: "Success" as const }));

vi.mock("../../util/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots, error: null, isLoading: false, refresh }),
}));
vi.mock("../../hooks/useThreadCommands", () => ({
  useThreadCommands: () => ({ unarchiveThread, confirmAndDeleteThread }),
}));
vi.mock("../../atoms/hosts", () => ({ usePrimaryHostId: () => hostId }));
vi.mock("../ui/toast", () => ({ toastManager: { add: addToast } }));
vi.mock("@kora/client-runtime/store/runtime", () => ({ isAtomActionInterrupted: () => false }));

let mod: typeof import("./ArchivedThreads");
beforeAll(async () => {
  mod = await import("./ArchivedThreads");
}, 30_000);

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.clearAllMocks();
});

function render() {
  act(() => {
    renderer = create(<mod.ArchivedThreads />);
  });
  return renderer!;
}

const button = (tree: ReactTestRenderer, label: string) =>
  tree.root.find(
    (node) =>
      node.type === "button" &&
      (node.props["aria-label"] === label ||
        node.findAll((child) => child.children.includes(label)).length > 0),
  );

describe("ArchivedThreads", () => {
  it("reports a failed unarchive", async () => {
    snapshots = [
      {
        snapshot: { projects: [], threads: [archived("t1", "p1", "2026-09-20T00:00:00.000Z")] },
        hostId,
      },
    ];
    unarchiveThread.mockResolvedValueOnce({ _tag: "Failure" } as never);
    const tree = render();
    act(() => button(tree, "Archived (1)").props.onClick());
    await act(async () => button(tree, "Unarchive Chat t1").props.onClick());
    expect(addToast).toHaveBeenCalledWith({ type: "error", title: "Failed to unarchive chat" });
  });

  it("expands to the archived threads and unarchives one", async () => {
    snapshots = [
      {
        snapshot: {
          threads: [archived("t1", "p1", "2026-09-20T00:00:00.000Z")],
          projects: [{ id: "p1", title: "alpha" }],
        },
        hostId,
      },
    ];
    const tree = render();
    const toggle = button(tree, "Archived (1)");
    expect(toggle.props["aria-expanded"]).toBe(false);

    act(() => toggle.props.onClick());
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => button(tree, "Unarchive Chat t1").props.onClick());
    expect(unarchiveThread).toHaveBeenCalledWith({ hostId, threadId: "t1" });
    expect(addToast).not.toHaveBeenCalled();
  });
  it("deletes an archived thread without unarchiving it first", async () => {
    snapshots = [
      {
        snapshot: { projects: [], threads: [archived("t1", "p1", "2026-09-20T00:00:00.000Z")] },
        hostId,
      },
    ];
    const tree = render();
    act(() => button(tree, "Archived (1)").props.onClick());
    await act(async () => button(tree, "Delete Chat t1").props.onClick());
    expect(confirmAndDeleteThread).toHaveBeenCalledWith({ hostId, threadId: "t1" });
    expect(unarchiveThread).not.toHaveBeenCalled();
  });
  it("renders nothing when no thread is archived", () => {
    snapshots = [{ hostId, snapshot: { projects: [], threads: [] } }];
    expect(render().toJSON()).toBeNull();
  });
});

describe("listArchivedThreads", () => {
  it("flattens snapshots with their folder name, most recently archived first", () => {
    const rows = mod.listArchivedThreads([
      {
        snapshot: {
          threads: [
            archived("t1", "p1", "2026-09-20T00:00:00.000Z"),
            archived("t2", "gone", "2026-09-22T00:00:00.000Z"),
          ],
          projects: [{ id: "p1", title: "alpha" }],
        },
        hostId,
      },
    ]);
    expect(rows.map((r) => [r.id, r.projectTitle])).toEqual([
      ["t2", null],
      ["t1", "alpha"],
    ]);
  });
});
