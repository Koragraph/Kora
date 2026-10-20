import { describe, expect, test } from "vite-plus/test";

import { projectFileCacheKey, projectFileEditorCacheKey } from "./fileContentRevision";

describe("projectFileEditorCacheKey", () => {
  const first = projectFileEditorCacheKey("local", "/r", "a.json", "v1", undefined);

  test("contents changed from outside the editor get a new identity", () => {
    expect(
      projectFileEditorCacheKey("local", "/r", "a.json", "changed elsewhere", {
        cacheKey: first,
        contents: "v1",
      }),
    ).not.toBe(first);
  });

  test("the same file on another host has its own identity", () => {
    expect(projectFileEditorCacheKey("remote", "/r", "a.json", "v1", undefined)).not.toBe(first);
  });

  test("contents the editor itself produced keep the identity", () => {
    expect(
      projectFileEditorCacheKey("local", "/r", "a.json", "v1 + typing", {
        cacheKey: first,
        contents: "v1 + typing",
      }),
    ).toBe(first);
  });
});

describe("projectFileCacheKey", () => {
  test("two contents of equal length still differ", () => {
    expect(projectFileCacheKey("/r", "a.json", "abcdef")).not.toBe(
      projectFileCacheKey("/r", "a.json", "abcdeg"),
    );
  });

  test("the same input is stable", () => {
    expect(projectFileCacheKey("/r", "a.json", "x")).toBe(projectFileCacheKey("/r", "a.json", "x"));
  });
});
