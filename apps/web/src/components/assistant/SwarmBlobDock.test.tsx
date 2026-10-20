import { SWARM_FLEET_WORKER } from "~/util/swarm.fixtures";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import type { FleetSnapshot, FleetWorker, HostThreadRef } from "@kora/contracts";

// This "unit" test project runs under plain Node (no jsdom); the worker window's Esc listener and
// resize handler need a `window`, and its portal needs a `document.body` — same fake
// window/document pattern as ThreadNav.test.tsx. Fake timers (installed before the window
// stub captures setTimeout/clearTimeout) let the close/minimize exit animation's timeout be
// driven deterministically instead of waiting on a real 180ms delay.
vi.useFakeTimers();
const fakeWindow = Object.assign(new EventTarget(), {
  innerHeight: 800,
  innerWidth: 1280,
  clearTimeout: globalThis.clearTimeout,
  setTimeout: globalThis.setTimeout,
});
vi.stubGlobal("window", fakeWindow);
vi.stubGlobal("document", { body: {} });

// No jsdom in this test project: react-dom's real createPortal insists on an actual DOM node as
// its container, and react-test-renderer can't host a react-dom portal's container bookkeeping
// either way. Render the portal's children inline instead — WorkerFloatingWindow.test.tsx is
// where the portal *target* itself (document.body) is asserted, via the same mock.
vi.mock("react-dom", () => ({ createPortal: (children: ReactNode) => children }));

// ── Stub every collaborator SwarmBlobDock/WorkerSlidePane reach into, so this test exercises
// only the dock's own mount/open/close/order behaviour, not the terminal surface, tooltip
// positioning or the RPC layer underneath useAtomAction. ──

let snapshot: FleetSnapshot | null = null;
vi.mock("~/components/FleetPanel", () => ({
  useFleetSnapshot: () => snapshot,
  mergedPaneIds: () => new Set<string>(),
}));

// The window hosts the shared worker pane (fleet/WorkerBox, tested on its own and in the QA spec); here it is a
// stand-in whose lights call straight through, so these tests cover only the dock ↔ window wiring.
vi.mock("~/components/fleet/WorkerBox", () => ({
  WorkerBox: (props: {
    worker: { paneId: string };
    onKill: () => void;
    onMinimize: () => void;
    onToggleExpand: () => void;
  }) => (
    <div data-worker-pane={props.worker.paneId}>
      <button aria-label="Stop worker" onClick={props.onKill} />
      <button aria-label="Minimize worker window" onClick={props.onMinimize} />
      <button aria-label="Maximize worker window" onClick={props.onToggleExpand} />
    </div>
  ),
}));
vi.mock("~/components/fleet/workerBoxes.css", () => ({}));

vi.mock("~/atoms/fleet", () => ({
  fleetHost: {
    extend: "fleet.extend",
    retry: "fleet.retry",
    steer: "fleet.steer",
    kill: "fleet.kill",
    merge: "fleet.merge",
  },
}));

const killCalls: unknown[] = [];
const steerCalls: unknown[] = [];
const retryCalls: unknown[] = [];
const extendCalls: unknown[] = [];
vi.mock("~/atoms/use-atom-command", () => ({
  useAtomAction: (command: string) => async (value: unknown) => {
    if (command === "fleet.kill") killCalls.push(value);
    if (command === "fleet.steer") steerCalls.push(value);
    if (command === "fleet.retry") retryCalls.push(value);
    if (command === "fleet.extend") extendCalls.push(value);
    return { _tag: "Success", value: {} };
  },
}));

let contextMenuResult: string | null = null;
const contextMenuCalls: unknown[] = [];
let confirmResult = true;
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({
    dialogs: {
      confirm: async () => confirmResult,
    },
    contextMenu: {
      close: async () => undefined,
      show: async (items: unknown, position: unknown) => {
        contextMenuCalls.push({ items, position });
        return contextMenuResult;
      },
    },
  }),
}));

let draftPrompt = "";
vi.mock("~/stores/promptDraftStore", () => ({
  usePromptDraftStore: {
    getState: () => ({
      setPrompt: (_ref: unknown, prompt: string) => {
        draftPrompt = prompt;
      },
      getComposerDraft: () => ({ prompt: draftPrompt }),
    }),
  },
}));

