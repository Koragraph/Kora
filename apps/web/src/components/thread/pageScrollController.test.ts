import { describe, expect, it } from "vite-plus/test";

import * as Paging from "./pageScrollController";

const { createPageScrollController, getTranscriptPageScrollKey } = Paging;
const { PAGE_SCROLL_ANIMATION_MS: ANIMATION, PAGE_SCROLL_ACCELERATION_MS: RAMP } = Paging;

/** A fake clock driving timers and animation frames together, one 16ms frame at a time. */
function makeClock() {
  let now = 0;
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { due: number; run: () => void }>();

  const runDueTimers = () => {
    for (let fired = true; fired;) {
      fired = false;
      for (const [id, timer] of [...timers]) {
        if (timer.due > now) continue;
        timers.delete(id);
        timer.run();
        fired = true;
      }
    }
  };
  const runFrames = () => {
    const due = [...frames.values()];
    frames.clear();
    for (const run of due) run(now);
  };

  return {
    env: {
      now: () => now,
      requestAnimationFrame: (run: FrameRequestCallback) => (frames.set(++nextId, run), nextId),
      cancelAnimationFrame: (id: number) => void frames.delete(id),
      setTimeout: (run: () => void, delay: number) => (
        timers.set(++nextId, { due: now + delay, run }),
        nextId
      ),
      clearTimeout: (id: number) => void timers.delete(id),
    },
    advance(ms: number) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + 16);
        runDueTimers();
        runFrames();
      }
    },
  };
}

/** A 600px-tall transcript of `total` px, scrolled to `top`, with 24px of bottom padding. */
function setUp(top: number, total = 1_800) {
  const clock = makeClock();
  // Like a real element, the scroll position clamps to the scrollable range.
  let position = top;
  const box = {
    scrollHeight: total,
    clientHeight: 600,
    getBoundingClientRect: () => ({ height: 600 }),
    get scrollTop() {
      return position;
    },
    set scrollTop(next: number) {
      position = Math.min(Math.max(next, 0), total - 600);
    },
  };
  const started: string[] = [];
  const controller = createPageScrollController({
    env: clock.env,
    getContainer: () => box,
    getScrollPaddingBottomPx: () => 24,
    onScrollStart: (key) => started.push(key),
  });
  return { clock, box, started, controller };
}

// A page is the viewport less the 36px alignment gap and the bottom padding.
const PAGE = 600 - 36 - 24;

describe("createPageScrollController", () => {
  it("pages once on a tap, with an eased animation that lands exactly", () => {
    const { clock, box, controller } = setUp(0);
    controller.handleKeyDown("PageDown");
    controller.handleKeyUp("PageDown");
    clock.advance(ANIMATION / 2);
    expect(box.scrollTop).toBeGreaterThan(0);
    expect(box.scrollTop).toBeLessThan(PAGE);
    clock.advance(ANIMATION);
    expect(box.scrollTop).toBeCloseTo(PAGE, 5);
  });

  it("ignores a key that would move past either end", () => {
    const top = setUp(0.5);
    top.controller.handleKeyDown("PageUp");
    top.clock.advance(ANIMATION * 2);
    expect(top.started).toEqual([]);
    expect(top.box.scrollTop).toBe(0.5);

    const bottom = setUp(1_199.5);
    bottom.controller.handleKeyDown("PageDown");
    bottom.clock.advance(ANIMATION * 2);
    expect(bottom.started).toEqual([]);
    expect(bottom.box.scrollTop).toBe(1_199.5);
  });

  it("announces a scroll once, however often the key repeats", () => {
    const { started, controller } = setUp(900);
    for (let n = 0; n < 3; n += 1) controller.handleKeyDown("PageUp");
    expect(started).toEqual(["PageUp"]);
  });

  it("keeps scrolling while the key is held and stops when it is released", () => {
    const { clock, box, controller } = setUp(0, 6_000);
    controller.handleKeyDown("PageDown");
    clock.advance(ANIMATION + 48);
    const holding = box.scrollTop;
    clock.advance(160);
    expect(box.scrollTop).toBeGreaterThan(holding);

    controller.handleKeyUp("PageDown");
    const released = box.scrollTop;
    clock.advance(300);
    expect(box.scrollTop).toBe(released);
  });

  it("stops holding once the end is reached", () => {
    const { clock, box, controller } = setUp(0, 1_400);
    controller.handleKeyDown("PageDown");
    clock.advance(2_000);
    const atEnd = box.scrollTop;
    clock.advance(200);
    expect(box.scrollTop).toBe(atEnd);
  });

  it("does nothing after disposal or for a release of another key", () => {
    const { clock, box, controller } = setUp(0, 6_000);
    controller.handleKeyDown("PageDown");
    controller.handleKeyUp("PageUp");
    controller.dispose();
    clock.advance(ANIMATION * 3);
    expect(box.scrollTop).toBe(0);
    controller.releaseActiveKey();
  });
});

