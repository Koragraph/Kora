import { describe, expect, test } from "vite-plus/test";

import { buildPatchCacheKey, getRenderablePatch } from "./diffRendering";

const HEADER = [
  "diff --git a/m.ts b/m.ts",
  "index 1111111..2222222 100644",
  "--- a/m.ts",
  "+++ b/m.ts",
];
const patchOf = (...lines: string[]) => [...HEADER, ...lines].join("\n");

describe("getRenderablePatch", () => {
  test.each([undefined, "", "  \n "])("%j has nothing to render", (input) => {
    expect(getRenderablePatch(input)).toBeNull();
  });

  test("text that is not a diff comes back as a raw patch with a reason", () => {
    const out = getRenderablePatch("just some words");
    expect(out).toMatchObject({ kind: "raw", text: "just some words" });
  });

  test("hunks keep their source-file line offset", () => {
    const out = getRenderablePatch(patchOf("@@ -48,1 +48,1 @@", "-old", "+new"), "checkpoint");
    expect(out?.kind).toBe("files");
    if (out?.kind !== "files") return;
    expect(out.files[0]?.hunks[0]?.unifiedLineStart).toBe(47);
  });

  test("compacting offsets packs hunks back to back and records what was skipped", () => {
    const patch = patchOf(
      "@@ -48,4 +48,4 @@",
      " c",
      "-x",
      "+y",
      " c",
      " c",
      "@@ -80,3 +80,4 @@",
      " c",
      "+added",
      " c",
      " c",
    );
    const out = getRenderablePatch(patch, "review", { compactPartialHunkOffsets: true });
    if (out?.kind !== "files") throw new Error("expected files");
    const [file] = out.files;
    const [first, second] = file!.hunks;

    expect(first).toMatchObject({ collapsedBefore: 47, unifiedLineStart: 0 });
    expect(second!.collapsedBefore).toBeGreaterThan(0);
    expect(second!.unifiedLineStart).toBe(first!.unifiedLineCount);
    expect(file!.unifiedLineCount).toBe(file!.hunks.reduce((n, h) => n + h.unifiedLineCount, 0));
  });
});

describe("buildPatchCacheKey", () => {
  const base = "diff --git a/a.ts b/a.ts\n+one";

  test("the same patch and scope give the same key", () => {
    expect(buildPatchCacheKey(base, "s")).toBe(buildPatchCacheKey(base, "s"));
  });

  test("another scope gives another key", () => {
    expect(buildPatchCacheKey(base, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(base, "diff-panel:dark"),
    );
  });

  test("other content gives another key", () => {
    expect(buildPatchCacheKey(base)).not.toBe(buildPatchCacheKey(`${base} two`));
  });

  test("leading and trailing whitespace is ignored", () => {
    expect(buildPatchCacheKey(`\n${base}\n`)).toBe(buildPatchCacheKey(base));
  });
});
