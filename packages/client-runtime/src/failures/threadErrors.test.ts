import { ChatDispatchError } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { wasBootstrapThreadDeleted } from "./threadErrors.ts";

describe("wasBootstrapThreadDeleted", () => {
  const worktreeFailure = "Could not set up the worktree.";

  it.each([
    [
      new ChatDispatchError({ bootstrapThreadDisposition: "deleted", message: worktreeFailure }),
      true,
    ],
    [new ChatDispatchError({ message: worktreeFailure }), false],
    [new Error("socket dropped"), false],
  ])("answers for %o", (error, expected) => {
    expect(wasBootstrapThreadDeleted(error)).toBe(expected);
  });
});
