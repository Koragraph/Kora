import { TurnId, type ChatThreadActivity } from "@kora/contracts";
import { activityRowToolLook } from "@kora/client-runtime/worklog/presentation";
import { describe, expect, it } from "vite-plus/test";

import { activityRowLabel } from "../../components/thread/ThreadTranscript.logic";
import { CLAUDE_NOT_SIGNED_IN_COPY } from "../../util/agentErrorCopy";
import { activityRowIndicatesToolNeutralStatus, activityRowSignalsSevereFailure } from "./entries";
import { deriveActivePlanState } from "./plans";
import { activity } from "./testActivities";
import { deriveActivityRows as workLog } from "./workLog";

const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map((r) => r.id);
const only = (activities: ChatThreadActivity[]) => {
  const rows = workLog(activities);
  expect(rows).toHaveLength(1);
  return rows[0]!;
};
/** A provider tool update (`tool.updated` while running, `tool.completed` at the end). */
const tool = (
  stage: "updated" | "completed",
  options: Parameters<typeof activity>[1] & { payload?: Record<string, unknown> } = {},
) => activity(`tool.${stage}`, options);
/** A command row as a provider reports it. */
const command = (payload: Record<string, unknown>, id = "cmd") =>
  tool("completed", {
    id,
    turn: "t1",
    summary: "Ran command",
    payload: { itemType: "command_execution", ...payload },
  });

describe("Kora's own tool calls (a call activity, then its tool_result)", () => {
  const call = (kind: string, itemId: string, summary: string, input: unknown, sequence: number) =>
    activity(kind, {
      sequence,
      summary,
      payload: { itemId, toolName: kind === "command_execution" ? "Bash" : "Write", input },
    });
  const result = (itemId: string, output: string, sequence: number, status = "completed") =>
    activity("tool_result", {
      sequence,
      summary: `tool ${status}`,
      payload: { itemId, status, output },
    });

  it("a Bash call and its result are one row: the command, its output, completed", () => {
    const row = only([
      call("command_execution", "k1", "$ pnpm test", { command: "pnpm test" }, 1),
      result("k1", "✓ 12 passed", 2),
    ]);
    expect(row).toMatchObject({
      itemType: "command_execution",
      command: "pnpm test",
      detail: "✓ 12 passed",
      toolLifecycleStatus: "completed",
    });
  });

  it("a Write is named by its file, with what was written as the body (not the tool's 'created' line)", () => {
    const write = call(
      "file_change",
      "k2",
      "Write src/a.ts",
      { file_path: "src/a.ts", content: "export {};\n" },
      1,
    );
    const row = only([write, result("k2", "File created successfully at: src/a.ts", 2)]);
    expect(row).toMatchObject({
      itemType: "file_change",
      changedFiles: ["src/a.ts"],
      detail: "export {};",
    });
  });

  it("an Edit that failed shows the failure, not the hunk", () => {
    const edit = call(
      "file_change",
      "k3",
      "Edit b.ts",
      { file_path: "b.ts", old_string: "x", new_string: "y" },
      1,
    );
    const row = only([edit, result("k3", "old_string not found", 2, "error")]);
    expect(row.toolLifecycleStatus).toBe("failed");
    expect(row.detail).toContain("old_string not found");
  });

  it("a result with no call row of its own is dropped when it worked and kept when it failed", () => {
    expect(workLog([result("lone", "spawned worker p1", 1)])).toEqual([]);
    const failed = only([result("lone2", "worker limit reached", 1, "error")]);
    expect(failed).toMatchObject({ tone: "error", toolLifecycleStatus: "failed" });
    expect(failed.detail).toContain("worker limit reached");
  });
});

