import { describe, expect, it } from "vite-plus/test";

import * as P from "./projectPaths.ts";

const classify = (value: string) => ({
  drive: P.isWindowsDrivePath(value),
  unc: P.isUncPath(value),
  absolute: P.isWin32AbsolutePath(value),
  relative: P.isExplicitRelativePath(value),
});

describe("Windows-aware path predicates", () => {
  it.each([
    ["E:\\src", { drive: true, unc: false, absolute: true, relative: false }],
    ["f:/src", { drive: true, unc: false, absolute: true, relative: false }],
    ["\\\\nas\\vol\\src", { drive: false, unc: true, absolute: true, relative: false }],
    ["/srv/src", { drive: false, unc: false, absolute: false, relative: false }],
    [".", { drive: false, unc: false, absolute: false, relative: true }],
    ["..", { drive: false, unc: false, absolute: false, relative: true }],
    ["./src", { drive: false, unc: false, absolute: false, relative: true }],
    ["..\\src", { drive: false, unc: false, absolute: false, relative: true }],
    ["~/src", { drive: false, unc: false, absolute: false, relative: false }],
  ])("%s", (value, expected) => {
    expect(classify(value)).toEqual(expected);
  });
});

describe("project path normalisation", () => {
  it("treats a bare drive letter as that drive's root", () => {
    expect(P.dispatchProjectPath("E:")).toBe("E:\\");
    const roots = ["E:", "E:\\", "E:/"].map(P.canonicalProjectPath);
    expect(new Set(roots)).toEqual(new Set(["e:\\"]));
  });

  it("still trims a trailing separator below the root", () => {
    expect(P.dispatchProjectPath("E:\\src\\app\\")).toBe("E:\\src\\app");
  });
});
