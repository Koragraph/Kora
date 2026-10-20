import { HostId } from "@kora/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const spies = vi.hoisted(() => ({ write: vi.fn(), confirm: vi.fn() }));
vi.mock("~/atoms/projects", () => ({ projectHost: { writeFile: {} } }));
vi.mock("~/atoms/use-atom-command", () => ({ useAtomAction: () => spies.write }));
vi.mock("./projectFilesQueryState", () => ({ confirmProjectFileQueryData: spies.confirm }));

import { setMarkdownTaskChecked } from "./fileViewerMode";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";

type Props = Parameters<typeof useFileSaveCoordinator>[0];

const HOST = HostId.make("host-save");
const pendingChanged = vi.fn();
const BASE: Props = {
  hostId: HOST,
  cwd: "/ws",
  relativePath: "file.txt",
  onPendingChange: pendingChanged,
};

/** Stand-in for the editor: it only receives the `onChange` the hook gives out. */
function EditorStub(_props: { onChange: (contents: string) => void }) {
  return null;
}
function Surface(props: Props) {
  const saver = useFileSaveCoordinator(props);
  return <EditorStub onChange={(text) => saver.change(text)} />;
}

let view: ReactTestRenderer | null = null;
const strict = (props: Props) => (
  <StrictMode>
    <Surface {...props} />
  </StrictMode>
);
const mount = (props: Props = BASE) =>
  act(() => {
    view = create(strict(props));
  });
const rerender = (props: Props) =>
  act(() => {
    view!.update(strict(props));
  });
const unmount = async () => {
  await act(async () => view!.unmount());
  view = null;
};
const typeText = () => view!.root.findByType(EditorStub).props.onChange as (c: string) => void;
const writes = () => spies.write.mock.calls.map(([req]) => req);

beforeEach(() => {
  view = null;
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  spies.write.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  spies.confirm.mockReset();
  pendingChanged.mockReset();
});

afterEach(async () => {
  await act(async () => view?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useFileSaveCoordinator", () => {
  test("edits are written once, after a 500ms pause, then confirmed and reported pending→idle", async () => {
    mount();
    typeText()("hello\n");
    expect(pendingChanged).toHaveBeenCalledWith("file.txt", true);

    await vi.advanceTimersByTimeAsync(500);

    expect(spies.write).toHaveBeenCalledExactlyOnceWith({
      hostId: HOST,
      input: { cwd: "/ws", relativePath: "file.txt", contents: "hello\n" },
    });
    expect(spies.confirm).toHaveBeenCalledExactlyOnceWith(HOST, "/ws", "file.txt", "hello\n");
    expect(pendingChanged).toHaveBeenLastCalledWith("file.txt", false);
  });

  test("re-rendering the same file does not restart the debounce", async () => {
    mount();
    typeText()("first");
    await vi.advanceTimersByTimeAsync(300);
    rerender(BASE);
    typeText()("latest");

    await vi.advanceTimersByTimeAsync(499);
    expect(spies.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(writes().map((w) => w.input.contents)).toEqual(["latest"]);
  });

  test("unmounting flushes what is pending, and the old callback is dead afterwards", async () => {
    mount();
    const oldHandler = typeText();
    oldHandler("pending edit");
    await unmount();
    oldHandler("too late");
    await vi.runAllTimersAsync();

    expect(writes().map((w) => w.input.contents)).toEqual(["pending edit"]);
  });

  test("a callback from a previous mount cannot write after the file is mounted again", async () => {
    mount();
    const oldHandler = typeText();
    await unmount();
    mount();
    oldHandler("stale");
    typeText()("current");
    await vi.runAllTimersAsync();

    expect(writes().map((w) => w.input.contents)).toEqual(["current"]);
  });

  test.each([
    ["host", { hostId: HostId.make("other-host") }],
    ["folder", { cwd: "/elsewhere" }],
    ["file", { relativePath: "other.txt" }],
  ] as const)(
    "when the %s changes, the old file's edit is flushed there and stale callbacks are dead",
    async (_what, patch) => {
      mount();
      const oldHandler = typeText();
      oldHandler("edit to old file");
      const next: Props = { ...BASE, ...patch };
      rerender(next);

      oldHandler("stale");
      typeText()("edit to new file");
      await vi.runAllTimersAsync();

      expect(writes()).toEqual([
        {
          hostId: HOST,
          input: { cwd: "/ws", relativePath: "file.txt", contents: "edit to old file" },
        },
        {
          hostId: next.hostId,
          input: { cwd: next.cwd, relativePath: next.relativePath, contents: "edit to new file" },
        },
      ]);
    },
  );

  test("a rendered markdown checkbox tick is saved like any other edit", async () => {
    mount({ ...BASE, relativePath: "README.md" });
    typeText()(setMarkdownTaskChecked("- [ ] task\n", 2, true));
    await vi.advanceTimersByTimeAsync(500);

    expect(spies.write).toHaveBeenCalledExactlyOnceWith({
      hostId: HOST,
      input: { cwd: "/ws", relativePath: "README.md", contents: "- [x] task\n" },
    });
  });
});
