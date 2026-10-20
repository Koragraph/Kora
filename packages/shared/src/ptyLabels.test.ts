import { describe, expect, it } from "vite-plus/test";

import type { PtySummary } from "@kora/contracts";
("@kora/contracts");

import { ptyLabelFor, resolveTerminalSessionLabel } from "./ptyLabels.ts";

describe("ptyLabelFor", () => {
  it("falls back to the raw id for unknown shapes", () => {
    expect(ptyLabelFor("custom-session")).toBe("custom-session");
  });
});

describe("resolveTerminalSessionLabel", () => {
  it("prefers a non-empty summary label", () => {
    const summary = { label: "  bun  " } as Pick<PtySummary, "label">;
    expect(resolveTerminalSessionLabel("term-1", summary)).toBe("bun");
  });
});
