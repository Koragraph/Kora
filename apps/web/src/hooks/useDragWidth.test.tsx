import { act, useLayoutEffect, type PointerEvent } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useResizableWidth } from "./useDragWidth";

interface TestPanelProps {
  side?: "left" | "right";
  maxBound?: number;
  persistenceKey?: string;
}

let activeInstance: ReturnType<typeof useResizableWidth>;
let testRenderer: ReactTestRenderer;

let isPointerCaptured = false;
const pointerCaptureTarget = {
  hasPointerCapture: () => isPointerCaptured,
  releasePointerCapture: () => {
    isPointerCaptured = false;
  },
  setPointerCapture: () => {
    isPointerCaptured = true;
  },
};

const activeStyles: Record<string, string> = { cursor: "", "user-select": "" };
const fakeDocumentStyle = {
  get cursor() {
    return activeStyles["cursor"] ?? "";
  },
  set cursor(val: string) {
    activeStyles["cursor"] = val;
  },
  get userSelect() {
    return activeStyles["user-select"] ?? "";
  },
  set userSelect(val: string) {
    activeStyles["user-select"] = val;
  },
  removeProperty(propertyKey: string) {
    delete activeStyles[propertyKey];
  },
};

const memoryStore: Record<string, string> = {};
const storageSetSpy = vi.fn((k: string, v: string) => {
  memoryStore[k] = v;
});
const cancelRafSpy = vi.fn();
let windowEventBus: EventTarget;
let scheduledRafCallback: FrameRequestCallback | undefined;

function createPointerPayload(xPos = 100): PointerEvent<HTMLElement> {
  const noop = () => {};
  return {
    button: 0,
    clientX: xPos,
    currentTarget: pointerCaptureTarget,
    defaultPrevented: false,
    pointerId: 1,
    preventDefault: noop,
    stopPropagation: noop,
  } as unknown as PointerEvent<HTMLElement>;
}

function TestResizableComponent({
  side = "left",
  maxBound = 800,
  persistenceKey = "panel-width-pref",
}: TestPanelProps) {
  const hookResult = useResizableWidth({
    defaultWidth: 400,
    edge: side,
    maxWidth: maxBound,
    minWidth: 200,
    storageKey: persistenceKey,
  });

  useLayoutEffect(() => {
    activeInstance = hookResult;
  });

  return null;
}

beforeEach(async () => {
  for (const k of Object.keys(memoryStore)) {
    delete memoryStore[k];
  }
  isPointerCaptured = false;
  scheduledRafCallback = undefined;
  activeStyles["cursor"] = "";
  activeStyles["user-select"] = "";
  windowEventBus = new EventTarget();

  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    addEventListener: windowEventBus.addEventListener.bind(windowEventBus),
    localStorage: {
      getItem: (k: string) => memoryStore[k] ?? null,
      setItem: storageSetSpy,
    },
    removeEventListener: windowEventBus.removeEventListener.bind(windowEventBus),
  });
  vi.stubGlobal("document", { body: { style: fakeDocumentStyle } });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    scheduledRafCallback = cb;
    return 42;
  });
  vi.stubGlobal("cancelAnimationFrame", cancelRafSpy);

  await act(async () => {
    testRenderer = create(<TestResizableComponent />);
  });
});

afterEach(async () => {
  await act(async () => {
    testRenderer.unmount();
  });
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useResizableWidth persistence key transitions", () => {
  it("aborts active resizing gesture when storage key changes mid-drag", async () => {
    memoryStore["workspace-panel-b"] = "650";

    await act(async () => {
      activeInstance.handlers.onPointerDown(createPointerPayload(100));
      activeInstance.handlers.onPointerMove(createPointerPayload(50));
    });
    await act(async () => {
      scheduledRafCallback?.(0);
    });

    expect(activeInstance.width).toBe(450);

    await act(async () => {
      activeInstance.handlers.onPointerMove(createPointerPayload(25));
    });

    await act(async () => {
      testRenderer.update(<TestResizableComponent persistenceKey="workspace-panel-b" />);
    });

    expect(activeInstance.width).toBe(650);
    expect(isPointerCaptured).toBe(false);
    expect(fakeDocumentStyle.cursor).toBe("");

    await act(async () => {
      scheduledRafCallback?.(0);
      activeInstance.handlers.onPointerUp(createPointerPayload(25));
    });

    expect(activeInstance.width).toBe(650);
    expect(storageSetSpy).not.toHaveBeenCalled();

    await act(async () => {
      testRenderer.update(<TestResizableComponent />);
    });
    expect(activeInstance.width).toBe(400);
  });

  it("retains discrete panel widths across separate storage keys and unmount cycles", async () => {
    await act(async () => {
      activeInstance.handlers.onPointerDown(createPointerPayload(100));
      activeInstance.handlers.onPointerMove(createPointerPayload(50));
      activeInstance.handlers.onPointerUp(createPointerPayload(50));
    });
    expect(activeInstance.width).toBe(450);

    await act(async () => {
      testRenderer.update(<TestResizableComponent persistenceKey="panel-alt-scope" />);
    });
    expect(activeInstance.width).toBe(400);

    await act(async () => {
      activeInstance.handlers.onPointerDown(createPointerPayload(100));
      activeInstance.handlers.onPointerMove(createPointerPayload(-100));
      activeInstance.handlers.onPointerUp(createPointerPayload(-100));
    });
    expect(activeInstance.width).toBe(600);

    await act(async () => {
      testRenderer.update(<TestResizableComponent />);
    });
    expect(activeInstance.width).toBe(450);

    await act(async () => {
      testRenderer.unmount();
    });

    await act(async () => {
      testRenderer = create(<TestResizableComponent persistenceKey="panel-alt-scope" />);
    });
    expect(activeInstance.width).toBe(600);
  });
});

