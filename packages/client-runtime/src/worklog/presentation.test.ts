import { describe, expect, it } from "vite-plus/test";

import * as WorkLog from "./presentation.js";

type Entry = WorkLog.WorkLogPresentationEntry;
type Status = NonNullable<Parameters<typeof WorkLog.activityRowToolLook>[1]>;

const finished = { toolLifecycleStatus: "completed", tone: "tool" } as const;

/** A row for a call into Kora's own MCP server. */
const kora = (tool: string, extra: Partial<Entry> = {}): Entry => ({
  ...finished,
  label: "MCP tool call",
  itemType: "mcp_tool_call",
  toolData: { server: "kora-code", tool },
  ...extra,
});
const shell = (command: string): Entry => ({
  ...finished,
  label: "Ran command",
  itemType: "command_execution",
  command,
});
/** A command row that never reported a lifecycle. */
const bareShell = (command: string): Entry => ({
  tone: "tool",
  label: "Ran command",
  itemType: "command_execution",
  command,
});
const named = (label: string, extra: Partial<Entry> = {}) =>
  WorkLog.activityRowToolLook({ label, ...extra });
const displayName = (label: string, extra: Partial<Entry> = {}, assumed?: Status) =>
  WorkLog.activityRowToolLook({ label, ...extra }, assumed)?.displayName;

describe("failure and success detection", () => {
  const read = (extra: Partial<Entry>): Entry => ({ label: "Read", tone: "tool", ...extra });
  const fails = (entry: Entry) => WorkLog.workEntryIndicatesToolFailure(entry);

  it("counts an error tone or a failed lifecycle as failure, with or without detail", () => {
    expect(fails(read({ tone: "error", detail: "ordinary text" }))).toBe(true);
    expect(fails(read({ toolLifecycleStatus: "failed" }))).toBe(true);
  });

  it.each([
    ["a missing file", "Read", "File not found: D:\\proj\\missing.ts"],
    ["an empty glob", "Glob", "No files found"],
    [
      "an unknown PowerShell command",
      "Bash",
      "The term 'frobnicate' is not recognized as the name of a cmdlet, function, script file, or operable program.",
    ],
  ])("reads %s in the detail as failure", (_label, label, detail) => {
    expect(fails(read({ label, detail, toolLifecycleStatus: "completed" }))).toBe(true);
  });

  it("does not flag a successful find or an informational row", () => {
    expect(
      fails(read({ toolLifecycleStatus: "completed", detail: "Found 7 matching files" })),
    ).toBe(false);
    expect(
      fails({ label: "Context compacted", tone: "info", detail: "File not found in conversation" }),
    ).toBe(false);
  });

  it("judges the displayed detail apart from the command when deciding what to show", () => {
    const grep = shell('grep -r "no such file" src');
    const withOutput = { ...grep, detail: "4 matches" };
    expect(WorkLog.activityRowShowsFailure(withOutput)).toBe(false);
    // Older rows can keep output in the command, so the full check still sees it.
    expect(fails(withOutput)).toBe(true);
    expect(WorkLog.activityRowShowsFailure({ ...grep, detail: "No such file" })).toBe(true);
  });

  it("counts only finished tool rows as successes", () => {
    const succeeded = (extra: Partial<Entry>) => WorkLog.activityRowSucceeded(read(extra));
    expect(succeeded({ toolLifecycleStatus: "completed", detail: "ok" })).toBe(true);
    expect(succeeded({ toolLifecycleStatus: "inProgress", detail: "…" })).toBe(false);
    expect(succeeded({ toolLifecycleStatus: "stopped" })).toBe(false);
    expect(succeeded({ tone: "thinking", detail: "…" })).toBe(false);
  });
});

