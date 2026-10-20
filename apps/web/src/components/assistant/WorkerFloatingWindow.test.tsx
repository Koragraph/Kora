import { SWARM_FLEET_WORKER } from "~/util/swarm.fixtures";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import type { FleetWorker, HostThreadRef } from "@kora/contracts";

// Same constraints as SwarmBlobDock.test.tsx: no jsdom in this test project, and fake timers
// (installed before window's setTimeout/clearTimeout are captured) drive the exit animation's
// timeout deterministically.
vi.useFakeTimers();
const fakeWindow = Object.assign(new EventTarget(), {
  innerHeight: 800,
  innerWidth: 1280,
  clearTimeout: globalThis.clearTimeout,
  setTimeout: globalThis.setTimeout,
});
vi.stubGlobal("window", fakeWindow);

// A distinct, identifiable stand-in for document.body — real DOM isn't available here, so the
// "renders via a portal" test asserts the window is handed to createPortal with exactly this
// object, rather than trying to inspect real DOM structure.
const bodyMarker = { __bodyMarker: true };
vi.stubGlobal("document", { body: bodyMarker });

const portalCalls: unknown[] = [];
vi.mock("react-dom", () => ({
  createPortal: (children: ReactNode, container: unknown) => {
    portalCalls.push(container);
    return children;
  },
}));

// The window hosts the shared worker pane (fleet/WorkerBox); here it is a stand-in that records the props the
// window hands it, so these tests pin the window's own wiring: lights, Esc, drag, maximize, portal.
const paneProps: Array<Record<string, unknown>> = [];
vi.mock("~/components/fleet/WorkerBox", () => ({
  WorkerBox: (props: Record<string, unknown>) => {
    paneProps.push(props);
    return <div data-pane-stub="" {...(props.titlebarProps as object)} />;
  },
}));
vi.mock("~/components/fleet/workerBoxes.css", () => ({}));

import { WorkerFloatingWindow } from "./WorkerFloatingWindow";

const threadRef: HostThreadRef = { hostId: "local", threadId: "t1" } as HostThreadRef;
const worker: FleetWorker = {
  ...SWARM_FLEET_WORKER,
  paneId: "p1",
  title: "Read the changelog",
  state: "working",
} as FleetWorker;

function renderWindow(
  overrides: {
    onClose?: () => void;
    onKill?: () => void;
    onSteer?: (text: string) => Promise<unknown>;
    onOpenMenu?: (position: { x: number; y: number }) => void;
    worker?: FleetWorker;
  } = {},
) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <WorkerFloatingWindow
        threadRef={threadRef}
        worker={overrides.worker ?? worker}
        onClose={overrides.onClose ?? (() => {})}
        onKill={overrides.onKill ?? (() => {})}
        onSteer={overrides.onSteer ?? (async () => {})}
        {...(overrides.onOpenMenu ? { onOpenMenu: overrides.onOpenMenu } : {})}
      />,
    );
  });
  return tree;
}

const lastPane = () => paneProps.at(-1)!;

describe("WorkerFloatingWindow", () => {
  it("hosts the shared worker pane as a window, never a bare terminal", () => {
    paneProps.length = 0;
    renderWindow();
    expect(lastPane()).toMatchObject({ variant: "window", worker, expanded: false, merged: false });
  });

  it("passes the ⋯ actions menu through only when given", () => {
    paneProps.length = 0;
    renderWindow();
    expect(lastPane().onOpenMenu).toBeUndefined();
    const onOpenMenu = vi.fn();
    renderWindow({ onOpenMenu });
    expect(lastPane().onOpenMenu).toBe(onOpenMenu);
  });

  it("red (the pane's stop) stops the worker and leaves the window open", () => {
    const onKill = vi.fn();
    const onClose = vi.fn();
    renderWindow({ onKill, onClose });
    act(() => (lastPane().onKill as () => void)());
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onKill).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("yellow tucks the window back into its sprite after the exit animation", () => {
    const onClose = vi.fn();
    const tree = renderWindow({ onClose });
    act(() => (lastPane().onMinimize as () => void)());
    expect(tree.root.findByProps({ "data-worker-window": "p1" }).props["data-exiting"]).toBe(
      "minimize",
    );
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("green maximizes and restores without closing", () => {
    const onClose = vi.fn();
    const tree = renderWindow({ onClose });
    const root = () => tree.root.findByProps({ "data-worker-window": "p1" });
    act(() => (lastPane().onToggleExpand as () => void)());
    expect(root().props["data-maximized"]).toBe(true);
    expect(lastPane().expanded).toBe(true);
    act(() => (lastPane().onToggleExpand as () => void)());
    expect(root().props["data-maximized"]).toBe(false);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Esc closes the window once, but never from inside a terminal", () => {
    const onClose = vi.fn();
    const tree = renderWindow({ onClose });
    const root = tree.root.findByProps({ "data-worker-window": "p1" });
    const inTerminal = { closest: (sel: string) => (sel === ".wb-term" ? {} : null) };
    act(() => root.props.onKeyDown({ key: "Escape", defaultPrevented: false, target: inTerminal }));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onClose).not.toHaveBeenCalled();
    const plain = { closest: () => null };
    act(() => root.props.onKeyDown({ key: "Escape", defaultPrevented: false, target: plain }));
    act(() => root.props.onKeyDown({ key: "Escape", defaultPrevented: false, target: plain }));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the title bar drags the window, but not from a button or the steer input", () => {
    const tree = renderWindow();
    const bar = () => tree.root.findByProps({ "data-pane-stub": "" });
    const root = () => tree.root.findByProps({ "data-worker-window": "p1" });
    const capture = { setPointerCapture: () => {} };
    const before = { left: root().props.style.left, top: root().props.style.top };
    act(() =>
      bar().props.onPointerDown({
        button: 0,
        pointerId: 1,
        clientX: before.left + 50,
        clientY: before.top + 10,
        target: { closest: () => null },
        currentTarget: capture,
      }),
    );
    act(() =>
      bar().props.onPointerMove({
        pointerId: 1,
        clientX: before.left + 10,
        clientY: before.top + 40,
      }),
    );
    act(() => bar().props.onPointerUp({ pointerId: 1 }));
    expect(root().props.style.left).toBe(before.left - 40);
    expect(root().props.style.top).toBe(before.top + 30);

    const at = { left: root().props.style.left, top: root().props.style.top };
    act(() =>
      bar().props.onPointerDown({
        button: 0,
        pointerId: 2,
        clientX: at.left + 5,
        clientY: at.top + 5,
        target: { closest: (sel: string) => (sel.includes("button") ? {} : null) },
        currentTarget: capture,
      }),
    );
    act(() =>
      bar().props.onPointerMove({ pointerId: 2, clientX: at.left + 200, clientY: at.top + 200 }),
    );
    expect(root().props.style.left).toBe(at.left);
  });

  it("forwards merge and the merged flag", async () => {
    const onMerge = vi.fn(async () => "ok");
    paneProps.length = 0;
    act(() => {
      create(
        <WorkerFloatingWindow
          threadRef={threadRef}
          worker={worker}
          onClose={() => {}}
          onKill={() => {}}
          onSteer={async () => {}}
          onMerge={onMerge}
          merged
        />,
      );
    });
    expect(lastPane().merged).toBe(true);
    await (lastPane().onMerge as () => Promise<unknown>)();
    expect(onMerge).toHaveBeenCalledTimes(1);
  });

  it("renders through a portal targeting document.body", () => {
    portalCalls.length = 0;
    renderWindow();
    expect(portalCalls).toEqual([bodyMarker]);
  });
});