describe("page scroll speed", () => {
  it("ramps from one to two pages per animation over the acceleration window", () => {
    expect(Paging.getPageScrollMultiplier(-50)).toBe(1);
    expect(Paging.getPageScrollMultiplier(RAMP / 4)).toBeCloseTo(1.25);
    expect(Paging.getPageScrollMultiplier(RAMP * 9)).toBe(Paging.PAGE_SCROLL_MAX_MULTIPLIER);
  });

  it("turns a page into a speed in px per ms", () => {
    const speed = (holdElapsedMs: number) =>
      Paging.getPageScrollVelocityPxPerMs({ holdElapsedMs, pageScrollDistancePx: 300 });
    expect(speed(0)).toBeCloseTo(300 / ANIMATION);
    expect(speed(RAMP)).toBeCloseTo((2 * 300) / ANIMATION);
  });

  it("never pages a negative distance", () => {
    expect(
      Paging.getPageScrollDistancePx({ containerHeightPx: 40, scrollPaddingBottomPx: 30 }),
    ).toBe(0);
    expect(
      Paging.getPageScrollDistancePx({ containerHeightPx: 600, scrollPaddingBottomPx: 24 }),
    ).toBe(PAGE);
  });
});

describe("getTranscriptPageScrollKey", () => {
  /** A key press in a composer of `height` px content inside a 200px box, scrolled to `top`. */
  const press = (key: string, top: number, height = 600, extra: Record<string, unknown> = {}) =>
    getTranscriptPageScrollKey({
      key,
      keyCode: key === "PageUp" ? 33 : 34,
      scrollTop: top,
      scrollHeight: height,
      clientHeight: 200,
      ...{ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
      ...{ defaultPrevented: false, isComposing: false },
      ...extra,
    });

  it("leaves paging to a composer that can still scroll that way", () => {
    expect(press("PageDown", 0)).toBeNull();
    expect(press("PageUp", 400)).toBeNull();
  });

  it("takes over once the composer is at (or within a pixel of) that edge", () => {
    expect(press("PageUp", 0)).toBe("PageUp");
    expect(press("PageUp", 0.5)).toBe("PageUp");
    expect(press("PageDown", 400)).toBe("PageDown");
    expect(press("PageDown", 399.5)).toBe("PageDown");
    expect(press("PageDown", 0, 200)).toBe("PageDown");
  });

  it.each([
    ["another key", "ArrowDown", {}],
    ["a modifier", "PageDown", { shiftKey: true }],
    ["a handled event", "PageDown", { defaultPrevented: true }],
    ["IME composition", "PageDown", { isComposing: true }],
    ["the IME key code", "PageDown", { keyCode: 229 }],
  ])("ignores %s", (_case, key, extra) => {
    expect(press(key, 400, 600, extra)).toBeNull();
  });
});
