import { describe, expect, test } from "vite-plus/test";

import {
  browserViewportSettingKey,
  resizeBrowserViewportFromRail,
  resizeFreeformViewport,
  resolveBrowserDeviceViewportLayout,
  resolveBrowserViewportLayout,
  resolveFittedBrowserViewport,
  resolveResponsiveBrowserViewportSize,
} from "./browserViewportLayout";

const px = (width: number, height: number) => ({ width, height });
const free = (width: number, height: number) => ({ _tag: "freeform" as const, width, height });

describe("resolveBrowserViewportLayout", () => {
  test("fill mode uses the whole canvas unscaled", () => {
    expect(resolveBrowserViewportLayout(px(700, 500), { _tag: "fill" })).toEqual({
      fillsPanel: true,
      viewportScale: 1,
      viewportHeight: 500,
      viewportWidth: 700,
      viewportY: 0,
      viewportX: 0,
      canvasWidth: 700,
      canvasHeight: 500,
    });
  });

  test("a fixed viewport smaller than the canvas is centred and never enlarged", () => {
    expect(resolveBrowserViewportLayout(px(700, 1000), free(393, 852))).toMatchObject({
      viewportHeight: 852,
      viewportWidth: 393,
      viewportY: 74,
      viewportX: 154,
      viewportScale: 1,
    });
  });

  test("a fixed viewport larger than the canvas is scaled down to fit", () => {
    const layout = resolveBrowserViewportLayout(px(600, 700), free(1440, 900));
    expect(layout).toMatchObject({
      viewportHeight: 375,
      viewportWidth: 600,
      viewportY: 163,
      viewportX: 0,
      canvasWidth: 600,
      canvasHeight: 700,
    });
    expect(layout.viewportScale).toBeCloseTo(600 / 1440);
  });

  test("browser zoom enlarges the rendered footprint, not the CSS size", () => {
    expect(resolveBrowserViewportLayout(px(800, 700), free(400, 300), 1.5)).toMatchObject({
      viewportHeight: 450,
      viewportWidth: 600,
      viewportY: 125,
      viewportX: 100,
    });
  });

  test.each([0, -1, Number.NaN, Infinity])("a bogus zoom %s is treated as 1", (zoom) => {
    const base = resolveBrowserViewportLayout(px(800, 700), free(400, 300));
    expect(resolveBrowserViewportLayout(px(800, 700), free(400, 300), zoom)).toEqual(base);
  });

  test("a zero-sized container still yields a 1px canvas", () => {
    expect(resolveBrowserViewportLayout(px(0, 0), { _tag: "fill" })).toMatchObject({
      canvasWidth: 1,
      canvasHeight: 1,
    });
  });
});

describe("device toolbar layout", () => {
  test("leaves a 32px toolbar band on top and 10px rails on the sides", () => {
    expect(resolveBrowserDeviceViewportLayout(px(1200, 900), free(1180, 858))).toEqual({
      fillsPanel: false,
      viewportScale: 1,
      viewportHeight: 858,
      viewportWidth: 1180,
      viewportY: 32,
      viewportX: 10,
      canvasWidth: 1200,
      canvasHeight: 900,
    });
  });

  test("responsive size is the framed area, divided by zoom", () => {
    expect(resolveResponsiveBrowserViewportSize(px(1200, 900))).toEqual(px(1180, 858));
    expect(resolveResponsiveBrowserViewportSize(px(1200, 900), 2)).toEqual(px(590, 429));
  });
});