describe("one row per tool call", () => {
  const read = (
    stage: "updated" | "completed",
    id: string,
    time: number,
    extra: Record<string, unknown> = {},
  ) =>
    tool(stage, {
      id,
      time,
      summary: stage === "completed" ? "Tool call completed" : "Tool call",
      payload: {
        itemType: "dynamic_tool_call",
        title: "Tool call",
        detail: 'Read: {"file_path":"app.ts"}',
        ...extra,
      },
    });

  it("updates fold into the final row, which keeps the details any update had", () => {
    const row = only([
      read("updated", "u1", 1),
      read("updated", "u2", 2, { data: { item: { command: ["sed", "-n", "1,9p", "app.ts"] } } }),
      read("completed", "done", 3),
    ]);
    expect(row).toMatchObject({
      id: "done",
      label: "Tool call completed",
      toolTitle: "Tool call",
      command: "sed -n 1,9p app.ts",
      detail: 'Read: {"file_path":"app.ts"}',
    });
  });

  it("the same call made again after it finished is a new row", () => {
    expect(
      ids(
        workLog([
          read("updated", "a1", 1),
          read("completed", "a2", 2),
          read("updated", "b1", 3),
          read("completed", "b2", 4),
        ]),
      ),
    ).toEqual(["a2", "b2"]);
  });

  it("a completion that sorts first among same-time rows still absorbs the update after it", () => {
    const row = only([
      tool("updated", {
        id: "z-early",
        time: 1,
        payload: { itemType: "dynamic_tool_call", title: "T" },
      }),
      tool("completed", {
        id: "a-done",
        time: 2,
        payload: { itemType: "dynamic_tool_call", title: "T" },
      }),
      tool("updated", {
        id: "z-late",
        time: 2,
        payload: { itemType: "dynamic_tool_call", title: "T" },
      }),
    ]);
    expect(row.id).toBe("a-done");
  });

  it("interleaved calls fold by call id", () => {
    const step = (stage: "updated" | "completed", call: string, time: number, data?: unknown) =>
      tool(stage, {
        id: `${call}-${stage}`,
        time,
        turn: "t1",
        payload: {
          itemType: "command_execution",
          toolCallId: call,
          status: stage === "updated" ? "inProgress" : "completed",
          ...(data ? { data } : {}),
        },
      });
    expect(
      workLog([
        step("updated", "A", 1, { command: "vp test" }),
        step("updated", "B", 2, { command: "vp lint" }),
        step("completed", "A", 3),
        step("completed", "B", 4),
      ]),
    ).toMatchObject([
      { id: "A-completed", toolCallId: "A", command: "vp test", toolLifecycleStatus: "completed" },
      { id: "B-completed", toolCallId: "B", command: "vp lint", toolLifecycleStatus: "completed" },
    ]);
  });

  it("a call id reused in another turn is another call", () => {
    const payload = { itemType: "command_execution", toolCallId: "same" };
    expect(
      workLog([
        tool("updated", { turn: "t1", time: 1, payload }),
        tool("completed", { turn: "t2", time: 2, payload }),
      ]),
    ).toHaveLength(2);
  });

  it("an older id-less completion folds into the update that had the id", () => {
    const row = only([
      read("updated", "r1", 1, {
        title: "View file",
        detail: "View file",
        data: { kind: "read", toolCallId: "r", rawInput: {} },
      }),
      read("completed", "r2", 2, { title: "View file", detail: "View file" }),
    ]);
    expect(row).toMatchObject({ id: "r2", toolTitle: "View file" });
    expect(row.detail).toBeUndefined();
  });

  it("keeps a viewed image's full path through a streamed read", () => {
    const imagePath = `/work/${"deep/".repeat(20)}shot.webp`;
    const payload = {
      itemType: "image_view",
      toolCallId: "img",
      detail: `${imagePath.slice(0, 60)}...`,
    };
    const row = only([
      tool("updated", { time: 1, payload: { ...payload, data: { imagePath } } }),
      tool("completed", { id: "img-done", time: 2, payload: { ...payload, data: {} } }),
    ]);
    expect(row).toMatchObject({
      id: "img-done",
      viewedImagePath: imagePath,
      itemType: "image_view",
    });
  });

  it("keeps an MCP call's own data, surface and icon from whichever update had them", () => {
    const item = {
      type: "mcpToolCall",
      server: "kora-code",
      status: "completed",
      tool: "preview_snapshot",
      arguments: { interactiveOnly: true },
    };
    const summary = "kora-code · preview_snapshot";
    const row = only([
      tool("updated", {
        summary,
        payload: {
          itemType: "mcp_tool_call",
          toolCallId: "m1",
          toolSurface: "browser",
          data: { item },
        },
      }),
      tool("completed", {
        summary,
        payload: {
          itemType: "mcp_tool_call",
          toolCallId: "m1",
          toolIcon: { _tag: "website", pageUrl: "https://example.com/r" },
        },
      }),
    ]);
    expect(row).toMatchObject({
      toolData: item,
      toolCallId: "m1",
      toolSurface: "browser",
      toolIcon: { _tag: "website", pageUrl: "https://example.com/r" },
    });
    expect(activityRowToolLook(row)?.displayName).toBe("Took a snapshot of the preview page");
  });

  it("is ordered by the daemon's sequence, not by time", () => {
    expect(
      ids(
        workLog([
          tool("completed", { id: "second", time: 3, sequence: 2 }),
          tool("completed", { id: "first", time: 4, sequence: 1 }),
        ]),
      ),
    ).toEqual(["first", "second"]);
  });

  it("rows of unchanged activities are the same objects next time (cheap to re-render)", () => {
    const run = (n: number, git: string) =>
      tool("completed", {
        id: `run-${n}`,
        sequence: n,
        time: new Date(1_700_000_000_000 + n).toISOString(),
        summary: "Ran command",
        payload: {
          title: "Shell",
          itemType: "command_execution",
          data: { toolCallId: `run-${n}`, item: { command: ["git", git] } },
        },
      });
    const many = Array.from({ length: 20_000 }, (_, n) => run(n, "status"));
    const before = workLog(many);
    const after = workLog([...many, run(many.length, "diff")]);
    expect(after).toHaveLength(20_001);
    expect(before.every((row, i) => after[i] === row)).toBe(true);
    expect(after.at(-1)).toMatchObject({
      id: `run-${many.length}`,
      command: "git diff",
      toolLifecycleStatus: "completed",
    });
  });
});

