import { describe, expect, test } from "vite-plus/test";

import { buildFileTreePathUpdates } from "./fileTreePathReconciliation";

describe("buildFileTreePathUpdates", () => {
  test("an unchanged tree needs no updates", () => {
    const tree = ["lib/", "lib/a.ts"];
    expect(buildFileTreePathUpdates(tree, [...tree])).toEqual([]);
  });

  test("a vanished folder is one recursive removal, not one per descendant", () => {
    expect(
      buildFileTreePathUpdates(
        ["lib/", "lib/gone/", "lib/gone/x.ts", "lib/stay.ts"],
        ["lib/", "lib/stay.ts"],
      ),
    ).toEqual([{ type: "remove", path: "lib/gone/", recursive: true }]);
  });

  test("files that disappeared are removed and new ones added", () => {
    expect(
      buildFileTreePathUpdates(
        ["lib/", "lib/keep.ts", "lib/old.ts"],
        ["lib/", "lib/keep.ts", "lib/new.ts"],
      ),
    ).toEqual([
      { type: "remove", path: "lib/old.ts" },
      { type: "add", path: "lib/new.ts" },
    ]);
  });
});