describe("resolveFittedBrowserViewport", () => {
  test("fill mode without a measured source falls back to 1280x800", () => {
    expect(resolveFittedBrowserViewport({ _tag: "fill" }, null)).toEqual(free(1280, 800));
  });

  test("fill mode derives CSS size from the source's rendered size, scale and zoom", () => {
    expect(
      resolveFittedBrowserViewport({ _tag: "fill" }, { width: 640, height: 400, scale: 0.5 }),
    ).toEqual(free(1280, 800));
    expect(
      resolveFittedBrowserViewport({ _tag: "fill" }, { width: 640, height: 400, scale: 0.5 }, 2),
    ).toEqual(free(640, 400));
  });

  test("a fixed setting wins over any stale source", () => {
    expect(
      resolveFittedBrowserViewport(free(900, 600), { width: 1280, height: 800, scale: 1 }),
    ).toEqual(free(900, 600));
  });
});

describe("resizeFreeformViewport", () => {
  const start = px(800, 600);

  test.each([
    ["west", { x: -100, y: 500 }, px(900, 600)],
    ["north", { x: 500, y: 100 }, px(800, 500)],
    ["northwest", { x: -100, y: -50 }, px(900, 650)],
    ["east", { x: 40, y: 999 }, px(840, 600)],
    ["south", { x: 999, y: 40 }, px(800, 640)],
  ] as const)("the %s edge only moves its own axes", (dir, delta, expected) => {
    expect(resizeFreeformViewport(start, delta, 1, dir)).toEqual(expected);
  });

  test("a locked ratio is kept whichever axis drives", () => {
    const ratio = 4 / 3;
    expect(resizeFreeformViewport(start, { x: 200, y: 0 }, 1, "east", ratio)).toEqual(
      px(1000, 750),
    );
    expect(resizeFreeformViewport(start, { x: 0, y: 150 }, 1, "south", ratio)).toEqual(
      px(1000, 750),
    );
  });

  test("a corner drag follows the axis that changed proportionally more", () => {
    const wide = resizeFreeformViewport(start, { x: 400, y: 10 }, 1, "southeast", 4 / 3);
    expect(wide.width).toBe(1200);
    const tall = resizeFreeformViewport(start, { x: 10, y: 300 }, 1, "southeast", 4 / 3);
    expect(tall.height).toBe(900);
  });

  test("dragging to nothing stops at the minimum size", () => {
    expect(resizeFreeformViewport(px(1024, 768), { x: -5000, y: -5000 })).toEqual(px(240, 240));
  });

  test("the total area is capped", () => {
    const grown = resizeFreeformViewport(px(1920, 1080), { x: 5000, y: 5000 });
    expect(grown.width * grown.height).toBeLessThanOrEqual(3840 * 2160);
  });

  test("pointer movement is divided by zoom", () => {
    expect(resizeFreeformViewport(px(400, 300), { x: 150, y: 75 }, 1.5)).toEqual(px(500, 350));
  });
});

describe("resizeBrowserViewportFromRail", () => {
  test("dragging the south-east rail inward on a viewport that fills the area", () => {
    expect(
      resizeBrowserViewportFromRail(
        px(1120, 818),
        { x: -100, y: -50 },
        px(1120, 818),
        1,
        "southeast",
      ),
    ).toEqual(px(920, 718));
  });

  test("dragging the east rail of a centred viewport moves the far edge by twice the pointer", () => {
    expect(
      resizeBrowserViewportFromRail(px(800, 600), { x: 300, y: 0 }, px(1200, 800), 1, "east"),
    ).toEqual(px(1300, 600));
  });

  test("the pointer-to-size mapping accounts for zoom", () => {
    expect(
      resizeBrowserViewportFromRail(px(560, 409), { x: -100, y: 0 }, px(1120, 818), 2, "east"),
    ).toEqual(px(460, 409));
  });
});

describe("browserViewportSettingKey", () => {
  test("distinct settings produce distinct keys", () => {
    const keys = [
      browserViewportSettingKey({ _tag: "fill" }),
      browserViewportSettingKey(free(1, 2)),
      browserViewportSettingKey(free(2, 1)),
      browserViewportSettingKey({ _tag: "preset", width: 1, height: 2, presetId: "p" } as never),
    ];
    expect(new Set(keys).size).toBe(4);
    expect(keys[0]).toBe("fill");
  });
});