describe("a row's body", () => {
  it("drops a detail that only repeats the title", () => {
    const row = only([
      tool("completed", {
        summary: "View file",
        payload: { itemType: "dynamic_tool_call", title: "View file", detail: "View file" },
      }),
    ]);
    expect([row.toolTitle, row.detail]).toEqual(["View file", undefined]);
  });

  it("shows the first line a read returned", () => {
    const content =
      'import * as Effect from "effect/Effect"\nimport * as Layer from "effect/Layer"\n';
    const row = only([
      tool("completed", {
        payload: {
          itemType: "dynamic_tool_call",
          title: "View file",
          detail: "View file",
          data: { kind: "read", rawOutput: { content } },
        },
      }),
    ]);
    expect(row.detail).toBe('import * as Effect from "effect/Effect"');
  });

  it("shows a search's file count instead of its generic label", () => {
    const row = only([
      tool("completed", {
        summary: "rg",
        payload: {
          itemType: "web_search",
          title: "rg",
          detail: "rg",
          data: { rawOutput: { totalFiles: 19, truncated: false } },
        },
      }),
    ]);
    expect(row.detail).toBe("19 files");
  });

  it("lists the files a change touched, from wherever the tool put them", () => {
    const changes = [{ path: "src/ThreadView.tsx" }, { filename: "src/timeline.ts" }];
    const row = only([
      tool("completed", { payload: { itemType: "file_change", data: { item: { changes } } } }),
    ]);
    expect(row.changedFiles).toEqual(["src/ThreadView.tsx", "src/timeline.ts"]);
  });

  it("defaults a completion to completed, and reads a failed status", () => {
    expect(
      only([tool("completed", { payload: { itemType: "mcp_tool_call", detail: "3 files" } })])
        .toolLifecycleStatus,
    ).toBe("completed");
    expect(
      only([
        tool("updated", {
          payload: { itemType: "mcp_tool_call", detail: "none", status: "failed" },
        }),
      ]).toolLifecycleStatus,
    ).toBe("failed");
  });

  describe("for a command", () => {
    it.each([
      [
        "Codex's aggregated output, with the command unwrapped",
        {
          detail: "/bin/zsh -lc \"printf 'hi\\n'\"",
          data: {
            item: {
              command: "/bin/zsh -lc \"printf 'hi\\n'\"",
              aggregatedOutput: "hi\n<exited with exit code 0>",
            },
          },
        },
        { command: "printf 'hi\\n'", rawCommand: "/bin/zsh -lc \"printf 'hi\\n'\"", detail: "hi" },
      ],
      [
        "a projected output summary",
        {
          detail: "echo hi",
          data: { kind: "execute", command: "echo hi", rawOutput: { content: "hi there" } },
        },
        { command: "echo hi", detail: "hi there" },
      ],
      [
        "output that happens to equal the command",
        { detail: "echo hi", data: { command: "echo hi", rawOutput: { content: "echo hi" } } },
        { command: "echo hi", detail: "echo hi" },
      ],
      [
        "a detail-only output equal to the command (OpenCode)",
        { title: "bash", detail: "echo hi", data: { command: "echo hi" } },
        { command: "echo hi", detail: "echo hi" },
      ],
      [
        "Codex's result content, exit marker removed",
        {
          title: "bash",
          detail: '{"ok":1} <exited with exit code 0>',
          data: {
            item: {
              command: ["bun", "run", "dev"],
              result: { content: '{"ok":1} <exited with exit code 0>' },
            },
          },
        },
        { command: "bun run dev", detail: '{"ok":1}' },
      ],
    ])("shows %s", (_, payload, expected) => {
      expect(only([command({ title: "Ran command", ...payload })])).toMatchObject(expected);
    });

    it.each([
      [
        "a 'Bash: …' echo of the command",
        {
          title: "Command run",
          detail: "Bash: echo hi",
          data: { toolName: "Bash", command: "echo hi" },
        },
      ],
      [
        "a truncated echo of a long command",
        {
          title: "Command run",
          detail: `Bash: git commit -m "${"x".repeat(200)}"`.slice(0, 177) + "...",
          data: { toolName: "Bash", command: `git commit -m "${"x".repeat(200)}"` },
        },
      ],
      [
        "a terminal echo without a tool kind",
        { title: "Terminal", detail: "pnpm test", data: { toolCallId: "c", command: "pnpm test" } },
      ],
      [
        "an echo of a command with no output",
        { title: "Ran command", detail: "true", data: { kind: "execute", command: "true" } },
      ],
    ])("hides %s", (_, payload) => {
      const row = only([command(payload)]);
      expect(row.command).toBeDefined();
      expect(row.detail).toBeUndefined();
    });

    it("does not mistake stdout for the command when the input was left out", () => {
      const row = only([
        command({
          title: "Ran command",
          data: {
            kind: "execute",
            rawInput: {},
            rawOutput: { stdout: "total 9\napps\n", exitCode: 0 },
          },
        }),
      ]);
      expect([row.command, row.detail]).toEqual([undefined, undefined]);
    });

    it.each([
      ["bash script.sh", "bash script.sh", undefined],
      [
        "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
        "bun run lint",
        "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
      ],
    ])("%s reads as %s", (line, shown, raw) => {
      const row = only([command({ data: { item: { command: line } } })]);
      expect([row.command, row.rawCommand]).toEqual([shown, raw]);
    });
  });
});

