import { describe, expect, it } from "vite-plus/test";

import { isHiddenThreadShell } from "./hiddenThreads";

describe("isHiddenThreadShell", () => {
  it("a routine run is hidden, by the flag or by its origin", () => {
    expect(isHiddenThreadShell({ hidden: true })).toBe(true);
    expect(isHiddenThreadShell({ origin: { kind: "routine" } })).toBe(true);
  });
  it("everything else is listed: user threads, Kora's delegated steps, continued threads", () => {
    expect(isHiddenThreadShell({})).toBe(false);
    expect(isHiddenThreadShell({ hidden: false, origin: null })).toBe(false);
    for (const kind of ["user", "kora", "continue"]) expect(isHiddenThreadShell({ origin: { kind } })).toBe(false);
  });
});