describe("useResizableWidth pointer gesture teardown and boundaries", () => {
  it("commits calculated width upon pointer release followed by loss of capture", async () => {
    await act(async () => {
      activeInstance.handlers.onPointerDown(createPointerPayload(100));
      activeInstance.handlers.onPointerMove(createPointerPayload(50));
      activeInstance.handlers.onPointerUp(createPointerPayload(50));
      activeInstance.handlers.onLostPointerCapture(createPointerPayload(50));
    });

    expect(activeInstance.width).toBe(450);
    expect(storageSetSpy).toHaveBeenCalledExactlyOnceWith("panel-width-pref", "450");
    expect(fakeDocumentStyle.cursor).toBe("");
    expect(isPointerCaptured).toBe(false);
  });

  it("constrains final dimension within maximum allowable threshold", async () => {
    await act(async () => {
      activeInstance.handlers.onPointerDown(createPointerPayload(100));
      activeInstance.handlers.onPointerUp(createPointerPayload(-1000));
    });

    expect(activeInstance.width).toBe(800);
    expect(storageSetSpy).toHaveBeenCalledExactlyOnceWith("panel-width-pref", "800");
  });

  it("handles instant pointer release without preceding move notifications", async () => {
    await act(async () => {
      activeInstance.handlers.onPointerDown(createPointerPayload(100));
      activeInstance.handlers.onPointerUp(createPointerPayload(25));
    });

    expect(activeInstance.width).toBe(475);
    expect(storageSetSpy).toHaveBeenCalledExactlyOnceWith("panel-width-pref", "475");
  });

  it.each([
    [800, 450],
    [450, 800],
  ])(
    "adapts to dynamic maximum boundary shifts during in-progress drag (%s -> %s)",
    async (fromMax, toMax) => {
      await act(async () => {
        testRenderer.update(<TestResizableComponent maxBound={fromMax} />);
      });

      await act(async () => {
        activeInstance.handlers.onPointerDown(createPointerPayload(100));
        activeInstance.handlers.onPointerMove(createPointerPayload(-200));
      });
      await act(async () => {
        scheduledRafCallback?.(0);
      });

      expect(activeInstance.width).toBe(Math.min(700, fromMax));

      await act(async () => {
        testRenderer.update(<TestResizableComponent maxBound={toMax} />);
      });
      await act(async () => {
        activeInstance.handlers.onPointerMove(createPointerPayload(-250));
      });
      await act(async () => {
        scheduledRafCallback?.(0);
      });

      expect(activeInstance.width).toBe(Math.min(750, toMax));

      await act(async () => {
        activeInstance.handlers.onPointerUp(createPointerPayload(-300));
      });
      expect(activeInstance.width).toBe(toMax);
      expect(storageSetSpy).toHaveBeenCalledExactlyOnceWith("panel-width-pref", String(toMax));
    },
  );

  it.each(["left", "right"] as const)(
    "applies pointer release offset on rapid %s-edge gesture",
    async (activeEdge) => {
      await act(async () => {
        testRenderer.update(<TestResizableComponent side={activeEdge} />);
      });

      await act(async () => {
        activeInstance.handlers.onPointerDown(createPointerPayload(100));
        activeInstance.handlers.onPointerMove(
          createPointerPayload(activeEdge === "left" ? 50 : 150),
        );
        activeInstance.handlers.onPointerUp(createPointerPayload(activeEdge === "left" ? 25 : 175));
      });

      expect(activeInstance.width).toBe(475);
      expect(storageSetSpy).toHaveBeenCalledExactlyOnceWith("panel-width-pref", "475");
      expect(cancelRafSpy).toHaveBeenCalledWith(42);
    },
  );

  it.each(["unmount", "lost capture", "blur", "cancel"])(
    "resets cursor styles and cancels scheduled animation frame on %s",
    async (triggerReason) => {
      await act(async () => {
        activeInstance.handlers.onPointerDown(createPointerPayload(100));
        activeInstance.handlers.onPointerMove(createPointerPayload(50));
      });
      await act(async () => {
        scheduledRafCallback?.(0);
      });

      expect(activeInstance.width).toBe(450);

      await act(async () => {
        activeInstance.handlers.onPointerMove(createPointerPayload(25));
      });

      expect(fakeDocumentStyle.cursor).toBe("col-resize");
      expect(fakeDocumentStyle.userSelect).toBe("none");

      await act(async () => {
        if (triggerReason === "unmount") {
          testRenderer.unmount();
        } else if (triggerReason === "lost capture") {
          activeInstance.handlers.onLostPointerCapture(createPointerPayload(100));
        } else if (triggerReason === "blur") {
          windowEventBus.dispatchEvent(new Event("blur"));
        } else if (triggerReason === "cancel") {
          activeInstance.handlers.onPointerCancel(createPointerPayload(100));
        }
      });

      expect(fakeDocumentStyle.cursor).toBe("");
      expect(fakeDocumentStyle.userSelect).toBe("");
      expect(isPointerCaptured).toBe(false);
      expect(cancelRafSpy).toHaveBeenCalledWith(42);

      if (triggerReason === "unmount") {
        expect(storageSetSpy).not.toHaveBeenCalled();
      } else {
        expect(activeInstance.width).toBe(475);
        expect(storageSetSpy).toHaveBeenCalledExactlyOnceWith("panel-width-pref", "475");
      }
    },
  );
});