describe("what gets no row", () => {
  it.each([
    [
      "fold-only progress",
      [
        activity("task.updated", { payload: { taskId: "x", status: "running" } }),
        activity("tool.progress", { payload: { taskId: "x" } }),
      ],
    ],
    ["a tool start", [activity("tool.started")]],
    ["the context meter's updates", [activity("context-window.updated", { tone: "info" })]],
    ["a checkpoint", [activity("tool.started", { summary: "Checkpoint captured", tone: "info" })]],
    [
      "an approval that was allowed",
      [
        activity("approval.requested", { payload: { requestId: "r" } }),
        activity("approval.resolved", { payload: { requestId: "r", decision: "accept" } }),
      ],
    ],
    [
      "routine setup before the work",
      [
        activity("setup-script.requested", { tone: "info", sequence: 1 }),
        activity("setup-script.started", { tone: "info", sequence: 2 }),
      ],
    ],
  ])("%s", (_, activities) => {
    expect(workLog(activities)).toEqual([]);
  });

  it("ExitPlanMode (the plan card shows it), next to real work", () => {
    const rows = workLog([
      tool("updated", {
        id: "x1",
        time: 1,
        payload: { detail: 'ExitPlanMode: {"allowedPrompts":[]}' },
      }),
      tool("completed", { id: "x2", time: 2, payload: { detail: "ExitPlanMode: {}" } }),
      command({ detail: "Bash: bun test" }, "real"),
    ]);
    expect(ids(rows)).toEqual(["real"]);
  });

  it("plan updates (the to-do list shows them), which still drive the plan", () => {
    const plan = (status: string, sequence: number) =>
      activity("turn.plan.updated", {
        sequence,
        turn: "t1",
        payload: { plan: [{ step: "Check", status }] },
      });
    const all = [
      tool("completed", { id: "before", sequence: 0 }),
      plan("inProgress", 1),
      plan("completed", 2),
      tool("completed", { id: "after", sequence: 3 }),
    ];
    expect(ids(workLog(all))).toEqual(["before", "after"]);
    expect(deriveActivePlanState(all, TurnId.make("t1"))?.steps).toMatchObject([
      { step: "Check", status: "completed" },
    ]);
  });

  it("warnings with nothing to show, unlike ones that say something", () => {
    const rows = workLog([
      activity("runtime.warning", {
        id: "noise",
        time: 1,
        tone: "info",
        summary: "Claude system message 'x' (no displayable text content)",
      }),
      activity("runtime.warning", {
        id: "signal",
        time: 2,
        tone: "info",
        summary: "Back online in 3s",
      }),
    ]);
    expect(ids(rows)).toEqual(["signal"]);
  });

  it("but a failed setup, an unrelated notice and context compaction do", () => {
    const rows = workLog([
      activity("setup-script.requested", { tone: "info", sequence: 1 }),
      activity("setup-script.failed", {
        id: "setup",
        tone: "error",
        sequence: 2,
        summary: "Setup failed to start",
        payload: { detail: "No terminal" },
      }),
      activity("runtime.warning", {
        id: "notice",
        tone: "info",
        sequence: 3,
        summary: "Reconnecting",
      }),
      activity("context-compaction", {
        id: "compact",
        tone: "info",
        sequence: 4,
        summary: "Context compacted",
      }),
    ]);
    expect(rows).toMatchObject([
      {
        id: "setup",
        tone: "error",
        label: "Setup failed to start",
        detail: "No terminal",
        turnId: null,
      },
      { id: "notice", label: "Reconnecting" },
      { id: "compact", label: "Context compacted" },
    ]);
  });

  it("a denied request leaves one line saying what was refused", () => {
    const rows = workLog([
      activity("approval.requested", {
        tone: "approval",
        payload: {
          requestId: "r1",
          requestKind: "file-change",
          args: { file_path: "calc.py", old_string: "a", new_string: "b" },
        },
      }),
      activity("approval.resolved", { payload: { requestId: "r1", decision: "decline" } }),
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Denied: calc.py  (+1 -1)"]);
  });
});

describe("tasks and subagents", () => {
  const agentTask = (kind: string, taskId: string, extra: Parameters<typeof activity>[1] = {}) =>
    activity(kind, { tone: "info", ...extra, payload: { taskId, ...extra.payload } });

  it("a task row is labelled by its summary, or else its detail (keeping an error's tone)", () => {
    expect(
      only([
        activity("task.progress", {
          tone: "info",
          summary: "Reasoning",
          payload: { summary: "Searching endpoints" },
        }),
      ]).label,
    ).toBe("Searching endpoints");
    expect(
      only([
        activity("task.completed", {
          tone: "error",
          summary: "Task failed",
          payload: { detail: "Deploy failed" },
        }),
      ]),
    ).toMatchObject({ label: "Deploy failed", tone: "error" });
  });

  it("a plain task's start is not shown, its progress and end are", () => {
    const rows = workLog([
      activity("task.started", { id: "s", time: 1, tone: "info" }),
      activity("task.progress", { id: "p", time: 2, tone: "info" }),
      activity("task.completed", { id: "c", time: 3, tone: "info" }),
    ]);
    expect(ids(rows)).toEqual(["p", "c"]);
  });

  it("a subagent's background shell stays out; bypassed agent rows fold into one batch row", () => {
    expect(
      workLog([
        agentTask("task.progress", "sh", {
          payload: { taskType: "local_bash", timelineBypass: true },
        }),
      ]),
    ).toEqual([]);
    const row = only([
      agentTask("task.progress", "kid-1", { turn: "spawn", payload: { timelineBypass: true } }),
      agentTask("task.progress", "kid-2", { turn: "spawn", payload: { timelineBypass: true } }),
    ]);
    expect(row.agentSpawn?.agentTaskIds).toEqual(["kid-1", "kid-2"]);
  });

  it("a workflow run and its members are one row; a second run is another", () => {
    const rows = workLog([
      agentTask("task.progress", "wf-a", {
        sequence: 1,
        turn: "t1",
        payload: { taskType: "local_workflow", workflowName: "check" },
      }),
      agentTask("task.progress", "wf-a:wf:0", {
        sequence: 2,
        turn: "t1",
        payload: { parentAgentId: "wf-a" },
      }),
      agentTask("task.completed", "wf-a:wf:1", {
        sequence: 3,
        turn: "t1",
        payload: { parentAgentId: "wf-a", status: "completed" },
      }),
      agentTask("task.progress", "wf-b", {
        sequence: 4,
        turn: "t2",
        payload: { taskType: "local_workflow", workflowName: "check" },
      }),
    ]);
    const batches = rows.filter((r) => r.agentSpawn);
    expect(batches.map((r) => [r.agentSpawn!.workflowId, r.turnId])).toEqual([
      ["wf-a", "t1"],
      ["wf-b", "t2"],
    ]);
    expect(batches[0]!.agentSpawn!.agentTaskIds).toEqual(
      expect.arrayContaining(["wf-a", "wf-a:wf:0", "wf-a:wf:1"]),
    );
  });

  it("agents that lost their turn are not batched together", () => {
    const rows = workLog([
      agentTask("task.started", "lost-1", { sequence: 1, payload: { taskType: "local_agent" } }),
      agentTask("task.started", "lost-2", { sequence: 2, payload: { taskType: "local_agent" } }),
    ]);
    expect(rows.map((r) => r.agentSpawn?.agentTaskIds)).toEqual([["lost-1"], ["lost-2"]]);
  });

  it("five launches in one turn become one batch row, and the agents' own tool calls stay out", () => {
    const stream: ChatThreadActivity[] = [];
    for (let n = 0; n < 5; n++) {
      stream.push(
        tool("updated", {
          sequence: n - 10,
          turn: "batch",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            status: "inProgress",
            toolCallId: `launch-${n}`,
            data: { toolName: n % 2 ? "Task" : "Agent" },
          },
        }),
      );
      expect(workLog(stream)).toEqual([]); // a running launch waits for its agent's row
    }
    for (let n = 0; n < 5; n++) {
      const taskId = `agent-${n}`;
      const toolUseId = `launch-${n}`;
      stream.push(
        agentTask("task.started", taskId, {
          id: `start-${n}`,
          sequence: n * 20 - 1,
          turn: "batch",
          payload: { toolUseId, taskType: "local_agent" },
        }),
      );
      const now = workLog(stream);
      expect(now).toHaveLength(1);
      expect(now[0]!.id).toBe("start-0");
      expect(now[0]!.agentSpawn?.agentTaskIds).toHaveLength(n + 1);
      for (let tick = 0; tick < 3; tick++) {
        stream.push(
          agentTask("task.progress", taskId, {
            sequence: n * 20 + tick,
            turn: "batch",
            payload: { toolUseId, summary: `step ${tick}`, role: "explorer" },
          }),
        );
        stream.push(
          tool("completed", {
            sequence: n * 20 + 10 + tick,
            summary: "Read",
            payload: { itemType: "dynamic_tool_call", agentId: taskId },
          }),
        );
      }
      stream.push(
        agentTask("task.completed", taskId, {
          sequence: n * 20 + 19,
          turn: "batch",
          payload: { toolUseId, status: "completed", role: "explorer" },
        }),
        tool("completed", {
          sequence: n * 20 + 19,
          turn: "batch",
          summary: "Subagent task",
          payload: { toolCallId: toolUseId, status: "completed" },
        }),
      );
    }
    const rows = workLog(stream);
    const batches = rows.filter((r) => r.agentSpawn);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.agentSpawn).toMatchObject({
      workflowId: null,
      agentTaskIds: expect.any(Array),
    });
    expect(batches[0]!.agentSpawn!.agentTaskIds).toHaveLength(5);
    expect(rows.some((r) => r.sourceActivityKind?.startsWith("tool."))).toBe(false);
  });

  it("keeps other tools, failed launches (even after their agent started) and erroring launches", () => {
    const rows = workLog([
      tool("completed", {
        summary: "Bash",
        payload: { itemType: "command_execution", command: "ls" },
      }),
      tool("completed", {
        id: "fail-unlinked",
        tone: "error",
        summary: "Subagent task",
        payload: { toolCallId: "u", status: "failed" },
      }),
      agentTask("task.started", "agent", {
        id: "agent-start",
        tone: "tool",
        payload: { toolUseId: "linked", taskType: "local_agent" },
      }),
      tool("completed", {
        id: "fail-linked",
        summary: "Subagent task",
        payload: { toolCallId: "linked", status: "failed" },
      }),
      tool("completed", {
        id: "orphan",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          toolCallId: "o",
          status: "completed",
          data: { toolName: "Agent" },
        },
      }),
      tool("updated", {
        id: "send-input",
        payload: {
          itemType: "collab_agent_tool_call",
          toolCallId: "s",
          status: "inProgress",
          data: { toolName: "send_input" },
        },
      }),
      tool("updated", {
        id: "launch-error",
        tone: "error",
        payload: {
          itemType: "collab_agent_tool_call",
          toolCallId: "e",
          status: "inProgress",
          data: { toolName: "Task" },
        },
      }),
    ]);
    expect(rows).toHaveLength(7);
    expect(ids(rows)).toEqual(
      expect.arrayContaining(["fail-unlinked", "agent-start", "fail-linked", "launch-error"]),
    );
  });
});

