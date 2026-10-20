import { describe, expect, test } from "vite-plus/test";

import { fileBreadcrumbChildren, fileBreadcrumbParent, fileBreadcrumbs } from "./filePath";

const dir = (label: string, path: string) => ({ label, path, kind: "directory" });
const leaf = (label: string, path: string) => ({ label, path, kind: "file" });

describe("fileBreadcrumbs", () => {
  test("a workspace file starts with the project crumb, then each folder, then the file", () => {
    expect(fileBreadcrumbs("proj", "a/b/c.ts")).toEqual([
      { label: "proj", path: "", kind: "project" },
      dir("a", "a"),
      dir("b", "a/b"),
      leaf("c.ts", "a/b/c.ts"),
    ]);
  });

  test("doubled separators collapse", () => {
    expect(fileBreadcrumbs("w", "src//index.ts").map((c) => c.label)).toEqual([
      "w",
      "src",
      "index.ts",
    ]);
  });

  test("an absolute POSIX path has no project crumb", () => {
    expect(fileBreadcrumbs("proj", "/var/log/x.txt")).toEqual([
      dir("var", "/var"),
      dir("log", "/var/log"),
      leaf("x.txt", "/var/log/x.txt"),
    ]);
  });

  test("a drive path starts at the drive and keeps backslashes", () => {
    expect(fileBreadcrumbs("proj", "D:\\Data\\x.txt")).toEqual([
      dir("D:", "D:"),
      dir("Data", "D:\\Data"),
      leaf("x.txt", "D:\\Data\\x.txt"),
    ]);
  });

  test("a UNC path starts at the server", () => {
    expect(fileBreadcrumbs("proj", "\\\\srv\\share\\x.txt").map((c) => c.path)).toEqual([
      "\\\\srv",
      "\\\\srv\\share",
      "\\\\srv\\share\\x.txt",
    ]);
  });
});

describe("fileBreadcrumbChildren", () => {
  const listing = [
    ["README.md", "file"],
    ["src", "directory"],
    ["src-old", "directory"],
    ["src/index.ts", "file"],
    ["src/lib", "directory"],
    ["src-old/index.ts", "file"],
  ].map(([path, kind]) => ({ path: path!, kind: kind as "file" | "directory" }));

  test("the root lists only top-level entries, folders first", () => {
    expect(fileBreadcrumbChildren(listing, "")).toEqual([
      { label: "src", kind: "directory", path: "src" },
      { label: "src-old", kind: "directory", path: "src-old" },
      { label: "README.md", kind: "file", path: "README.md" },
    ]);
  });

  test("a folder's children respect segment boundaries (src is not src-old)", () => {
    expect(fileBreadcrumbChildren(listing, "src")).toEqual([
      { path: "src/lib", kind: "directory", label: "lib" },
      { path: "src/index.ts", kind: "file", label: "index.ts" },
    ]);
  });

  test("names sort naturally and ties keep their input order", () => {
    const names = ["file10.ts", "File2.ts", "file02.ts", "file2.ts"];
    const out = fileBreadcrumbChildren(
      names.map((n) => ({ path: `d/${n}`, kind: "file" as const })),
      "d",
    );
    expect(out.map((e) => e.label)).toEqual(["File2.ts", "file02.ts", "file2.ts", "file10.ts"]);
  });

  test("an unknown folder has no children", () => {
    expect(fileBreadcrumbChildren(listing, "nope")).toEqual([]);
  });
});

describe("fileBreadcrumbParent", () => {
  test.each([
    ["", null],
    ["src", ""],
    ["src/lib", "src"],
    ["a/b/c", "a/b"],
  ])("parent of %j is %j", (input, parent) => {
    expect(fileBreadcrumbParent(input)).toBe(parent);
  });
});
