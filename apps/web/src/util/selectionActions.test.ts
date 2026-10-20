import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  SELECTION_MULTI_CLICK_INTERVAL_MS,
  observeSelectionActions,
  resolveSelectionActionPosition,
} from "./selectionActions";

type Position = { x: number; y: number };

function createDomHarness({ withActionElement = false } = {}) {
  const queuedFrames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 0;

  const windowTarget = Object.assign(new EventTarget(), {
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      const id = ++nextFrameId;
      queuedFrames.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      queuedFrames.delete(id);
    },
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });

  const docTarget = Object.assign(new EventTarget(), {
    defaultView: windowTarget,
    activeElement: null as EventTarget | null,
  });

  const containerElement = Object.assign(new EventTarget(), {
    ownerDocument: docTarget,
    contains: (node: unknown) => node === containerElement,
  });

  const actionInput = new EventTarget();
  const popoverElement = Object.assign(new EventTarget(), {
    contains: (node: unknown) => node === popoverElement || node === actionInput,
  });

  const onSelection = vi.fn<(ptr: Position | null) => void>();
  const onDismiss = vi.fn();

  const controller = observeSelectionActions({
    element: containerElement as unknown as HTMLElement,
    ...(withActionElement
      ? { getActionElement: () => popoverElement as unknown as HTMLElement }
      : {}),
    onSelection,
    onDismiss,
  });

  docTarget.addEventListener("selectionchange", controller.selectionChanged);

  const runFrames = () => {
    const pending = [...queuedFrames.values()];
    queuedFrames.clear();
    for (const frame of pending) {
      frame(performance.now());
    }
  };

  const advance = (ms = 0) => {
    if (ms > 0) vi.advanceTimersByTime(ms);
    else vi.advanceTimersByTime(0);
    runFrames();
  };

  const fire = (
    target: EventTarget,
    name: string,
    properties: Record<string, unknown> = {},
    cancelable = true,
  ) => {
    const { target: explicitTarget, ...restProps } = properties;
    const evt = Object.assign(new Event(name, { cancelable }), restProps);
    Object.defineProperty(evt, "target", {
      value: explicitTarget ?? target,
      configurable: true,
    });
    target.dispatchEvent(evt);
    return evt;
  };

  const pointerPress = ({
    target = containerElement as EventTarget,
    button = 0,
    isPrimary = true,
    preventDefault = false,
  } = {}) => {
    const press = Object.assign(new Event("pointerdown", { cancelable: true }), {
      button,
      isPrimary,
    });
    if (preventDefault) press.preventDefault();
    Object.defineProperty(press, "target", { value: target, configurable: true });
    docTarget.dispatchEvent(press);
    if (target === containerElement) {
      containerElement.dispatchEvent(press);
    }
  };

  const pointerRelease = (button = 0) => {
    windowTarget.dispatchEvent(
      Object.assign(new Event("pointerup", { cancelable: true }), {
        button,
        isPrimary: true,
      }),
    );
  };

  const mouseRelease = ({
    x = 250,
    y = 120,
    button = 0,
    detail = 1,
  }: {
    x?: number;
    y?: number;
    button?: number;
    detail?: number;
  } = {}) => {
    pointerRelease(button);
    windowTarget.dispatchEvent(
      Object.assign(new Event("mouseup", { cancelable: true }), {
        clientX: x,
        clientY: y,
        button,
        detail,
      }),
    );
  };

  return {
    windowTarget,
    docTarget,
    containerElement,
    popoverElement,
    actionInput,
    controller,
    onSelection,
    onDismiss,
    advance,
    runFrames,
    fire,
    pointerPress,
    pointerRelease,
    mouseRelease,
    notifySelectionChange: () => docTarget.dispatchEvent(new Event("selectionchange")),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  return () => {
    vi.useRealTimers();
  };
});

