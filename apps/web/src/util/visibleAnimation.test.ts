import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { watchVisibleAnimation } from "./visibleAnimation";

class FakeObserver {
  static all: FakeObserver[] = [];
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();
  constructor(private readonly onEntries: IntersectionObserverCallback) {
    FakeObserver.all.push(this);
  }
  emit(target: Element, isIntersecting: boolean) {
    this.onEntries(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

const reducedMotion = Object.assign(new EventTarget(), { matches: false });
const documentStub = Object.assign(new EventTarget(), { visibilityState: "visible" });
const detachers: Array<() => void> = [];

/** An element that only records the CSS custom properties written to it. */
function probe() {
  const css = new Map<string, string>();
  const el = {
    style: { setProperty: (k: string, v: string) => void css.set(k, v) },
  } as unknown as HTMLElement;
  return {
    el,
    state: () => css.get("--visible-animation-state"),
    hint: () => css.get("--visible-animation-will-change"),
  };
}

function track(el: HTMLElement) {
  const detach = watchVisibleAnimation(el);
  if (detach) detachers.push(detach);
  return detach;
}

function setReducedMotion(on: boolean) {
  reducedMotion.matches = on;
  reducedMotion.dispatchEvent(new Event("change"));
}

beforeEach(() => {
  FakeObserver.all = [];
  detachers.length = 0;
  reducedMotion.matches = false;
  documentStub.visibilityState = "visible";
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("window", { matchMedia: () => reducedMotion });
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});

afterEach(() => {
  detachers.forEach((d) => d());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("watchVisibleAnimation", () => {
  test("a null element is a no-op", () => {
    expect(watchVisibleAnimation(null)).toBeUndefined();
    expect(FakeObserver.all).toHaveLength(0);
  });

  test("starts running immediately and ignores document visibility", () => {
    documentStub.visibilityState = "hidden";
    const a = probe();
    track(a.el);
    expect([a.state(), a.hint()]).toEqual(["running", "transform"]);
  });

  test("without IntersectionObserver it runs unless motion is reduced", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const plain = probe();
    track(plain.el);
    expect(plain.state()).toBe("running");
    expect(FakeObserver.all).toHaveLength(0);

    reducedMotion.matches = true;
    const calm = probe();
    track(calm.el);
    expect(calm.state()).toBe("paused");
  });

  test("leaving the viewport pauses only that element; reduced motion pauses all; both must clear", () => {
    const a = probe();
    const b = probe();
    track(a.el);
    track(b.el);
    const [shared] = FakeObserver.all;
    expect(FakeObserver.all).toHaveLength(1);

    shared!.emit(a.el, false);
    expect([a.state(), a.hint(), b.state()]).toEqual(["paused", "auto", "running"]);

    setReducedMotion(true);
    expect(b.state()).toBe("paused");

    setReducedMotion(false);
    expect([a.state(), b.state()]).toEqual(["paused", "running"]);

    shared!.emit(a.el, true);
    expect(a.state()).toBe("running");
  });

  test("one shared observer lives until the last element detaches; stale callbacks are ignored", () => {
    const addListener = vi.spyOn(reducedMotion, "addEventListener");
    const removeListener = vi.spyOn(reducedMotion, "removeEventListener");
    const a = probe();
    const b = probe();
    const detachA = track(a.el);
    const detachB = track(b.el);
    const first = FakeObserver.all[0]!;
    expect(FakeObserver.all).toHaveLength(1);
    expect(addListener).toHaveBeenCalledTimes(1);

    detachA?.();
    expect(a.state()).toBe("paused");
    first.emit(a.el, true);
    expect(a.state()).toBe("paused");
    expect(first.unobserve).toHaveBeenCalledWith(a.el);
    expect(first.disconnect).not.toHaveBeenCalled();

    detachB?.();
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);

    track(b.el);
    expect(FakeObserver.all).toHaveLength(2);
    first.emit(b.el, false);
    expect(b.state()).toBe("running");
  });

  test("the onChange hook hears every transition", () => {
    const calls: boolean[] = [];
    const el = probe();
    const detach = watchVisibleAnimation(el.el, (running) => calls.push(running));
    FakeObserver.all[0]!.emit(el.el, false);
    FakeObserver.all[0]!.emit(el.el, true);
    detach?.();
    expect(calls).toEqual([true, false, true, false]);
  });
});
