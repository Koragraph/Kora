import { beforeEach, describe, expect, test } from "vite-plus/test";

import {
  acquireBrowserSurface,
  acquireBrowserSurfaceActivity,
  resolveBrowserSurfacePanelRect,
  usePreviewDockStore,
  type BrowserSurfaceContentPresentation,
  type BrowserSurfacePresentation,
} from "./browserSurfaceStore";

const store = () => usePreviewDockStore.getState();
const entry = (tab: string) => store().byTabId[tab];

const content = (
  width: number,
  height: number,
  extra: Partial<BrowserSurfaceContentPresentation> = {},
): BrowserSurfaceContentPresentation => ({
  x: 0,
  y: 0,
  width,
  height,
  scale: 1,
  scrollLeft: 0,
  scrollTop: 0,
  ...extra,
});

const RECT_A = { x: 0, y: 0, width: 500, height: 700 };
const RECT_B = { x: 10, y: 20, width: 900, height: 640 };

beforeEach(() => {
  usePreviewDockStore.setState({ activityByTabId: {}, byTabId: {} });
});

describe("surface leases", () => {
  test("the lease's layer and visibility reach the store", () => {
    const lease = acquireBrowserSurface("t-layer");
    expect(lease.present({ x: 1, y: 2, width: 30, height: 40 }, true, 8, 55)).toBe(true);
    expect(entry("t-layer")).toMatchObject({ zIndex: 55, visible: true, cornerRadius: 8 });
  });

  test("releasing hides the surface, keeps its rect, and later present calls are refused", () => {
    const lease = acquireBrowserSurface("t-release");
    lease.present(RECT_B, true);
    lease.release();
    expect(lease.present({ x: 0, y: 0, width: 1, height: 1 }, true)).toBe(false);
    expect(entry("t-release")).toMatchObject({ owner: null, visible: false, rect: RECT_B });
  });

  test("releasing twice is harmless", () => {
    const lease = acquireBrowserSurface("t-twice");
    lease.release();
    expect(() => lease.release()).not.toThrow();
  });

  test("a newer lease supersedes an older one entirely", () => {
    const older = acquireBrowserSurface("t-steal");
    older.present(RECT_A, true);
    const newer = acquireBrowserSurface("t-steal");
    newer.present(RECT_B, true);

    expect(older.present(RECT_A, true)).toBe(false);
    older.release();
    expect(entry("t-steal")).toMatchObject({ visible: true, rect: RECT_B });
  });

  test("an identical present call does not touch the entry", () => {
    const lease = acquireBrowserSurface("t-same");
    lease.present(RECT_B, true, 4, 31);
    const before = entry("t-same");
    lease.present({ ...RECT_B }, true, 4, 31);
    expect(entry("t-same")).toBe(before);
  });
});

describe("fitted content", () => {
  test("the first measured content is frozen once fitting is requested", () => {
    const lease = acquireBrowserSurface("t-fit-late", true);
    const source = content(1280, 720);
    store().presentContent("t-fit-late", source);
    store().presentContent("t-fit-late", content(320, 180, { scale: 0.25 }));

    expect(entry("t-fit-late")?.fittedSourceContent).toEqual(source);
    expect(entry("t-fit-late")?.content).toMatchObject({ width: 320 });
    lease.release();
  });

  test("content already known when a fitted lease arrives becomes the frozen source", () => {
    const source = content(1280, 720, { x: 10, y: 20 });
    store().claim("t-fit-claim", Symbol("plain"), false);
    store().presentContent("t-fit-claim", source);

    const lease = acquireBrowserSurface("t-fit-claim", true);
    store().presentContent("t-fit-claim", content(360, 203, { scale: 0.28125 }));

    expect(entry("t-fit-claim")?.fittedSourceContent).toEqual(source);
    lease.release();
  });

  test("releasing a fitted lease clears the fit state", () => {
    const lease = acquireBrowserSurface("t-fit-free", true);
    store().presentContent("t-fit-free", content(1280, 800));
    lease.release();
    expect(entry("t-fit-free")).toMatchObject({
      owner: null,
      visible: false,
      fitSourceContent: false,
      fittedSourceContent: null,
    });
  });

  test("content for a tab nobody has leased is tracked without making it visible", () => {
    store().presentContent("t-unseen", content(393, 852));
    expect(entry("t-unseen")).toMatchObject({
      content: { width: 393, height: 852 },
      visible: false,
      rect: null,
    });
  });

  test("identical content is not re-stored", () => {
    store().presentContent("t-dupe", content(10, 10));
    const before = entry("t-dupe");
    store().presentContent("t-dupe", content(10, 10));
    expect(entry("t-dupe")).toBe(before);
  });
});

describe("resolveBrowserSurfacePanelRect", () => {
  const presentation = (over: Partial<BrowserSurfacePresentation>): BrowserSurfacePresentation => ({
    owner: null,
    updatedAt: 0,
    cornerRadius: 0,
    fitSourceContent: false,
    fittedSourceContent: null,
    content: null,
    zIndex: 30,
    visible: false,
    rect: null,
    ...over,
  });

  test("a hidden tab reports its own last rect, not the active tab's", () => {
    const tabs = {
      active: presentation({ visible: true, rect: RECT_B, updatedAt: 2 }),
      hidden: presentation({ rect: RECT_A, updatedAt: 1 }),
    };
    expect(resolveBrowserSurfacePanelRect(tabs, "hidden")).toEqual(RECT_A);
  });

  test("an unknown tab has no rect", () => {
    expect(resolveBrowserSurfacePanelRect({}, "nope")).toBeNull();
  });
});

describe("background activity counting", () => {
  test("the tab stays active until the last holder lets go", () => {
    const releaseA = acquireBrowserSurfaceActivity("bg");
    const releaseB = acquireBrowserSurfaceActivity("bg");

    releaseA();
    expect(store().activityByTabId["bg"]).toBe(1);
    releaseB();
    expect(store().activityByTabId["bg"]).toBeUndefined();
  });

  test("releasing the same handle twice does not undercount the other holder", () => {
    const first = acquireBrowserSurfaceActivity("bg2");
    acquireBrowserSurfaceActivity("bg2");
    first();
    first();
    expect(store().activityByTabId["bg2"]).toBe(1);
  });
});