describe("Kora tool naming", () => {
  it.each([
    "mcp__kora-code__preview_click",
    "mcp__kora_code__preview_click",
    "mcp__kora__preview_click",
    "Kora-code.preview_click",
    "kora-code · preview_click completed",
    "kora_code/preview_click",
    "preview_click",
  ])("recognises the preview click tool spelled %j", (label) => {
    expect(named(label)).toEqual({
      displayName: "Clicking in the preview browser",
      icon: "browser",
    });
  });

  it("gives device tools the device icon", () => {
    expect(named("mcp__kora-code__device_open", { toolLifecycleStatus: "completed" })).toEqual({
      icon: "device",
      displayName: "Opened a device in the Device panel",
    });
    expect(named("kora-code · device_screenshot")).toEqual({
      icon: "device",
      displayName: "Taking a screenshot of the device",
    });
  });

  it("prefers the structured server/tool pair over a custom title", () => {
    const presentation = named("Tool call complete", {
      toolTitle: "Look at the page",
      toolData: { server: "kora-code", tool: "preview_snapshot", result: { title: "Home" } },
    });
    expect(presentation).toEqual({
      icon: "browser",
      displayName: "Taking a snapshot of the preview page",
    });
  });

  it.each([
    ["inProgress", "Clicking"],
    ["completed", "Clicked"],
    ["failed", "Failed to click"],
    ["declined", "Declined to click"],
    ["stopped", "Stopped clicking"],
    ["something-else", "Clicking"],
  ])("words lifecycle %s as %s …", (toolLifecycleStatus, verb) => {
    expect(named("Kora-code.preview_click", { toolLifecycleStatus })).toEqual({
      icon: "browser",
      displayName: `${verb} in the preview browser`,
    });
  });

  it("uses the group's assumed state only when the row has no lifecycle", () => {
    const label = "Kora-code.preview_click";
    expect(displayName(label, {}, "inProgress")).toBe("Clicking in the preview browser");
    expect(displayName(label, {}, "completed")).toBe("Clicked in the preview browser");
    expect(displayName(label, { toolLifecycleStatus: "completed" }, "inProgress")).toBe(
      "Clicked in the preview browser",
    );
    expect(displayName(label, { toolLifecycleStatus: "failed" }, "completed")).toBe(
      "Failed to click in the preview browser",
    );
  });

  it.each([
    ["preview_type", "Typing", "Typed", "in the preview browser"],
    ["preview_set_appearance", "Setting", "Set", "preview browser appearance"],
    ["preview_snapshot", "Taking a snapshot of", "Took a snapshot of", "the preview page"],
    ["preview_recording_stop", "Stopping", "Stopped", "recording the preview browser"],
    ["kora_thread_read", "Reading", "Read", "a Kora thread"],
    ["kora_thread_send", "Sending", "Sent", "to a Kora thread"],
    ["kora_worktree_handoff", "Handing off", "Handed off", "thread to a git worktree"],
  ])("inflects only the verb of %s", (tool, runningVerb, doneVerb, target) => {
    const label = `kora-code.${tool}`;
    const [running, done] = [runningVerb, doneVerb].map((verb) => `${verb} ${target}`);
    expect([
      displayName(label, { toolLifecycleStatus: "inProgress" }),
      displayName(label, { toolLifecycleStatus: "completed" }),
    ]).toEqual([running, done]);
  });

  it("names other Kora tools by their own wording, with the Kora icon", () => {
    expect(
      named("mcp__kora_code__task_status", { toolTitle: "See how the child is doing" }),
    ).toEqual({
      icon: "kora-code",
      displayName: "Getting delegated task status",
    });
  });

  it("does not brand unknown tools or look-alikes from other servers", () => {
    for (const label of [
      "mcp__other__preview_click",
      "kora-code.no_such_tool",
      "kora-code.valueOf",
      "Grep files",
    ]) {
      expect(named(label)).toBeNull();
    }
    expect(
      named("preview_click", { toolData: { server: "elsewhere", tool: "preview_click" } }),
    ).toBeNull();
  });
});

