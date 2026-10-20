import { describe, expect, test } from "vite-plus/test";

import * as paths from "./projectPaths";

describe("browse path helpers", () => {
  test.each([
    ["~/repo", false],
    ["~/a", false],
    ["~/repo/", true],
    ["\\\\srv\\share\\", false],
    ["\\\\srv\\share\\repo\\", true],
  ])("canNavigateUp(%j) = %s", (input, expected) => {
    expect(paths.canNavigateUp(input)).toBe(expected);
  });

  test.each([
    ["/a/b/", true],
    ["/a/b", false],
    ["C:\\a\\", true],
    ["", false],
  ])("hasTrailingPathSeparator(%j) = %s", (input, expected) => {
    expect(paths.hasTrailingPathSeparator(input)).toBe(expected);
  });

  test.each([
    ["/a/b", "/a/", "b"],
    ["/a/b/", "/a/b/", ""],
    ["C:\\Work\\Repo\\Docs", "C:\\Work\\Repo\\", "Docs"],
    ["/home/u\\proj/docs", "/home/u\\proj/", "docs"],
  ])("%j splits into directory %j and leaf %j", (input, dir, leaf) => {
    expect(paths.getBrowseDirectoryPath(input)).toBe(dir);
    expect(paths.getBrowseLeafPathSegment(input)).toBe(leaf);
  });

  test.each([
    ["/a/", "b", "/a/b/"],
    ["C:\\Work\\", "Repo", "C:\\Work\\Repo\\"],
    ["/home/u\\proj/", "docs", "/home/u\\proj/docs/"],
  ])("appending to %j with %j gives %j", (base, segment, expected) => {
    expect(paths.appendBrowsePathSegment(base, segment)).toBe(expected);
  });

  test.each([
    ["/a/b/", "/a/"],
    ["C:\\Work\\Repo\\", "C:\\Work\\"],
    ["\\\\srv\\share\\repo\\", "\\\\srv\\share\\"],
    ["/home/u\\proj/docs/", "/home/u\\proj/"],
    ["\\\\srv\\share\\", null],
    ["C:\\", null],
  ])("parent of %j is %j", (input, expected) => {
    expect(paths.getBrowseParentPath(input)).toBe(expected);
  });
});

describe("relative and browse-query detection", () => {
  test.each([
    [".", true],
    ["..", true],
    ["./docs", true],
    ["..\\docs", true],
    ["/abs/docs", false],
    ["docs", false],
  ])("isExplicitRelativeProjectPath(%j) = %s", (input, expected) => {
    expect(paths.isExplicitRelativeProjectPath(input)).toBe(expected);
  });

  test.each([
    [".", false],
    ["..", false],
    ["notes", false],
    ["./", true],
    ["../", true],
    ["~/projects", true],
    ["..\\docs", true],
  ])("isFilesystemBrowseQuery(%j) = %s", (input, expected) => {
    expect(paths.isFilesystemBrowseQuery(input)).toBe(expected);
  });

  test("a drive-letter path only browses on a Windows platform", () => {
    const query = "C:\\Work\\Repo\\";
    expect(paths.isFilesystemBrowseQuery(query, "MacIntel")).toBe(false);
    expect(paths.isFilesystemBrowseQuery(query, "Win32")).toBe(true);
    expect(paths.isUnsupportedWindowsProjectPath(query, "MacIntel")).toBe(true);
    expect(paths.isUnsupportedWindowsProjectPath(query, "Win32")).toBe(false);
  });
});

describe("resolving and comparing project paths", () => {
  test.each([
    [".", "/r/app", "/r/app"],
    ["..", "/r/app", "/r"],
    ["./docs", "/r/app", "/r/app/docs"],
    ["../docs", "/r/app", "/r/docs"],
    ["./Repo", "C:\\Work", "C:\\Work\\Repo"],
    ["./docs", "/home/u\\proj", "/home/u\\proj/docs"],
  ])("resolve %j against %j -> %j", (input, base, expected) => {
    expect(paths.resolveProjectPathForDispatch(input, base)).toBe(expected);
  });

  test.each([
    ["/r/app/", "app"],
    ["C:\\Work\\Repo\\", "Repo"],
    ["/home/u\\proj/", "u\\proj"],
  ])("title of %j is %j", (input, expected) => {
    expect(paths.inferProjectTitleFromPath(input)).toBe(expected);
  });

  test("canonical form lowercases and unifies Windows paths and trims trailing separators", () => {
    expect(paths.canonicalProjectPath("C:/Work/Repo/")).toBe("c:\\work\\repo");
    expect(paths.canonicalProjectPath("C:\\Work\\Repo\\")).toBe("c:\\work\\repo");
    expect(paths.canonicalProjectPath("/r/app/")).toBe("/r/app");
  });

  test("dispatch paths are trimmed of whitespace and trailing separators", () => {
    expect(paths.dispatchProjectPath("  /r/app/ ")).toBe("/r/app");
  });

  test("findProjectByPath ignores separator style, case on Windows, and trailing slashes", () => {
    const projects = [
      { id: "posix", cwd: "/r/app" },
      { id: "win", cwd: "C:\\Work\\Repo" },
    ];
    expect(paths.findProjectByPath(projects, "C:/Work/Repo/")?.id).toBe("win");
    expect(paths.findProjectByPath(projects, "/r/app/")?.id).toBe("posix");
    expect(paths.findProjectByPath(projects, "/elsewhere")).toBeUndefined();
  });
});
