import { jsx } from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { getWebPanelMaxWidth, WebPanelShell } from "./WebPanelShell";

describe("getWebPanelMaxWidth", () => {
  it("allows the panel to use 70% of an ultra-wide viewport without a pixel ceiling", () => {
    expect(getWebPanelMaxWidth(6_000)).toBe(4_200);
  });

  it("rounds fractional CSS pixels down", () => {
    expect(getWebPanelMaxWidth(2_001)).toBe(1_400);
  });

  it("keeps inline panels inside their containing workspace", () => {
    const markup = renderToStaticMarkup(
      jsx(WebPanelShell, { mode: "inline", defaultWidth: 1_000, children: "Panel" }),
    );

    expect(markup).toContain("max-w-full");
  });

  it("reserves the sibling column minimum when the flex row is known", () => {
    // Fullscreen 14" MacBook: viewport 1512, sidebar ~256 → row of 1256.
    // The 70% fraction (1058) would leave the chat column only ~198px;
    // the container clamp caps the panel at 1256 − 360 instead.
    expect(getWebPanelMaxWidth(1_512, 1_256)).toBe(896);
  });

  it("keeps the fraction cap when the row is wide enough for both columns", () => {
    expect(getWebPanelMaxWidth(3_000, 2_900)).toBe(2_100);
  });

  it("rounds fractional row widths down", () => {
    expect(getWebPanelMaxWidth(1_512, 1_256.6)).toBe(896);
  });

  it("never drops below the panel minimum when the row cannot fit both columns", () => {
    // ~1000px window with an expanded sidebar → row of 700. The sibling
    // reservation (700 − 360 = 340) would undercut the panel's own 360
    // minimum and invert the resize clamp, so the floor wins.
    expect(getWebPanelMaxWidth(1_000, 700)).toBe(360);
  });

  it("stays at the panel minimum even when the row is narrower than the reservation", () => {
    expect(getWebPanelMaxWidth(1_512, 300)).toBe(360);
  });
});

describe("getWebPanelMaxWidth: a blob's panel docks from 800 px", () => {
  it("a narrower panel minimum and a smaller sibling reserve (default behaviour unchanged)", () => {
    expect(getWebPanelMaxWidth(1400, 1000)).toBe(640);
    // 800 px window - the 256 px sidebar = a 544 px row: a 300 px panel beside a 244 px chat, not a sheet over a blur
    expect(getWebPanelMaxWidth(800, 544, { panelMin: 300, siblingMin: 244 })).toBe(300);
    expect(getWebPanelMaxWidth(1000, 744, { panelMin: 300, siblingMin: 280 })).toBe(464);
  });
});