describe("runtime errors and warnings", () => {
  const diagnostic =
    "2026-03-14T16:11:12Z ERROR codex_core::codex: failed to load skill /home/dev/.agent/skills/x/SKILL.md: invalid YAML: mapping va...";
  const runtime = (kind: string, extra: Parameters<typeof activity>[1] = {}) =>
    activity(kind, {
      turn: "t1",
      tone: "error",
      summary: "Runtime error",
      payload: { message: diagnostic },
      ...extra,
    });

  it("the daemon's underscore spellings read as the dotted kinds", () => {
    const warning = only([
      runtime("runtime_warning", {
        tone: "info",
        payload: {},
        summary: "Can't reach Claude. Retrying.",
      }),
    ]);
    expect(warning.sourceActivityKind).toBe("runtime.warning");
    const error = only([
      runtime("runtime_error", { payload: {}, summary: "Not logged in · Please run /login" }),
    ]);
    expect(error.sourceActivityKind).toBe("runtime.error");
    expect(activityRowSignalsSevereFailure(error)).toBe(true);
    expect(error.label).toBe(CLAUDE_NOT_SIGNED_IN_COPY);
  });

  it("the full message shows past a truncated or generic label, and is not repeated when the label says it", () => {
    const error = only([runtime("runtime.error")]);
    expect(error).toMatchObject({ label: "Runtime error", detail: diagnostic });
    expect(activityRowLabel(error, undefined)).toBe(diagnostic);
    const warning = only([
      runtime("runtime.warning", { tone: "info", summary: diagnostic.slice(0, 90) }),
    ]);
    expect(warning.detail).toBe(diagnostic);
    const same = only([
      runtime("runtime.warning", {
        tone: "info",
        summary: "Back online in 3s",
        payload: { message: "Back online in 3s" },
      }),
    ]);
    expect(same.detail).toBeUndefined();
  });

  it("a detail the error came with wins; a non-runtime row never reads `message`", () => {
    expect(
      only([
        runtime("runtime.error", {
          payload: { message: diagnostic, detail: "Run claude auth login." },
        }),
      ]).detail,
    ).toBe("Run claude auth login.");
    expect(
      only([runtime("tool.completed", { tone: "tool", summary: "Read file" })]).detail,
    ).toBeUndefined();
  });
});

