import { describe, expect, it } from "vite-plus/test";
import { classifyTaskAgentKind, type ChatThreadActivity } from "@kora/contracts";

import * as Subagents from "./subagentRuntime.ts";

// ---------------------------------------------------------------------------
// Row builders. Rows look like they do after ingestion: the server stamps `agentKind` on every
// task.* payload with the shared classifier, so the builders stamp too unless told otherwise.
// ---------------------------------------------------------------------------

type Fields = Record<string, unknown>;

let tick = 0;
/** One second after the previous row, from 09:00:00. */
const nextTime = () => {
  tick += 1;
  const minutes = Math.floor(tick / 60);
  return `2025-03-03T09:${String(minutes).padStart(2, "0")}:${String(tick % 60).padStart(2, "0")}.000Z`;
};

function row(kind: string, payload: Fields, at = nextTime(), stamp = true): ChatThreadActivity {
  const needsStamp = stamp && kind.startsWith("task.") && !Object.hasOwn(payload, "agentKind");
  const agentKind = needsStamp
    ? classifyTaskAgentKind({
        taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
        agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
      })
    : undefined;
  return {
    id: `act-${tick}-${kind}`,
    kind,
    createdAt: at,
    turnId: null,
    summary: kind,
    tone: "info",
    payload: needsStamp ? { ...payload, agentKind } : payload,
  } as unknown as ChatThreadActivity;
}

const started = (taskId: string, fields: Fields = {}, at?: string) =>
  row("task.started", { taskId, ...fields }, at);
const progress = (taskId: string, fields: Fields = {}, at?: string) =>
  row("task.progress", { taskId, ...fields }, at);
const updated = (taskId: string, fields: Fields = {}, at?: string) =>
  row("task.updated", { taskId, ...fields }, at);
const completed = (taskId: string, fields: Fields = {}, at?: string) =>
  row("task.completed", { taskId, ...fields }, at);
/** A row from before the server stamped agentKind (old thread or server). */
const unstamped = (kind: string, payload: Fields) => row(kind, payload, nextTime(), false);

const fold = (...rows: ChatThreadActivity[]) => Subagents.foldSubagentActivities(rows);
const only = (...rows: ChatThreadActivity[]) => {
  const agents = fold(...rows);
  expect(agents.length).toBe(1);
  return agents[0]!;
};
const byId = (agents: ReadonlyArray<Subagents.RuntimeSubagent>, id: string) =>
  agents.find((a) => a.id === id);
const ids = (agents: ReadonlyArray<{ id: string }>) => agents.map(({ id }) => id);

/** A workflow member row: parent and slot set, plus whatever the case needs. */
const member = (workflow: string, slot: number, fields: Fields = {}) =>
  progress(`${workflow}:wf:${slot}`, { parentAgentId: workflow, agentIndex: slot, ...fields });

// ---------------------------------------------------------------------------