const toastCalls: unknown[] = [];
vi.mock("~/components/ui/toast", () => ({
  threadToast: (options: unknown) => options,
  toastManager: { add: (t: unknown) => toastCalls.push(t) },
}));

vi.mock("~/terminal/TerminalViewport", () => ({
  TerminalViewport: () => null,
}));

vi.mock("~/components/swarm/SwarmReportView", () => ({
  SwarmReportView: () => null,
}));

vi.mock("~/components/ui/button", () => ({
  Button: ({ children, ...rest }: { children?: ReactNode; [key: string]: unknown }) => (
    <button {...rest}>{children}</button>
  ),
}));

vi.mock("~/components/ui/tooltip", () => ({
  TooltipPopup: () => null,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children?: ReactNode }) =>
    children === undefined ? render : cloneElement(render, undefined, children),
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import { SwarmBlobDock, swarmDockGutterFor, swarmDockOverlapsColumn } from "./SwarmBlobDock";

const threadRef: HostThreadRef = { hostId: "local", threadId: "t1" } as HostThreadRef;

/** A swarm worker mid-task (the fixture's own task is done, which would fold it into the pile). */
function worker(over: Partial<FleetWorker>): FleetWorker {
  const running = { ...SWARM_FLEET_WORKER.swarm!, phase: "running" } as FleetWorker["swarm"];
  return { ...SWARM_FLEET_WORKER, swarm: running, ...over } as FleetWorker;
}

function snapshotOf(workers: FleetWorker[]): FleetSnapshot {
  return {
    updatedAt: new Date().toISOString(),
    lastVerdict: null,
    events: [],
    plan: "",
    workers,
    orchestratorId: "chat:t1",
    threadId: "t1",
  } as unknown as FleetSnapshot;
}

function findBlob(tree: ReactTestRenderer, title: string) {
  return tree.root.findAll(
    (node) =>
      node.type === "button" &&
      typeof node.props["aria-label"] === "string" &&
      (node.props["aria-label"] as string).startsWith(`Worker: ${title},`),
  )[0]!;
}

function blobLabels(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => node.type === "button" && typeof node.props["aria-label"] === "string")
    .map((n) => n.props["aria-label"] as string)
    .filter((l) => l.startsWith("Worker:"));
}

let renderer: ReactTestRenderer | null = null;
function renderDock(props: { onPaneMode?: () => void } = {}) {
  act(() => {
    renderer = create(<SwarmBlobDock threadRef={threadRef} {...props} />);
  });
  return renderer!;
}