describe("neutral rows (neither success nor failure shown)", () => {
  it.each([
    ["waiting", "inProgress"],
    ["cancelled", "stopped"],
    ["interrupted", "stopped"],
  ])("a %s background task", (status, lifecycle) => {
    const row = only([
      activity("task.progress", { payload: { taskId: "bg", agentKind: "background", status } }),
    ]);
    expect(row.toolLifecycleStatus).toBe(lifecycle);
    expect(activityRowIndicatesToolNeutralStatus(row)).toBe(true);
  });

  it("a running tool is neutral; a finished one, or a batch row, is not", () => {
    const running = {
      id: "w",
      createdAt: "2026-01-01T00:00:00Z",
      toolLifecycleStatus: "inProgress" as const,
      label: "Read",
      tone: "tool" as const,
    };
    expect(activityRowIndicatesToolNeutralStatus(running)).toBe(true);
    expect(
      activityRowIndicatesToolNeutralStatus({ ...running, toolLifecycleStatus: "completed" }),
    ).toBe(false);
    expect(
      activityRowIndicatesToolNeutralStatus({
        ...running,
        agentSpawn: { workflowId: null, agentTaskIds: ["a"] },
      }),
    ).toBe(false);
  });
});

it.each([
  ["failed", "Failed to click in the preview browser"],
  ["completed", "Clicked in the preview browser"],
  ["inProgress", "Clicking in the preview browser"],
] as const)(
  "an MCP call behind a generic title keeps its identity while %s",
  (status, displayName) => {
    const data = {
      toolName: "mcp__kora_code__preview_click",
      input: { selector: "#go" },
      ...(status === "inProgress"
        ? {}
        : { result: { type: "tool_result", is_error: status === "failed", content: "ok" } }),
    };
    const row = only([
      tool(status === "inProgress" ? "updated" : "completed", {
        summary: "MCP tool call",
        payload: { itemType: "mcp_tool_call", title: "MCP tool call", status, data },
      }),
    ]);
    expect(row).toMatchObject({ toolTitle: "MCP tool call", toolData: data });
    expect(activityRowToolLook(row)).toEqual({ icon: "browser", displayName });
  },
);