describe("folding task activities into agents", () => {
  describe("lifecycle", () => {
    it("follows an agent from start through progress to completion", () => {
      const agent = only(
        started("t-a", { title: "Map the API", role: "researcher" }),
        progress("t-a", { lastToolName: "Grep", typedUsage: { totalTokens: 300, toolUses: 2 } }),
        completed("t-a", {
          status: "completed",
          summary: "3 endpoints",
          typedUsage: { totalTokens: 2_400, toolUses: 6 },
        }),
      );
      expect(agent).toMatchObject({
        title: "Map the API",
        role: "researcher",
        status: "completed",
        result: "3 endpoints",
        activationCount: 1,
      });
      expect(agent.usage?.totalTokens).toBe(2_400);
      expect(agent.completedAt).not.toBeNull();
    });

    it("creates a running agent from progress alone when its start aged out", () => {
      const agent = only(
        progress("t-late", {
          title: "Picked up later",
          role: "checker",
          typedUsage: { totalTokens: 50 },
        }),
      );
      expect([agent.title, agent.status]).toEqual(["Picked up later", "running"]);
    });

    it("creates an agent from an update alone with exactly one activation", () => {
      const agent = only(updated("t-u", { status: "running", role: "builder" }));
      expect([agent.activationCount, agent.status]).toEqual([1, "running"]);
    });

    it("keeps an idle agent's identity when it resumes", () => {
      const agent = only(
        started("child-1", { title: "Pip", role: "researcher" }),
        updated("child-1", { status: "idle" }),
        updated("child-1", { status: "running" }),
      );
      expect([agent.activationCount, agent.status]).toEqual([2, "running"]);
    });

    it("treats a run after completion as a reactivation that clears the old outcome", () => {
      const agent = only(
        started("t-r", { taskType: "local_agent" }),
        completed("t-r", { status: "completed", summary: "first pass" }),
        updated("t-r", { status: "running" }),
      );
      expect([agent.activationCount, agent.result, agent.completedAt, agent.status]).toEqual([
        2,
        null,
        null,
        "running",
      ]);
    });

    it("skips malformed rows one by one", () => {
      const agent = only(
        started("t-ok", { title: "Fine", taskType: "local_agent" }),
        row("task.progress", { nothing: true }),
        row("task.progress", { taskId: 7 }),
      );
      expect(agent.title).toBe("Fine");
    });
  });

  describe("order robustness", () => {
    it("lets a completion arrive first; a later start only adds metadata", () => {
      const agent = only(
        completed("t-o", { status: "failed", summary: "crashed", role: "fixer" }),
        started("t-o", { title: "Named late", role: "fixer" }),
      );
      expect(agent).toMatchObject({
        title: "Named late",
        role: "fixer",
        status: "failed",
        error: "crashed",
      });
    });

    it("does not reopen a run settled by an update when the start shows up late", () => {
      const agent = only(
        updated("t-s", { status: "failed", role: "builder" }),
        started("t-s", { taskType: "local_agent", title: "Late" }),
      );
      expect([agent.status, agent.title]).toEqual(["failed", "Late"]);
    });

    it("keeps the first terminal time when completions repeat", () => {
      const agent = only(
        started("t-d", { taskType: "local_agent" }),
        completed("t-d", { status: "completed" }, "2025-03-03T10:00:00.000Z"),
        completed("t-d", { status: "completed" }, "2025-03-03T10:30:00.000Z"),
      );
      expect(agent.completedAt).toBe("2025-03-03T10:00:00.000Z");
    });

    it("keeps the first result when completions repeat", () => {
      const agent = only(
        started("t-f", { taskType: "local_agent" }),
        completed("t-f", { status: "completed", summary: "original" }),
        completed("t-f", { status: "completed", summary: "duplicate" }),
      );
      expect(agent.result).toBe("original");
    });

    // Claude often settles a task with an update before the completion that has the result.
    it("still takes result and usage from a completion after a terminal update", () => {
      const agent = only(
        started("t-e", { taskType: "local_agent" }),
        updated(
          "t-e",
          { status: "completed", endedAt: "2025-03-03T10:14:00.000Z" },
          "2025-03-03T10:15:00.000Z",
        ),
        completed(
          "t-e",
          {
            status: "completed",
            summary: "the answer",
            typedUsage: { totalTokens: 3_100, toolUses: 4 },
          },
          "2025-03-03T10:15:01.000Z",
        ),
      );
      expect([agent.status, agent.result, agent.usage?.totalTokens]).toEqual([
        "completed",
        "the answer",
        3_100,
      ]);
      expect(agent.completedAt).toBe("2025-03-03T10:14:00.000Z");
    });

    it("prefers the provider's end time on the transition that settles the run", () => {
      const agent = only(
        started("t-p", { taskType: "local_agent" }),
        updated(
          "t-p",
          { status: "failed", endedAt: "2025-03-03T08:59:00.000Z" },
          "2025-03-03T09:00:45.000Z",
        ),
      );
      expect(agent.completedAt).toBe("2025-03-03T08:59:00.000Z");
    });
  });

  describe("usage", () => {
    it("takes the field-wise maximum so repeats and stale frames never shrink totals", () => {
      const agent = only(
        started("t-m", { taskType: "local_agent" }),
        progress("t-m", { typedUsage: { totalTokens: 600, inputTokens: 450 } }),
        progress("t-m", { typedUsage: { totalTokens: 600, inputTokens: 450 } }),
        progress("t-m", { typedUsage: { totalTokens: 200 } }),
      );
      expect(agent.usage).toEqual({ totalTokens: 600, inputTokens: 450 });
    });

    it("keeps known breakdown fields when the final usage only has a total", () => {
      const agent = only(
        started("t-b", { taskType: "local_agent" }),
        progress("t-b", { typedUsage: { totalTokens: 500, inputTokens: 350, outputTokens: 90 } }),
        completed("t-b", { status: "completed", typedUsage: { totalTokens: 700 } }),
      );
      expect(agent.usage).toEqual({ totalTokens: 700, inputTokens: 350, outputTokens: 90 });
    });

    it("lets a usage snapshot enrich an agent without touching its status", () => {
      const agent = only(
        started("t-w", { taskType: "local_agent" }),
        progress("t-w", { status: "waiting" }),
        progress("t-w", { usageSnapshot: true, typedUsage: { totalTokens: 900 } }),
      );
      expect([agent.status, agent.usage?.totalTokens]).toEqual(["waiting", 900]);
    });

    it("can rebuild a running agent from a usage snapshot alone", () => {
      const agent = only(
        progress("t-snap", { usageSnapshot: true, typedUsage: { totalTokens: 640 } }),
      );
      expect([agent.status, agent.usage?.totalTokens]).toEqual(["running", 640]);
    });
  });

  describe("text bounds", () => {
    it("clips text at 180 characters and keeps at most 6 distinct recent entries", () => {
      const filler = "y".repeat(400);
      const rows = [started("t-l", { taskType: "local_agent" })];
      for (let n = 0; n < 10; n += 1) rows.push(progress("t-l", { summary: `${filler}${n}` }));
      rows.push(progress("t-l", { summary: `${filler}9` }));
      const { recentActivity } = only(...rows);
      expect(recentActivity.length).toBeLessThanOrEqual(6);
      expect(recentActivity.every(({ summary }) => summary.length <= 180)).toBe(true);
      // Clipping makes these identical, and consecutive duplicates collapse.
      expect(new Set(recentActivity.map(({ summary }) => summary)).size).toBe(
        recentActivity.length,
      );
    });
  });

  describe("batches", () => {
    const NOTE = "Turn over; per-agent status is not reported.";
    it("reports a batch as idle with the provider's note once its turn ends", () => {
      const agent = only(
        progress("b-1", {
          taskType: "subagent_batch",
          title: "Reader batch",
          status: "running",
          summary: "Spawning readers",
        }),
        updated("b-1", {
          timelineBypass: true,
          detail: NOTE,
          status: "idle",
          taskType: "subagent_batch",
        }),
      );
      expect(agent).toMatchObject({
        kind: "subagent_batch",
        title: "Reader batch",
        progress: NOTE,
        error: null,
        result: null,
        status: "idle",
      });
    });

    it("learns it is a batch from a later row and keeps that on sparse rows", () => {
      const agent = only(
        progress("b-2", { taskType: "subagent", status: "running" }),
        updated("b-2", { taskType: "subagent_batch", status: "idle" }),
        updated("b-2", { status: "idle" }),
      );
      expect([agent.kind, agent.status]).toEqual(["subagent_batch", "idle"]);
    });
  });

  describe("workflows", () => {
    it("attaches slot-keyed members to their coordinator and keeps its phases", () => {
      const agents = fold(
        started("flow", {
          taskType: "local_workflow",
          title: "review-flow",
          workflowName: "review-flow",
        }),
        progress("flow", {
          phases: [
            { index: 1, title: "Check" },
            { index: 0, title: "Read" },
          ],
        }),
        member("flow", 0, {
          title: "read:api",
          status: "running",
          phaseIndex: 0,
          phaseTitle: "Read",
          timelineBypass: true,
        }),
      );
      expect(byId(agents, "flow")?.kind).toBe("workflow");
      expect(byId(agents, "flow")?.phases).toEqual([
        { index: 0, title: "Read" },
        { index: 1, title: "Check" },
      ]);
      expect(byId(agents, "flow:wf:0")).toMatchObject({
        kind: "workflow_agent",
        parentAgentId: "flow",
      });
    });

    it("treats a higher attempt as a reactivation that clears the failure", () => {
      const agent = only(
        member("flow2", 1, {
          title: "check:cache",
          status: "failed",
          error: "first try died",
          attempt: 1,
        }),
        member("flow2", 1, { title: "check:cache", status: "running", attempt: 2 }),
      );
      expect(agent.activationCount).toBeGreaterThanOrEqual(2);
      expect([agent.error, agent.status]).toEqual([null, "running"]);
    });

    it("counts each retry attempt once", () => {
      const agent = only(
        member("flow3", 0, { status: "running", attempt: 1 }),
        member("flow3", 0, { status: "failed", attempt: 1 }),
        member("flow3", 0, { status: "running", attempt: 2 }),
      );
      expect(agent.activationCount).toBe(2);
    });

    it("drops a session URL that is not http(s) but keeps other handles", () => {
      const agent = only(
        started("flow4", {
          taskType: "local_workflow",
          runHandles: { sessionUrl: "data:text/html,hi", runId: "r-9" },
        }),
      );
      expect(agent.runHandles).toEqual({ runId: "r-9" });
    });

    it("settles unfinished members with the coordinator's outcome", () => {
      const done = fold(
        started("flow5", { taskType: "local_workflow" }),
        member("flow5", 0, { title: "stuck", status: "running" }),
        completed("flow5", { status: "completed", taskType: "local_workflow" }),
      );
      expect(byId(done, "flow5:wf:0")?.status).toBe("completed");
      expect(byId(done, "flow5:wf:0")?.completedAt).not.toBeNull();

      const failed = fold(
        started("flow6", { taskType: "local_workflow" }),
        member("flow6", 0, { status: "running" }),
        completed("flow6", { status: "failed", taskType: "local_workflow" }),
      );
      expect(byId(failed, "flow6:wf:0")?.status).toBe("interrupted");
    });
  });

  describe("model attribution", () => {
    it("takes model and effort from the start and refines the model later without losing effort", () => {
      const agent = only(
        started("t-model", { title: "Check math", model: "haiku", effort: "medium" }),
        progress("t-model", { model: "claude-haiku-5[1m]" }),
      );
      expect([agent.model, agent.effort]).toEqual(["claude-haiku-5[1m]", "medium"]);
    });

    it("applies metadata-only rows without changing status, whatever the status", () => {
      const waitingRows = [
        updated("t-meta", { title: "Metadata", status: "waiting" }),
        updated("t-meta", { model: "gpt-5.6-luna", effort: "low" }),
      ];
      const waiting = only(...waitingRows);
      expect(waiting.status).toBe("waiting");
      expect(Subagents.formatSubagentModelLabel(waiting.model, waiting.effort)).toBe(
        "gpt-5.6-luna · low",
      );

      const idleRows = [
        ...waitingRows,
        updated("t-meta", { status: "idle" }),
        updated("t-meta", { model: "gpt-5.6-luna" }),
      ];
      expect(only(...idleRows).status).toBe("idle");

      const done = only(
        ...idleRows,
        progress("t-meta", { typedUsage: { totalTokens: 10 } }),
        completed("t-meta", { status: "completed" }),
        updated("t-meta", { effort: "low" }),
      );
      expect([done.status, done.model, done.effort]).toEqual(["completed", "gpt-5.6-luna", "low"]);
    });
  });

  describe("roster membership", () => {
    it("leaves plan tasks, shells and monitors out, from any lifecycle row", () => {
      const agents = fold(
        started("p-1", { taskType: "plan" }),
        started("sh-1", { taskType: "shell", title: "Sleep 10s" }),
        progress("sh-2", { taskType: "shell", title: "Tail log" }),
        completed("mon-1", { taskType: "monitor", status: "completed" }),
        started("ag-1", { taskType: "subagent", title: "Actual agent" }),
      );
      expect(ids(agents)).toEqual(["ag-1"]);
    });

    it("keeps rows without a task type (workflow members, Codex children)", () => {
      expect(fold(member("flow7", 0, { status: "running" })).length).toBe(1);
    });

    it("admits by agent-flavoured type: local agents and unknown future kinds join", () => {
      const agents = fold(
        started("x-1", { taskType: "local_agent", title: "Tester", role: "claude" }),
        started("x-2", { taskType: "brand_new_kind", title: "Novel" }),
      );
      expect(ids(agents).sort()).toEqual(["x-1", "x-2"]);
    });

    it("keeps a nested agent but not the shells it starts", () => {
      const agents = fold(
        started("nest-1", { taskType: "local_agent", agentId: "boss", title: "Nested reader" }),
        started("nest-sh", { taskType: "local_bash", agentId: "boss", title: "Nested sleep" }),
      );
      expect(ids(agents)).toEqual(["nest-1"]);
    });

    it("trusts only the server's stamp; unstamped legacy rows stay in the work log", () => {
      const agents = fold(
        started("bg-1", { agentKind: "background", role: "watcher", model: "haiku" }),
        started("ag-2", { agentKind: "agent", detail: "plain row" }),
        unstamped("task.started", { taskId: "legacy", detail: "watching files" }),
        unstamped("task.progress", { taskId: "legacy", summary: "still watching" }),
      );
      expect(ids(agents)).toEqual(["ag-2"]);
    });

    it("routes a later unstamped row to an agent already known (membership sticks)", () => {
      const agent = only(
        started("a-s", { taskType: "local_agent", title: "Agent" }),
        unstamped("task.completed", { taskId: "a-s", status: "completed", summary: "finished" }),
      );
      expect([agent.status, agent.result]).toEqual(["completed", "finished"]);
    });
  });

  describe("dead sessions", () => {
    it("interrupt live agents but leave idle and settled ones alone", () => {
      const rows = [
        started("live", { taskType: "local_agent" }),
        started("rest", { taskType: "local_agent" }),
        updated("rest", { status: "idle" }),
        started("done", { taskType: "local_agent" }),
        completed("done", { status: "completed" }),
      ];
      const statuses = (sessionLive: boolean) =>
        Object.fromEntries(
          Subagents.foldSubagentActivities(rows, { sessionLive }).map((a) => [a.id, a.status]),
        );
      expect(statuses(false)).toEqual({ live: "interrupted", rest: "idle", done: "completed" });
      expect(statuses(true).live).toBe("running");
    });
  });
});

