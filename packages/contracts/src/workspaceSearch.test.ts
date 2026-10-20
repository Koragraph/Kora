import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import * as Project from "./workspaceSearch.ts";

const SECRET_QUERY = "password=hunter2 token=abc";

describe("workspace search inputs", () => {
  it("lets an entries search have a blank query (frecency browsing)", () => {
    const find = Schema.decodeUnknownSync(Project.WorkspaceFindInput);
    expect(find({ kind: "file", limit: 25, query: " \t ", cwd: "/repo" }).query).toBe("");
  });

  it("keeps the spaces around a content search query", () => {
    const grep = Schema.decodeUnknownSync(Project.WorkspaceGrepInput);
    const input = {
      cwd: "/repo",
      query: "  needle ",
      limit: 50,
      useRegex: false,
      wholeWord: true,
      caseSensitive: true,
    };
    expect(grep(input).query).toBe("  needle ");
  });
});

describe("workspace RPC errors", () => {
  const cause = new Error("EACCES /private/thing");

  const expectSafe = (error: { message: string; cause?: unknown }, message: string) => {
    expect(error.message).toBe(message);
    expect(error.message.includes(cause.message)).toBe(false);
    expect(error.cause).toBe(cause);
  };

  it("an entries search failure reports where, not what was searched", () => {
    const error = new Project.WorkspaceFindError({
      cwd: "/repo",
      normalizedCwd: "/repo",
      queryLength: SECRET_QUERY.length,
      limit: 25,
      failure: "search_index_search_failed",
      detail: "index offline",
      cause,
    });
    expectSafe(error, "Failed to search workspace entries in '/repo'.");
    expect([error.normalizedCwd, error.queryLength]).toEqual(["/repo", SECRET_QUERY.length]);
    expect("query" in error).toBe(false);
    expect(error.message).not.toMatch(/hunter2|abc/);
  });

  it("a content search failure does the same", () => {
    const error = new Project.WorkspaceGrepError({
      cwd: "/repo",
      queryLength: SECRET_QUERY.length,
      limit: 50,
      failure: "search_index_search_failed",
      cause,
    });
    expectSafe(error, "Failed to search workspace contents in '/repo'.");
    expect("query" in error).toBe(false);
  });

  it("a read failure names the file and workspace", () => {
    const error = new Project.WorkspaceFileReadError({
      cwd: "/repo",
      relativePath: "lib/main.ts",
      operation: "read",
      operationPath: "/repo/lib/main.ts",
      resolvedPath: "/repo/lib/main.ts",
      failure: "operation_failed",
      cause,
    });
    expectSafe(error, "Failed to read workspace file 'lib/main.ts' in '/repo'.");
  });

  it("errors from older servers carry only a message and still decode", () => {
    const find = Schema.decodeUnknownSync(Project.WorkspaceFindError)({
      _tag: "WorkspaceFindError",
      message: "Old search failure.",
      query: "do not keep me",
    });
    expect(find.message).toBe("Old search failure.");
    expect([find.cwd, find.queryLength, find.failure]).toEqual([undefined, undefined, undefined]);
    expect("query" in find).toBe(false);

    const write = Schema.decodeUnknownSync(Project.WorkspaceFileWriteError)({
      _tag: "WorkspaceFileWriteError",
      message: "Old write failure.",
    });
    expect([write.message, write.relativePath, write.failure]).toEqual([
      "Old write failure.",
      undefined,
      undefined,
    ]);
  });
});
