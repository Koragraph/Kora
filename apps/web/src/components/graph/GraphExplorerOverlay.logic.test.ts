import { describe, expect, it } from "vite-plus/test";

import {
  classifyGraphFailure,
  graphStatusLine,
  hoverCardPosition,
} from "./GraphExplorerOverlay.logic";

describe("classifyGraphFailure", () => {
  it("reads only a 404 as an un-indexed workspace", () => {
    expect(classifyGraphFailure(404)).toBe("not-indexed");
    expect(classifyGraphFailure(500)).toBe("error");
    expect(classifyGraphFailure(null)).toBe("error");
  });
});

describe("graphStatusLine", () => {
  it("summarises a loaded graph", () => {
    expect(graphStatusLine("ready", { shownNodes: 600, totalNodes: 12000, shownEdges: 1500 })).toBe(
      `600 of ${(12000).toLocaleString()} declarations · ${(1500).toLocaleString()} relationships`,
    );
  });

  it("tells a missing index apart from a failed load", () => {
    expect(graphStatusLine("not-indexed", null)).not.toBe(graphStatusLine("error", null));
    expect(graphStatusLine("loading", null)).toMatch(/Loading/);
  });
});

describe("hoverCardPosition", () => {
  it("sits right of the pointer when there is room", () => {
    expect(hoverCardPosition({ sx: 40, sy: 40 }, 560)).toEqual({ left: 52, top: 52 });
  });

  it("flips left near the canvas edge instead of overflowing it", () => {
    const { left } = hoverCardPosition({ sx: 500, sy: 40 }, 560);
    expect(left + 280).toBeLessThanOrEqual(500);
  });
});