describe("SwarmBlobDock", () => {
  it("shows the grid button only when the host wires onPaneMode, and clicking it calls back", () => {
    snapshot = snapshotOf([
      worker({ paneId: "p1", title: "Read the changelog", state: "working" }),
    ]);
    expect(
      renderDock().root.findAllByProps({ "aria-label": "Show all worker panes" }),
    ).toHaveLength(0);

    const onPaneMode = vi.fn();
    const tree = renderDock({ onPaneMode });
    const [button] = tree.root.findAllByProps({ "aria-label": "Show all worker panes" });
    expect(button).toBeDefined();
    act(() => button!.props.onClick());
    expect(onPaneMode).toHaveBeenCalledTimes(1);
  });

  it("dragging a blob sets the composer-mention payload on the dataTransfer", () => {
    snapshot = snapshotOf([worker({ paneId: "p3", title: "IMDb sitcoms", state: "working" })]);
    const tree = renderDock();
    const blob = findBlob(tree, "IMDb sitcoms");
    const data = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      setData: (type: string, value: string) => data.set(type, value),
    };
    act(() => blob.props.onDragStart({ dataTransfer }));
    expect(data.get("application/x-kora-composer-mention")).toBe("@worker p3 (IMDb sitcoms)");
    expect(dataTransfer.effectAllowed).toBe("move");
  });

  it("Give it more time routes minutes through fleet.extend", async () => {
    extendCalls.length = 0;
    contextMenuResult = "extend-15";
    snapshot = snapshotOf([
      worker({ paneId: "p1", title: "Read the changelog", state: "working" }),
    ]);
    const tree = renderDock();
    const blob = findBlob(tree, "Read the changelog");
    await act(async () => {
      blob.props.onContextMenu({ preventDefault: () => undefined, clientX: 1, clientY: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(extendCalls).toEqual([
      { hostId: "local", input: { threadId: "t1", paneId: "p1", minutes: 15 } },
    ]);
  });

  it("the menu's Reference in message appends the worker's reference to the composer draft", async () => {
    draftPrompt = "";
    contextMenuResult = "reference";
    snapshot = snapshotOf([worker({ paneId: "p3", title: "IMDb sitcoms", state: "working" })]);
    const tree = renderDock();
    const blob = findBlob(tree, "IMDb sitcoms");
    await act(async () => {
      blob.props.onContextMenu({ preventDefault: () => undefined, clientX: 1, clientY: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(draftPrompt).toBe("@worker p3 (IMDb sitcoms) ");
  });

  it("right-click opens the action menu and Retry routes through fleet.retry", async () => {
    contextMenuCalls.length = 0;
    retryCalls.length = 0;
    contextMenuResult = "retry";
    snapshot = snapshotOf([
      worker({ paneId: "p1", title: "Read the changelog", state: "working" }),
    ]);
    const tree = renderDock();
    const blob = findBlob(tree, "Read the changelog");
    await act(async () => {
      blob.props.onContextMenu({ preventDefault: () => undefined, clientX: 5, clientY: 6 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(contextMenuCalls).toEqual([{ items: expect.any(Array), position: { x: 5, y: 6 } }]);
    expect(retryCalls).toEqual([{ hostId: "local", input: { threadId: "t1", paneId: "p1" } }]);
  });

  it("routes the window's Stop through fleet.kill for the right pane", () => {
    killCalls.length = 0;
    snapshot = snapshotOf([
      worker({ paneId: "p1", title: "Read the changelog", state: "working" }),
    ]);
    const tree = renderDock();
    act(() => findBlob(tree, "Read the changelog").props.onClick());
    // The pane arms and confirms the stop itself (WorkerBox); the window just routes the result.
    act(() => tree.root.findByProps({ "aria-label": "Stop worker" }).props.onClick());
    expect(killCalls).toEqual([{ hostId: "local", input: { threadId: "t1", paneId: "p1" } }]);
  });

  it("closes the pane on its own if the worker drops out of the snapshot", () => {
    snapshot = snapshotOf([worker({ paneId: "p1", title: "Read the changelog", state: "idle" })]);
    const tree = renderDock();
    act(() => findBlob(tree, "Read the changelog").props.onClick());
    expect(tree.root.findAllByProps({ "data-worker-pane": "p1" }).length).toBeGreaterThan(0);

    act(() => {
      snapshot = snapshotOf([]);
      tree.update(<SwarmBlobDock threadRef={threadRef} />);
    });
    expect(tree.toJSON()).toBeNull();
  });

  it("opens the worker's slide pane on click, and closes it again", () => {
    snapshot = snapshotOf([worker({ paneId: "p1", title: "Read the changelog", state: "idle" })]);
    const tree = renderDock();
    expect(tree.root.findAllByProps({ "data-worker-pane": "p1" }).length).toBe(0);

    act(() => findBlob(tree, "Read the changelog").props.onClick());
    expect(tree.root.findAllByProps({ "data-worker-pane": "p1" }).length).toBeGreaterThan(0);

    const closeButton = tree.root.findByProps({ "aria-label": "Minimize worker window" });
    act(() => closeButton.props.onClick());
    // The close button starts a short exit animation before the window actually unmounts.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(tree.root.findAllByProps({ "data-worker-pane": "p1" }).length).toBe(0);
  });

  it("a CLI worker whose turn finished folds into the pile; a click lays the pile out", () => {
    const cli = (over: Partial<FleetWorker>): FleetWorker => {
      const { swarm: _swarm, ...rest } = worker({ agent: "claude", ...over });
      return rest as FleetWorker;
    };
    snapshot = snapshotOf([
      cli({ paneId: "p1", title: "Research A", state: "working" }),
      cli({ paneId: "p2", title: "Research B", state: "working" }),
    ]);
    const tree = renderDock();
    act(() => {
      snapshot = snapshotOf([
        cli({ paneId: "p1", title: "Research A", state: "idle", turnEndedAt: 65_000 }),
        cli({ paneId: "p2", title: "Research B", state: "working" }),
      ]);
      tree.update(<SwarmBlobDock threadRef={threadRef} />);
    });
    expect(blobLabels(tree)).toEqual(["Worker: Research B, working"]);
    const pile = tree.root.findByProps({ "aria-label": "1 finished worker" });
    act(() => pile.props.onClick());
    expect(blobLabels(tree)).toEqual(["Worker: Research B, working", "Worker: Research A, done"]);
    // Plain idle (never worked) stays live; stopped on an error reads failed and rests in the pile.
    act(() => {
      snapshot = snapshotOf([
        cli({ paneId: "p1", title: "Research A", state: "idle", stoppedOnError: "API Error: 500" }),
        cli({ paneId: "p2", title: "Research B", state: "idle" }),
      ]);
      tree.update(<SwarmBlobDock threadRef={threadRef} />);
    });
    expect(findBlob(tree, "Research A").props["aria-label"]).toBe("Worker: Research A, failed");
    expect(findBlob(tree, "Research B").props["aria-label"]).toBe("Worker: Research B, idle");
  });

  it("puts working workers on top and folds finished ones into a pile with a count", () => {
    snapshot = snapshotOf([
      worker({ paneId: "p1", title: "First", state: "exited", exitCode: 0 }),
      worker({ paneId: "p2", title: "Second", state: "idle" }),
      worker({ paneId: "p3", title: "Third", state: "working" }),
      worker({ paneId: "p4", title: "Fourth", state: "exited", exitCode: 1 }),
    ]);
    const tree = renderDock();
    expect(blobLabels(tree)).toEqual(["Worker: Third, working", "Worker: Second, idle"]);
    expect(tree.root.findAllByProps({ "aria-label": "2 finished workers" })).toHaveLength(1);
  });

  it("renders one blob per worker, with an aria-label naming the worker and its state", () => {
    snapshot = snapshotOf([
      worker({ paneId: "p1", title: "Read the changelog", state: "working" }),
      worker({ paneId: "p2", title: "Summarize PR #12", state: "blocked" }),
    ]);
    const tree = renderDock();
    expect(findBlob(tree, "Read the changelog").props["aria-label"]).toBe(
      "Worker: Read the changelog, working",
    );
    expect(findBlob(tree, "Summarize PR #12").props["aria-label"]).toBe(
      "Worker: Summarize PR #12, needs you",
    );
  });
  it("renders nothing when the thread has no workers", () => {
    snapshot = snapshotOf([]);
    const tree = renderDock();
    expect(tree.toJSON()).toBeNull();
  });
});

describe("swarmDockOverlapsColumn", () => {
  it("keeps the chat centred while the column clears the blobs, and pads only when it would run under them", () => {
    // 768px column: it clears a 64px gutter from 896px up
    expect(swarmDockOverlapsColumn(1400)).toBe(false);
    expect(swarmDockOverlapsColumn(896)).toBe(false);
    expect(swarmDockOverlapsColumn(895)).toBe(true);
    expect(swarmDockOverlapsColumn(600)).toBe(true);
    // a larger root font widens the column
    expect(swarmDockOverlapsColumn(1000, 20)).toBe(true);
  });

  it("pads by the dock's measured width when it is wider than the bare sprites", () => {
    // A 908px timeline, a wide dock starting 116px from its right edge.
    const gutter = swarmDockGutterFor({ right: 1180 }, { left: 1064, width: 102 });
    expect(gutter).toBe(116);
    // 70px of margin clears bare blobs but not this dock, so the column must give way.
    expect(swarmDockOverlapsColumn(908)).toBe(false);
    expect(swarmDockOverlapsColumn(908, 16, gutter)).toBe(true);
    expect(swarmDockOverlapsColumn(1000, 16, gutter)).toBe(false);
    // never under the blob-only default, and an unlaid dock falls back to it
    expect(swarmDockGutterFor({ right: 1000 }, { left: 960, width: 40 })).toBe(64);
    expect(swarmDockGutterFor({ right: 1000 }, { left: 0, width: 0 })).toBe(64);
  });
});