describe("resolveSelectionActionPosition", () => {
  const bounds = { left: 80, top: 40, width: 600, height: 300 };
  const viewport = { width: 1280, height: 800 };

  it("prioritizes exact pointer coordinates over text bounding box", () => {
    const pos = resolveSelectionActionPosition({
      viewport,
      bounds,
      pointer: { x: 320, y: 180 },
      selectionRect: { right: 500, bottom: 220 },
    });
    expect(pos).toEqual({ x: 320, y: 180 });
  });

  it("falls back to bottom-right of selection when pointer is null", () => {
    const pos = resolveSelectionActionPosition({
      viewport,
      bounds,
      pointer: null,
      selectionRect: { right: 280, bottom: 150 },
    });
    expect(pos).toEqual({ x: 280, y: 154 });
  });

  it("calculates fallback offset relative to bounds when selection rect is absent", () => {
    const pos = resolveSelectionActionPosition({
      viewport,
      bounds,
      pointer: null,
      selectionRect: null,
    });
    // preferred x: 80 + 600 - 140 = 540, preferred y: 40 + 12 = 52
    expect(pos).toEqual({ x: 540, y: 52 });
  });

  it("clamps coordinates within both boundary rectangle and viewport margins", () => {
    const outsideTopLeft = resolveSelectionActionPosition({
      viewport,
      bounds,
      pointer: { x: 10, y: 10 },
      selectionRect: null,
    });
    expect(outsideTopLeft).toEqual({ x: 80, y: 40 });

    const outsideBottomRight = resolveSelectionActionPosition({
      viewport,
      bounds,
      pointer: { x: 9999, y: 9999 },
      selectionRect: null,
    });
    expect(outsideBottomRight).toEqual({ x: 680, y: 340 });
  });

  it("respects minimal viewport margins when bounds exceed viewport limits", () => {
    const overflowingBounds = { left: -50, top: -20, width: 2000, height: 1000 };
    const clampedPos = resolveSelectionActionPosition({
      viewport: { width: 400, height: 300 },
      bounds: overflowingBounds,
      pointer: { x: -30, y: -10 },
      selectionRect: null,
    });
    expect(clampedPos).toEqual({ x: 8, y: 8 });
  });
});

describe("observeSelectionActions - interactions and dismissals", () => {
  it("dismisses with interaction reason when pressing inside container", () => {
    const env = createDomHarness();
    env.pointerPress();
    expect(env.onDismiss).toHaveBeenCalledWith("interaction");
  });

  it("dismisses with cancel reason when clicking outside open popover", () => {
    const env = createDomHarness({ withActionElement: true });
    env.pointerPress({ target: env.docTarget });
    expect(env.onDismiss).toHaveBeenCalledWith("cancel");
  });

  it("retains selection and avoids dismissal when interacting inside action element", () => {
    const env = createDomHarness({ withActionElement: true });
    env.pointerPress({ target: env.popoverElement });
    expect(env.onDismiss).not.toHaveBeenCalled();
    expect(env.controller.pending).toBe(false);
  });

  it("prevents text capture from altering actions while editing inside popover input", () => {
    const env = createDomHarness({ withActionElement: true });
    // First establish an open selection
    env.pointerPress();
    env.mouseRelease({ x: 100, y: 100 });
    env.advance();
    expect(env.onSelection).toHaveBeenCalledTimes(1);

    // Focus and select within the popover input
    env.onDismiss.mockClear();
    env.docTarget.activeElement = env.actionInput;
    env.pointerPress({ target: env.actionInput });
    env.notifySelectionChange();
    env.advance(100);

    expect(env.onDismiss).not.toHaveBeenCalled();
    expect(env.onSelection).toHaveBeenCalledTimes(1);
  });

  it("dismisses upon losing focus to an external element", () => {
    const env = createDomHarness({ withActionElement: true });
    const externalNode = new EventTarget();
    env.docTarget.activeElement = externalNode;
    env.fire(env.docTarget, "focusin", { target: externalNode });
    expect(env.onDismiss).toHaveBeenCalledWith("cancel");
  });

  it("cancels pending schedule when focus moves into action popover", () => {
    const env = createDomHarness({ withActionElement: true });
    env.pointerPress();
    env.mouseRelease({ detail: 2 });
    expect(env.controller.pending).toBe(true);

    env.docTarget.activeElement = env.popoverElement;
    env.fire(env.docTarget, "focusin", { target: env.popoverElement });
    expect(env.controller.pending).toBe(false);

    env.advance(SELECTION_MULTI_CLICK_INTERVAL_MS + 50);
    expect(env.onSelection).not.toHaveBeenCalled();
  });
});

