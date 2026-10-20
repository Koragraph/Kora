import type { FleetWorker } from "@kora/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  hasSomethingToMerge,
  mergeCleanNote,
  mergeCleanBlocked,
  mergeCleanPlan,
  mergeFailureOf,
  mergeFailureText,
  paneDisplayName,
  workerDisplayName,
} from "./mergePlan.logic";

const tree = (ahead?: number, dirty?: number) => ({
  path: "/w",
  branch: "kora/x",
  mainRoot: "/x",
  ...(ahead === undefined ? {} : { ahead }),
  ...(dirty === undefined ? {} : { dirty }),
});

const worker = (over: Partial<FleetWorker>): FleetWorker =>
  ({
    paneId: "p1",
    terminalId: "worker:p1",
    agent: "claude",
    account: null,
    title: "Add retry",
    state: "idle",
    blocker: null,
    steered: false,
    steeredAt: null,
    cwd: "/x",
    worktree: tree(1, 0),
    costUsd: null,
    contextPct: null,
    exitCode: null,
    createdAt: 0,
    lastOutputAt: 0,
    ...over,
  }) as FleetWorker;

describe("hasSomethingToMerge", () => {
  it("needs commits ahead or uncommitted files, and assumes so when counts are unknown", () => {
    expect(hasSomethingToMerge(worker({ worktree: tree(2, 0) }))).toBe(true);
    expect(hasSomethingToMerge(worker({ worktree: tree(0, 3) }))).toBe(true);
    expect(hasSomethingToMerge(worker({ worktree: tree(0, 0) }))).toBe(false);
    expect(hasSomethingToMerge(worker({ worktree: tree() }))).toBe(true);
    expect(hasSomethingToMerge(worker({ worktree: null }))).toBe(false);
  });
});

describe("mergeCleanPlan", () => {
  it("leaves out working, blocked, empty, flagged and merged workers, in verdict order", () => {
    const workers = [
      worker({ paneId: "p1" }),
      worker({ paneId: "p2", state: "working" }),
      worker({ paneId: "p3", state: "blocked" }),
      worker({ paneId: "p4", worktree: tree(0, 0) }),
      worker({ paneId: "p5" }),
      worker({ paneId: "p6" }),
      worker({ paneId: "p7" }),
      worker({ paneId: "p8", state: "exited" }),
    ];
    const plan = mergeCleanPlan({
      workers,
      merged: new Set(["p7"]),
      flagged: new Set(["p6"]),
      order: ["p5", "p1"],
    });
    expect(plan).toEqual({ ordered: ["p5", "p1", "p8"], stillWorking: 2, flagged: 1 });
    expect(mergeCleanNote(plan)).toBe("2 still working, merging 3");
    expect(mergeCleanNote({ ordered: [], stillWorking: 1, flagged: 0 })).toBe("1 still working");
    expect(mergeCleanNote({ ordered: ["p1"], stillWorking: 0, flagged: 0 })).toBeNull();
    expect(mergeCleanNote({ ordered: [], stillWorking: 0, flagged: 2 })).toBe("2 flagged");
    expect(mergeCleanNote({ ordered: [], stillWorking: 1, flagged: 2 })).toBe(
      "1 still working, 2 flagged",
    );
  });

  it("is blocked when every unmerged worker is flagged or still working", () => {
    expect(mergeCleanBlocked({ ordered: [], stillWorking: 0, flagged: 2 })).toBe(true);
    expect(mergeCleanBlocked({ ordered: [], stillWorking: 1, flagged: 0 })).toBe(true);
    expect(mergeCleanBlocked({ ordered: ["p1"], stillWorking: 0, flagged: 2 })).toBe(false);
    expect(mergeCleanBlocked({ ordered: [], stillWorking: 0, flagged: 0 })).toBe(false);
  });
});

describe("worker names", () => {
  it("names workers by agent and task, never by pane id", () => {
    expect(workerDisplayName(worker({ title: "Add auth tests" }))).toBe("Claude · Add auth tests");
    expect(workerDisplayName(worker({ agent: "codex", title: "codex" }))).toBe("codex");
    const workers = [worker({ paneId: "p3", title: "Fix login" })];
    expect(paneDisplayName(workers, "p3")).toBe("Claude · Fix login");
    expect(paneDisplayName(workers, "p9")).toBe("p9");
  });
});

describe("mergeFailureText", () => {
  it("says why and how many files conflict", () => {
    expect(mergeFailureText({ message: "Merge conflict.", conflicts: ["a.ts", "b.ts"] })).toBe(
      "Merge conflict. Conflicts in 2 files.",
    );
    expect(mergeFailureText({ message: "", conflicts: [] })).toBe("The merge did not go through.");
  });
});

describe("mergeFailureOf", () => {
  it("reads a refused merge, an RPC failure, and a clean merge", () => {
    expect(
      mergeFailureOf(
        AsyncResult.success({
          ok: false,
          branch: "kora/p1",
          into: "main",
          message: "Merge conflict.",
          conflicts: ["src/a.ts"],
        }),
      ),
    ).toEqual({ text: "Merge conflict. Conflicts in 1 file.", conflicts: ["src/a.ts"] });
    expect(mergeFailureOf(AsyncResult.failure(new Error("down") as never))?.text).toMatch(
      /request failed/,
    );
    expect(
      mergeFailureOf(
        AsyncResult.success({ ok: true, branch: "b", into: "main", message: "", conflicts: [] }),
      ),
    ).toBeNull();
    expect(mergeFailureOf(undefined)).toBeNull();
  });
});
