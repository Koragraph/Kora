import { describe, expect, it } from "vite-plus/test";

import { WEB_VIEWPORT_PRESETS, resolveWebViewport } from "./webViewport.ts";

const PHONE = "iphone-12-pro";

describe("web viewport resolution", () => {
  it("passes fill through and keeps freeform sizes exact", () => {
    expect(resolveWebViewport({ mode: "fill" })).toEqual({ _tag: "fill" });
    expect(resolveWebViewport({ mode: "freeform", width: 1280, height: 720 })).toEqual({
      _tag: "freeform",
      height: 720,
      width: 1280,
    });
  });

  it("uses a preset's size upright and swaps it for landscape", () => {
    const portrait = resolveWebViewport({ mode: "preset", preset: PHONE });
    const landscape = resolveWebViewport({
      mode: "preset",
      preset: PHONE,
      orientation: "landscape",
    });
    expect(portrait).toEqual({ _tag: "preset", presetId: PHONE, width: 390, height: 844 });
    expect(landscape).toEqual({ _tag: "preset", presetId: PHONE, width: 844, height: 390 });
  });

  it("lists presets in the order of Chrome's device toolbar", () => {
    const catalog =
      "iPhone SE | iPhone XR | iPhone 12 Pro | iPhone 14 Pro Max | Pixel 7 | Samsung Galaxy S8+ | " +
      "Samsung Galaxy S20 Ultra | iPad Mini | iPad Air | iPad Pro | Surface Pro 7 | Surface Duo | " +
      "Galaxy Z Fold 5 | Asus Zenbook Fold | Samsung Galaxy A51/71 | Nest Hub | Nest Hub Max";
    expect(WEB_VIEWPORT_PRESETS.map(({ label }) => label).join(" | ")).toBe(catalog);
  });
});
