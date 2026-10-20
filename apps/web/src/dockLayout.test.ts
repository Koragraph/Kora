import { describe, expect, it } from "vite-plus/test";

import {
  BLOB_CHAT_MIN_WIDTH,
  BLOB_PANEL_SHEET_BREAKPOINT,
  BLOB_PANEL_SHEET_MEDIA_QUERY,
} from "./dockLayout";

/** What `matchMedia` would answer for a "(max-width: Npx)" query at a window width. */
const matches = (query: string, width: number): boolean => {
  const m = /\(max-width:\s*(\d+)px\)/.exec(query);
  return m !== null && width <= Number(m[1]);
};

describe("a blob's side panel", () => {
  it("overlays the chat as a sheet below 1100 px (900 px used to squeeze the chat to ~260 px)", () => {
    expect(BLOB_PANEL_SHEET_BREAKPOINT).toBe(1100);
    expect(matches(BLOB_PANEL_SHEET_MEDIA_QUERY, 900)).toBe(true);
    expect(matches(BLOB_PANEL_SHEET_MEDIA_QUERY, 1099)).toBe(true);
    expect(matches(BLOB_PANEL_SHEET_MEDIA_QUERY, 1100)).toBe(false);
    expect(matches(BLOB_PANEL_SHEET_MEDIA_QUERY, 1440)).toBe(false);
  });

  it("when docked, the chat keeps at least ~420 px beside the sidebar and the panel", () => {
    expect(BLOB_CHAT_MIN_WIDTH).toBeGreaterThanOrEqual(420);
    const sidebar = 256;
    const narrowestPanel = 300;
    // the narrowest window that docks still leaves the chat its minimum
    expect(BLOB_PANEL_SHEET_BREAKPOINT - sidebar - narrowestPanel).toBeGreaterThanOrEqual(
      BLOB_CHAT_MIN_WIDTH,
    );
  });
});
