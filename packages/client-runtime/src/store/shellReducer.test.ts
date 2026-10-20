import { describe, expect, it } from "vite-plus/test";

import * as Contracts from "@kora/contracts";
import type { ThreadIndexEvent, ThreadIndexSnapshot } from "@kora/contracts";

import { applySummaryStreamEvent as apply } from "./shellReducer.ts";

const AT = "2025-08-08T08:00:00.000Z";
const P = Contracts.ProjectId.make("pj-index");
const T = Contracts.ThreadId.make("th-index");

const project = {
  id: P,
  title: "Index project",
  workspaceRoot: "/src/index",
  scripts: [],
  repositoryIdentity: null,
  defaultModelSelection: null,
  createdAt: AT,
  updatedAt: AT,
} as const;

const thread = {
  ...Object.fromEntries(
    [
      "latestTurn",
      "session",
      "latestUserMessageAt",
      "branch",
      "worktreePath",
      "archivedAt",
      "settledAt",
      "settledOverride",
    ].map((k) => [k, null]),
  ),
  ...Object.fromEntries(
    ["hasPendingApprovals", "hasPendingUserInput", "hasActionableProposedPlan"].map((k) => [
      k,
      false,
    ]),
  ),
  id: T,
  projectId: P,
  title: "Index thread",
  pullRequests: [],
  agentMode: "chat",
  interactionMode: "default",
  runtimeMode: "full-access",
  modelSelection: { model: "m-4", instanceId: Contracts.AgentProfileId.make("codex") },
  createdAt: AT,
  updatedAt: AT,
} as unknown as ThreadIndexSnapshot["threads"][number];

const index = (extra: Partial<ThreadIndexSnapshot> = {}): ThreadIndexSnapshot => ({
  seq: 0,
  updatedAt: AT,
  projects: [],
  threads: [],
  ...extra,
});

describe("thread index reducer", () => {
  it("ignores events at or below the current sequence, returning the same object", () => {
    const current = index({ seq: 4, projects: [project] });
    for (const sequence of [3, 4]) {
      const next = apply(current, {
        kind: "project-upserted",
        sequence,
        project: { ...project, title: "old" },
      });
      expect(next).toBe(current);
      expect([next.seq, next.projects[0]?.title]).toEqual([4, "Index project"]);
    }
  });

  it("ignores event kinds it does not know", () => {
    const current = index();
    expect(
      apply(current, { kind: "from-the-future", sequence: 50 } as unknown as ThreadIndexEvent),
    ).toBe(current);
  });

  describe("projects", () => {
    it("adds, replaces and removes by id, advancing the sequence", () => {
      const added = apply(index(), { kind: "project-upserted", sequence: 1, project });
      expect([added.projects.map(({ id }) => id), added.seq]).toEqual([[P], 1]);

      const renamed = apply(index({ projects: [project] }), {
        kind: "project-upserted",
        sequence: 2,
        project: { ...project, title: "Renamed" },
      });
      expect([renamed.projects.length, renamed.projects[0]?.title, renamed.seq]).toEqual([
        1,
        "Renamed",
        2,
      ]);

      const removed = apply(index({ projects: [project] }), {
        kind: "project-removed",
        sequence: 3,
        projectId: P,
      });
      expect([removed.projects, removed.seq]).toEqual([[], 3]);
    });
  });

  describe("threads", () => {
    it("adds, replaces and removes by id, advancing the sequence", () => {
      const added = apply(index(), { kind: "thread-upserted", sequence: 4, thread });
      expect([added.threads.map(({ id }) => id), added.seq]).toEqual([[T], 4]);

      const renamed = apply(index({ threads: [thread] }), {
        kind: "thread-upserted",
        sequence: 5,
        thread: { ...thread, title: "Renamed thread" },
      });
      expect([renamed.threads.length, renamed.threads[0]?.title]).toEqual([1, "Renamed thread"]);

      const removed = apply(index({ threads: [thread] }), {
        kind: "thread-removed",
        sequence: 6,
        threadId: T,
      });
      expect([removed.threads, removed.seq]).toEqual([[], 6]);
    });
  });
});