describe("agent panel model", () => {
  const roster = fold(
    started("flow", { taskType: "local_workflow", title: "review" }),
    progress("flow", {
      phases: [
        { index: 0, title: "Read" },
        { index: 1, title: "Check" },
      ],
    }),
    member("flow", 0, { title: "read:a", status: "completed", phaseIndex: 0 }),
    completed("flow:wf:0", { status: "completed", parentAgentId: "flow" }),
    member("flow", 1, {
      title: "check:b",
      status: "running",
      phaseIndex: 1,
      typedUsage: { totalTokens: 1_500 },
    }),
    started("solo", { title: "Pip", role: "researcher" }),
    updated("solo", { status: "idle" }),
  );
  const model = Subagents.deriveAgentPanelModel({ agents: roster });

  it("groups members by phase and keeps direct spawns apart", () => {
    const [group] = model.workflows;
    expect(model.workflows.length).toBe(1);
    expect(group!.phases.map(({ state }) => state)).toEqual(["done", "running"]);
    expect(ids(model.directAgents)).toEqual(["solo"]);
  });

  it("puts every agent in one bucket, except a coordinator standing in for its members", () => {
    expect([model.idleCount, model.runningCount]).toEqual([1, 1]);
    expect(model.idleCount + model.runningCount + model.waitingCount + model.settledCount).toBe(
      roster.length - 1,
    );
    // One member running; the idle direct spawn is not live and the coordinator does not count.
    expect(model.liveCount).toBe(1);
  });

  it("does not count a finished coordinator as a second settled agent", () => {
    const finished = Subagents.deriveAgentPanelModel({
      agents: fold(
        started("sweep", { taskType: "local_workflow", title: "sweep" }),
        member("sweep", 0, { title: "sweep:a", status: "completed", phaseIndex: 0 }),
        completed("sweep:wf:0", { status: "completed", parentAgentId: "sweep" }),
        completed("sweep", { status: "completed" }),
      ),
    });
    expect([finished.settledCount, finished.liveCount]).toEqual([1, 0]);
  });

  it("keeps direct spawns in first-seen order as they update", () => {
    const agents = fold(
      started("d-a", { title: "One" }, "2025-03-03T11:00:00.000Z"),
      started("d-b", { title: "Two" }, "2025-03-03T11:00:01.000Z"),
      progress("d-a", { summary: "busy" }, "2025-03-03T11:00:02.000Z"),
    );
    expect(ids(Subagents.deriveAgentPanelModel({ agents }).directAgents)).toEqual(["d-a", "d-b"]);
  });

  it("keeps first-seen order after the 100-agent cap trims the roster", () => {
    const starts = Array.from({ length: 101 }, (_, n) =>
      started(
        `cap-${n}`,
        { title: `Agent ${n}` },
        `2025-03-03T12:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000Z`,
      ),
    );
    const agents = fold(
      ...starts,
      progress("cap-0", { summary: "still here" }, "2025-03-03T12:05:00.000Z"),
    );
    const shown = ids(Subagents.deriveAgentPanelModel({ agents }).directAgents);
    expect(shown.length).toBe(100);
    expect(shown.slice(0, 3)).toEqual(["cap-0", "cap-2", "cap-3"]);
    expect(shown.at(-1)).toBe("cap-100");
  });

  it("never marks a phase done while its only member is pending", () => {
    const pending = Subagents.deriveAgentPanelModel({
      agents: fold(
        started("q", { taskType: "local_workflow" }),
        progress("q", { phases: [{ index: 0, title: "Fix" }] }),
        member("q", 0, { title: "fixer", status: "pending", phaseIndex: 0 }),
      ),
    });
    expect(pending.workflows[0]!.phases[0]!.state).not.toBe("done");
  });

  it("shows members with unknown phase indices as unphased instead of dropping them", () => {
    const group = Subagents.deriveAgentPanelModel({
      agents: fold(
        started("ph", { taskType: "local_workflow", phases: [{ index: 0, title: "Single" }] }),
        member("ph", 0, { status: "running", phaseIndex: 0 }),
        progress("ph:wf:9", { parentAgentId: "ph", status: "running", phaseIndex: 9 }),
      ),
    }).workflows[0]!;
    const visible = [
      ...group.phases.flatMap(({ members }) => members),
      ...group.unphasedMembers,
    ].map(({ id }) => id);
    expect(visible).toEqual(expect.arrayContaining(["ph:wf:0", "ph:wf:9"]));
  });

  it("uses a v2 projection instead of the fold, never both", () => {
    const fromV2 = { ...roster[0]!, id: "v2-agent", title: "Projected" };
    const projected = Subagents.deriveAgentPanelModel({ agents: roster, v2Projection: [fromV2] });
    const shownIds = [
      ...projected.workflows.map(({ workflow }) => workflow.id),
      ...ids(projected.directAgents),
    ];
    expect(shownIds).toContain("v2-agent");
    expect(shownIds).not.toContain("solo");
  });

  it("lists members whose coordinator is gone as direct agents", () => {
    const orphaned = Subagents.deriveAgentPanelModel({
      agents: fold(
        progress("lost:wf:0", { title: "orphan", status: "running", parentAgentId: "lost" }),
      ),
    });
    expect(orphaned.workflows.length).toBe(0);
    expect(ids(orphaned.directAgents)).toEqual(["lost:wf:0"]);
  });
});

describe("labels", () => {
  it.each([
    [999, "999"],
    [12_340, "12.3k"],
    [512_000, "512k"],
    [2_600_000, "2.6M"],
  ])("token count %d reads %s", (tokens, label) => {
    expect(Subagents.formatSubagentTokenCount(tokens)).toBe(label);
  });

  it.each([
    ["claude-haiku-5[1m]", "max", "haiku-5[1m] · max"],
    ["claude-sonnet-4-20250929", null, "sonnet-4"],
    ["gpt-5.6-luna", "medium", "gpt-5.6-luna · medium"],
    [null, "max", null],
  ] as const)("model %s with effort %s reads %s", (model, effort, label) => {
    expect(Subagents.formatSubagentModelLabel(model, effort)).toBe(label);
  });
});