describe("pull request tools", () => {
  it.each([
    "mcp__kora-code__link_pull_request",
    "mcp__kora_code__link_pull_request",
    "Kora-code · link_pull_request",
    "kora/link_pull_request",
    "link_pull_request",
  ])("recognise the link tool spelled %j", (label) => {
    const entry: Entry = { label, tone: "tool", toolLifecycleStatus: "completed" };
    expect(named(label, { toolLifecycleStatus: "completed" })).toMatchObject({
      icon: "pull-request",
      displayName: "Linked a pull request",
    });
    expect(WorkLog.toolGroupAction(entry)).toBe("link-pr");
  });

  it.each([
    ["inProgress", "Linking PR #7"],
    ["completed", "Linked PR #7"],
    ["failed", "Failed to link PR #7"],
    ["declined", "Declined to link PR #7"],
    ["stopped", "Stopped linking PR #7"],
  ])("name the PR from its URL while %s", (toolLifecycleStatus, expected) => {
    const call = kora("link_pull_request", {
      toolTitle: "A custom title",
      toolLifecycleStatus,
      toolData: {
        server: "kora-code",
        tool: "link_pull_request",
        arguments: { url: "https://github.com/octo/site/pull/7" },
      },
    });
    expect(WorkLog.activityRowToolLook(call)?.displayName).toBe(expected);
  });

  it("read an unlink given as repository and number", () => {
    const unlink = named("MCP tool call", {
      toolLifecycleStatus: "completed",
      toolData: {
        toolName: "mcp__kora-code__unlink_pull_request",
        rawInput: { number: 7, repository: "octo/site" },
      },
    });
    expect(unlink).toMatchObject({
      action: "unlink-pr",
      icon: "pull-request",
      displayName: "Unlinked PR #7",
    });
  });

  it("are summarised apart from ordinary tools, even with an integration source", () => {
    const link: Entry = {
      ...finished,
      label: "Kora-code · link_pull_request",
      itemType: "mcp_tool_call",
      toolSource: { key: "kora-code", kind: "integration", name: "Kora" },
    };
    const check: Entry = { ...link, label: "Kora-code · list_thread_pull_requests" };
    expect(WorkLog.summarizeToolGroup([link, link, check])).toBe(
      "Linked 2 pull requests and checked linked pull requests",
    );
    expect(WorkLog.toolGroupSummaryKind([link, link, check])).toBe("pull-request");
    expect(
      WorkLog.summarizeToolGroup([{ ...link, label: "Kora-code · unlink_pull_request" }]),
    ).toBe("Unlinked 1 pull request");
    expect(WorkLog.summarizeToolGroup([check, check])).toBe("Checked linked pull requests 2 times");
    expect(named("mcp__other-server__link_pull_request")).toBeNull();
  });
});

describe("group summaries", () => {
  it.each(["command", "file-read", "file-change"])(
    "count %s approval traffic as updates, not tool runs",
    (requestKind) => {
      const step = (name: "requested" | "resolved"): Entry => ({
        requestKind,
        tone: "info",
        sourceActivityKind: `approval.${name}`,
        label: `Approval ${name}`,
      });
      const approvals: Entry[] = [
        step("requested"),
        step("resolved"),
        {
          tone: "error",
          label: "Provider approval response failed",
          sourceActivityKind: "provider.approval.respond.failed",
        },
      ];
      expect(WorkLog.summarizeToolGroup(approvals)).toBe("Received 3 updates");
      expect(WorkLog.toolGroupSummaryKind(approvals)).toBe("update");
      const withTool = [
        ...approvals,
        { label: "Read", tone: "tool" as const, itemType: "dynamic_tool_call" as const },
      ];
      expect(WorkLog.summarizeToolGroup(withTool)).toBe("Received 3 updates and used 1 tool");
    },
  );

  it("name a shared integration once, before ordinary actions", () => {
    const slack = { key: "app:slack", kind: "integration" as const, name: "Slack" };
    const rows: Entry[] = [
      { label: "Post message", tone: "tool", toolSource: slack },
      { label: "Read channel", tone: "tool", toolSource: slack },
      bareShell("git status"),
    ];
    expect(WorkLog.summarizeToolGroup(rows)).toBe("Used Slack integration and ran 1 command");
  });

  it("leave out the word integration for browser and computer sources", () => {
    const rows: Entry[] = [
      {
        label: "Inspect",
        tone: "tool",
        toolSource: { key: "browser-use", kind: "browser", name: "Browser" },
      },
      {
        label: "Type",
        tone: "tool",
        toolSource: { key: "computer-use", kind: "computer", name: "Computer Use" },
      },
    ];
    expect(WorkLog.summarizeToolGroup(rows)).toBe("Used Browser and Computer Use");
  });

  describe("browser calls", () => {
    const click = kora("preview_click");
    const lint = shell("/bin/zsh -lc 'pnpm lint'");

    it.each([1, 12])("count %i call(s) as browser use", (count) => {
      const rows = Array.from({ length: count }, (_, n) => ({ ...click, toolCallId: `b-${n}` }));
      expect(WorkLog.summarizeToolGroup(rows)).toBe(
        `Used browser ${count} ${count === 1 ? "time" : "times"}`,
      );
      expect(WorkLog.toolGroupSummaryKind(rows)).toBe("browser");
    });

    it("sit in one sentence with command counts", () => {
      const rows = [...Array(3).fill(lint), ...Array(9).fill(click)];
      expect(WorkLog.summarizeToolGroup(rows)).toBe("Ran 3 commands and used browser 9 times");
      expect(WorkLog.toolGroupSummaryKind(rows)).toBe("mixed");
    });

    it("keep first-appearance order next to other tools", () => {
      const status = { ...click, toolData: { server: "kora-code", tool: "task_status" } };
      expect(WorkLog.summarizeToolGroup([click, lint, status])).toBe(
        "Used browser 1 time, ran 1 command, and used 1 tool",
      );
    });

    it("are recognised from Claude's tool name even with a script-looking command", () => {
      const evaluate = {
        ...click,
        command: "node probe.js",
        toolData: { toolName: "mcp__kora_code__preview_evaluate" },
      };
      expect(WorkLog.summarizeToolGroup([evaluate])).toBe("Used browser 1 time");
    });

    it("do not include other servers' tools or web searches", () => {
      const rows: Entry[] = [
        click,
        {
          ...click,
          label: "preview_click",
          toolData: { server: "elsewhere", tool: "preview_click" },
        },
        { label: "Search", tone: "tool", itemType: "web_search" },
      ];
      expect(WorkLog.summarizeToolGroup(rows)).toBe(
        "Used browser 1 time, used 1 tool, and searched the web 1 time",
      );
    });
  });

  describe("device calls", () => {
    it.each(["device_list", "device_open", "device_screenshot", "device_close"])(
      "count %s as device control",
      (tool) => {
        expect(WorkLog.summarizeToolGroup([kora(tool)])).toBe("Used device controls 1 time");
        expect(WorkLog.toolGroupSummaryKind([kora(tool)])).toBe("device");
      },
    );

    it("are listed alongside commands", () => {
      const rows: Entry[] = [bareShell("ls"), kora("device_list"), kora("device_open")];
      expect(WorkLog.summarizeToolGroup(rows)).toBe(
        "Ran 1 command and used device controls 2 times",
      );
    });

    it("do not include another server's device-named tool", () => {
      const lookAlike = kora("device_open", {
        toolData: { server: "elsewhere", tool: "device_open" },
      });
      expect(WorkLog.summarizeToolGroup([lookAlike])).toBe("Used 1 tool");
    });
  });

  it("file a legacy Claude image view as a read", () => {
    const view: Entry = {
      viewedImagePath: "/repo/mock.png",
      itemType: "dynamic_tool_call",
      tone: "tool",
      label: "Tool call",
    };
    expect(WorkLog.toolGroupAction(view)).toBe("read");
  });
});