describe("observeSelectionActions - gesture timing and lifecycle", () => {
  it("schedules immediately on single click and emits position", () => {
    const env = createDomHarness();
    env.pointerPress();
    env.mouseRelease({ x: 210, y: 150, detail: 1 });
    expect(env.controller.pending).toBe(true);

    env.advance(0);
    expect(env.onSelection).toHaveBeenCalledWith({ x: 210, y: 150 });
  });

  it("defers multi-click gestures by multi-click interval", () => {
    const env = createDomHarness();
    env.pointerPress();
    env.mouseRelease({ x: 300, y: 180, detail: 2 });

    env.advance(SELECTION_MULTI_CLICK_INTERVAL_MS - 20);
    expect(env.onSelection).not.toHaveBeenCalled();

    env.advance(25);
    expect(env.onSelection).toHaveBeenCalledWith({ x: 300, y: 180 });
  });

  it("cancels previous schedule when a new press arrives before interval elapses", () => {
    const env = createDomHarness();
    env.pointerPress();
    env.mouseRelease({ detail: 2 });
    expect(env.controller.pending).toBe(true);

    env.pointerPress();
    expect(env.controller.pending).toBe(false);

    env.advance(SELECTION_MULTI_CLICK_INTERVAL_MS);
    expect(env.onSelection).not.toHaveBeenCalled();
  });

  it("handles successive clicks by resolving to the final click position", () => {
    const env = createDomHarness();
    env.pointerPress();
    env.mouseRelease({ detail: 2, x: 120, y: 80 });
    env.advance(200);

    env.pointerPress();
    env.mouseRelease({ detail: 3, x: 240, y: 160 });
    env.advance(SELECTION_MULTI_CLICK_INTERVAL_MS - 10);
    expect(env.onSelection).not.toHaveBeenCalled();

    env.advance(20);
    expect(env.onSelection).toHaveBeenCalledTimes(1);
    expect(env.onSelection).toHaveBeenCalledWith({ x: 240, y: 160 });
  });

  it("ignores non-primary pointer presses", () => {
    const env = createDomHarness();
    env.pointerPress({ isPrimary: false });
    env.mouseRelease();
    env.advance(10);
    expect(env.onSelection).not.toHaveBeenCalled();
  });

  it("ignores non-primary mouse buttons while preserving primary drag state", () => {
    const env = createDomHarness();
    env.pointerPress({ button: 0 });
    env.mouseRelease({ button: 1 });
    env.advance(10);
    expect(env.onSelection).not.toHaveBeenCalled();

    env.mouseRelease({ button: 0, x: 190, y: 95 });
    env.advance(0);
    expect(env.onSelection).toHaveBeenCalledWith({ x: 190, y: 95 });
  });

  it("ignores gesture when event was consumed or default prevented", () => {
    const env = createDomHarness();
    env.pointerPress({ preventDefault: true });
    env.mouseRelease();
    env.advance(10);
    expect(env.onSelection).not.toHaveBeenCalled();
  });

  it("disallows gesture initiation when press originated outside surface", () => {
    const env = createDomHarness();
    env.pointerPress({ target: env.docTarget });
    env.mouseRelease({ x: 400, y: 300 });
    env.advance(10);
    expect(env.onSelection).not.toHaveBeenCalled();
  });

  it("allows cursor release outside the bounds if the drag originated inside", () => {
    const env = createDomHarness();
    env.pointerPress();
    env.mouseRelease({ x: 1500, y: -50 });
    env.advance(0);
    expect(env.onSelection).toHaveBeenCalledWith({ x: 1500, y: -50 });
  });

  it("triggers keyboard selection with null point after keydown and selection change", () => {
    const env = createDomHarness();
    env.fire(env.docTarget, "keydown", { key: "ArrowRight" });
    env.notifySelectionChange();
    env.advance(0);
    expect(env.onSelection).toHaveBeenCalledWith(null);
  });

  it("suppresses keyboard selection during an active pointer drag", () => {
    const env = createDomHarness();
    env.pointerPress();
    env.fire(env.docTarget, "keydown", { key: "ArrowDown" });
    env.notifySelectionChange();
    expect(env.onDismiss).toHaveBeenCalledWith("cancel");
    env.advance(10);
    expect(env.onSelection).not.toHaveBeenCalled();
  });

  it("preserves drag eligibility across container autoscroll events", () => {
    const env = createDomHarness();
    env.pointerPress();
    env.fire(env.containerElement, "scroll");
    expect(env.onDismiss).toHaveBeenCalledWith("cancel");

    env.mouseRelease({ x: 330, y: 220 });
    env.advance(0);
    expect(env.onSelection).toHaveBeenCalledWith({ x: 330, y: 220 });
  });

  it.each(["pointercancel", "blur", "resize"] as const)(
    "cancels pending selection on window %s event",
    (evtType) => {
      const env = createDomHarness();
      env.pointerPress();
      env.mouseRelease({ detail: 2 });
      expect(env.controller.pending).toBe(true);

      env.fire(env.windowTarget, evtType);
      expect(env.onDismiss).toHaveBeenCalledWith("cancel");
      expect(env.controller.pending).toBe(false);

      env.advance(SELECTION_MULTI_CLICK_INTERVAL_MS);
      expect(env.onSelection).not.toHaveBeenCalled();
    },
  );

  it("cancels and reports interaction when contextmenu fires on container", () => {
    const env = createDomHarness();
    env.pointerPress();
    env.mouseRelease({ detail: 2 });

    env.fire(env.containerElement, "contextmenu");
    expect(env.onDismiss).toHaveBeenCalledWith("interaction");
    expect(env.controller.pending).toBe(false);

    env.advance(SELECTION_MULTI_CLICK_INTERVAL_MS);
    expect(env.onSelection).not.toHaveBeenCalled();
  });

  it("cleans up all listeners and timers on dispose", () => {
    const env = createDomHarness();
    env.pointerPress();
    env.mouseRelease({ detail: 2 });
    expect(env.controller.pending).toBe(true);

    env.controller.dispose();
    expect(env.controller.pending).toBe(false);

    env.pointerPress();
    env.mouseRelease();
    env.advance(100);
    expect(env.onSelection).not.toHaveBeenCalled();
  });
});
