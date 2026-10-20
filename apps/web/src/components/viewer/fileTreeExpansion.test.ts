import { describe, expect, it, vi } from "@effect/vitest";

import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";

/** A tree model whose directories read and write a plain `open` map. */
function treeOf(open: Record<string, boolean>) {
  const folders = new Map<string, ReturnType<typeof folder>>();
  const folder = (path: string) => ({
    isDirectory: (): true => true,
    isExpanded: () => open[path] ?? false,
    expand: () => void (open[path] = true),
    collapse: () => void (open[path] = false),
  });
  return {
    getItem(path: string) {
      if (!folders.has(path)) folders.set(path, folder(path));
      return folders.get(path)!;
    },
  };
}

describe("setAllDirectoriesExpanded", () => {
  it("opens or closes every listed directory", () => {
    const open = { "a/": true, "b/": false };
    const tree = treeOf(open);

    setAllDirectoriesExpanded(tree, ["a/", "b/"], true);
    expect(open).toEqual({ "a/": true, "b/": true });

    setAllDirectoriesExpanded(tree, ["a/", "b/"], false);
    expect(open).toEqual({ "a/": false, "b/": false });
  });

  it("does not touch a directory that is already in the requested state", () => {
    const tree = treeOf({ "a/": true });
    const collapse = vi.spyOn(tree.getItem("a/"), "collapse");
    const expand = vi.spyOn(tree.getItem("a/"), "expand");

    setAllDirectoriesExpanded(tree, ["a/"], true);

    expect(collapse).not.toHaveBeenCalled();
    expect(expand).not.toHaveBeenCalled();
  });
});

describe("areAllDirectoriesExpanded", () => {
  it("is false for an empty list, whatever the tree says", () => {
    expect(areAllDirectoriesExpanded(treeOf({ "a/": true }), [])).toBe(false);
  });

  it("is true only when every listed directory is open", () => {
    expect(areAllDirectoriesExpanded(treeOf({ "a/": true, "b/": true }), ["a/", "b/"])).toBe(true);
    expect(areAllDirectoriesExpanded(treeOf({ "a/": true, "b/": false }), ["a/", "b/"])).toBe(
      false,
    );
  });
});