describe("command output and echoes", () => {
  it("joins Claude's text blocks and reads projected output", () => {
    const blocks = {
      result: { content: ["alpha", "beta"].map((text) => ({ type: "text", text })) },
    };
    expect(WorkLog.extractCommandOutputText(blocks)).toBe("alpha\nbeta");
    expect(WorkLog.extractCommandOutputText({ rawOutput: { content: "the projection" } })).toBe(
      "the projection",
    );
  });

  const bash = (detail: string, command = "echo hi") => ({
    detail,
    command,
    rawCommand: null,
    toolName: "Bash" as const,
    data: { command, toolName: "Bash" },
  });

  it("strips a detail only behind the matching tool name", () => {
    expect(WorkLog.commandDetailRepeatsCommand(bash("Bash: echo hi"))).toBe(true);
    expect(WorkLog.commandDetailRepeatsCommand(bash("note: echo hi"))).toBe(false);
  });

  it("recognises an echo that ingestion cut short", () => {
    const longCommand = `npm run build -- --filter "${"y".repeat(200)}"`;
    const cut = `Bash: ${longCommand}`.slice(0, 177) + "...";
    expect(WorkLog.commandDetailRepeatsCommand(bash(cut, longCommand))).toBe(true);
    expect(WorkLog.commandDetailRepeatsCommand(bash("Bash: echo hi...", "echo bye"))).toBe(false);
  });

  it("treats an ACP echo as synthetic when the row has a tool call id", () => {
    const acp = (data: Record<string, unknown>) =>
      WorkLog.commandDetailRepeatsCommand({
        detail: "make test",
        command: "make test",
        rawCommand: null,
        toolName: undefined,
        data,
      });
    expect(acp({ command: "make test", toolCallId: "call-1" })).toBe(true);
    expect(acp({ command: "make test" })).toBe(false);
  });
});
