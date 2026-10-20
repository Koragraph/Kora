import type { FleetWorker, WorkerFeedItem } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentIdentity,
  defaultMinimized,
  formatElapsed,
  isExecTool,
  lastActionText,
  retryCountdown,
  settleDoneDefaults,
  splitPinnedApprovals,
  trafficLights,
  workerBodyMode,
  workerBoxLayout,
  workerDoingLine,
  workerElapsed,
  workerHasTerminalToggle,
  workerStatePill,
  workerSubline,
  workerWindowTabs,
} from "./workerBoxes.logic";

const worker = (over: Partial<FleetWorker>): FleetWorker =>
  ({
    paneId: "p1",
    terminalId: "worker:p1",
    agent: "claude",
    account: null,
    title: "Add retry",
    state: "working",
    blocker: null,
    steered: false,
    steeredAt: null,
    cwd: "/x",
    worktree: null,
    costUsd: null,
    contextPct: null,
    exitCode: null,
    createdAt: 0,
    lastOutputAt: 0,
    ...over,
  }) as FleetWorker;

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const none = new Set<string>();

describe("workerBoxLayout", () => {
  it("1 = one full box, 2 = two rows, 3 = 2×2 with the last spanning, 4 = 2×2", () => {
    expect(workerBoxLayout({ paneIds: ids(1), minimized: none })).toMatchObject({
      open: ["p1"],
      columns: 1,
      rows: 1,
    });
    expect(workerBoxLayout({ paneIds: ids(2), minimized: none })).toMatchObject({
      columns: 1,
      rows: 2,
    });
    expect(workerBoxLayout({ paneIds: ids(3), minimized: none })).toMatchObject({
      columns: 2,
      rows: 2,
      spanLast: true,
    });
    expect(workerBoxLayout({ paneIds: ids(4), minimized: none })).toMatchObject({
      columns: 2,
      rows: 2,
      spanLast: false,
      strips: [],
    });
  });

  it("5+ keeps four boxes and turns the rest into strips", () => {
    const l = workerBoxLayout({ paneIds: ids(6), minimized: none });
    expect(l.open).toEqual(["p1", "p2", "p3", "p4"]);
    expect(l.strips).toEqual(["p5", "p6"]);
  });

  it("minimized boxes become strips and the grid reflows over the rest", () => {
    const l = workerBoxLayout({ paneIds: ids(5), minimized: new Set(["p2", "p3"]) });
    expect(l.open).toEqual(["p1", "p4", "p5"]);
    expect(l.strips).toEqual(["p2", "p3"]);
    expect(l.columns).toBe(2);
  });

  it("an expanded box fills the dock; a stale expanded id is ignored; narrow stacks", () => {
    expect(workerBoxLayout({ paneIds: ids(4), minimized: none, expanded: "p3" })).toMatchObject({
      open: ["p3"],
      strips: [],
      expanded: "p3",
    });
    expect(
      workerBoxLayout({ paneIds: ids(2), minimized: none, expanded: "gone" }).open,
    ).toHaveLength(2);
    expect(workerBoxLayout({ paneIds: ids(4), minimized: none, narrow: true })).toMatchObject({
      columns: 1,
      rows: 4,
    });
  });

  it("finished boxes start minimized unless an unmerged branch is waiting", () => {
    const tree = { path: "/w", branch: "kora/w1", mainRoot: "/m", ahead: 2 };
    expect(defaultMinimized(worker({ state: "working" }), false)).toBe(false);
    expect(defaultMinimized(worker({ state: "exited", exitCode: 0 }), false)).toBe(true);
    expect(defaultMinimized(worker({ state: "exited", exitCode: 0, worktree: tree }), false)).toBe(
      false,
    );
    expect(defaultMinimized(worker({ state: "exited", exitCode: 0, worktree: tree }), true)).toBe(
      true,
    );
  });
});

describe("workerBodyMode", () => {
  const swarm = { taskId: "t1" } as NonNullable<FleetWorker["swarm"]>;

  it("follows surface live: terminal until the snapshot says gui, then the feed", () => {
    const before = worker({ agent: "opencode", swarm });
    expect(workerBodyMode(before, false)).toBe("terminal");
    expect(workerBodyMode({ ...before, surface: "terminal" }, false)).toBe("terminal");
    expect(workerBodyMode({ ...before, surface: "gui" }, false)).toBe("feed");
    expect(workerBodyMode(worker({ state: "asleep", surface: "gui" }), false)).toBe("history");
  });

  it("only a GUI swarm pane can toggle to its terminal; a DriverPane cannot", () => {
    const pane = worker({ agent: "opencode", swarm, surface: "gui" });
    expect(workerHasTerminalToggle(pane)).toBe(true);
    expect(workerBodyMode(pane, true)).toBe("terminal");
    const driver = worker({ surface: "gui" });
    expect(workerHasTerminalToggle(driver)).toBe(false);
    expect(workerBodyMode(driver, true)).toBe("feed");
    expect(workerHasTerminalToggle(worker({ agent: "opencode", swarm }))).toBe(false);
  });
});

describe("workerStatePill", () => {
  it("covers every state, in priority order", () => {
    expect(workerStatePill(worker({}))).toEqual({ kind: "working", label: "Working" });
    expect(workerStatePill(worker({ state: "idle" })).kind).toBe("idle");
    expect(workerStatePill(worker({ state: "blocked" })).label).toBe("Needs you");
    expect(
      workerStatePill(worker({ pendingApproval: { requestId: "r", title: "Run pnpm test?" } }))
        .kind,
    ).toBe("needs");
    expect(workerStatePill(worker({ state: "asleep" })).label).toBe("Asleep");
    expect(workerStatePill(worker({ state: "exited", exitCode: 0 })).label).toBe("Done");
    expect(workerStatePill(worker({ state: "exited", exitCode: 2 })).label).toBe("Failed (exit 2)");
    // A key dropped off the wire (undefined, not null) never prints "exit undefined".
    expect(
      workerStatePill(worker({ state: "exited", exitCode: undefined as unknown as number })).label,
    ).not.toMatch(/undefined/);
  });

  it("retrying beats needs-you; stopped beats everything", () => {
    const retrying = { attempt: 1, max: 3, message: "stream stopped", nextAt: 5000 };
    expect(workerStatePill(worker({ retrying, state: "blocked" }))).toEqual({
      kind: "retrying",
      label: "Retrying 1/3",
    });
    expect(
      workerStatePill(worker({ retrying, stoppedByUser: true, state: "exited", exitCode: 143 }))
        .label,
    ).toBe("Stopped");
  });
});

describe("a finished turn (live, idle, answer ready)", () => {
  const done = worker({ state: "idle", turnEndedAt: 65_000, createdAt: 0 });

  it("reads Done, not Idle, and its clock stops at the end of the turn", () => {
    expect(workerStatePill(done)).toEqual({ kind: "done", label: "Done" });
    expect(workerElapsed(done, 154_000)).toBe("1m 05s");
    expect(workerStatePill(worker({ state: "idle" }))).toEqual({ kind: "idle", label: "Idle" });
  });

  it("an idle worker stopped on an API error says so", () => {
    expect(workerStatePill(worker({ state: "idle", stoppedOnError: "API Error: 500" }))).toEqual({
      kind: "failed",
      label: "Stopped on error",
    });
  });

  it("collapses to a strip only while another worker is still working", () => {
    expect(defaultMinimized(done, false, true)).toBe(true);
    expect(defaultMinimized(done, false, false)).toBe(false);
    expect(defaultMinimized(worker({ state: "idle" }), false, true)).toBe(false);
  });

  it("a done worker with unmerged commits keeps its box (and Merge card) open", () => {
    const wt = { path: "/w", branch: "kora/x", mainRoot: "/r", ahead: 2 };
    const unmerged = worker({ state: "idle", turnEndedAt: 1, worktree: wt });
    expect(defaultMinimized(unmerged, false, true)).toBe(false);
    expect(defaultMinimized(unmerged, true, true)).toBe(true);
  });

  it("keeps its Merge card in view while its branch has unmerged commits", () => {
    const tree = { path: "/w", branch: "kora/p1", mainRoot: "/x", ahead: 2, dirty: 0 };
    const withCommits = worker({ state: "idle", turnEndedAt: 65_000, worktree: tree });
    expect(defaultMinimized(withCommits, false, true)).toBe(false);
    expect(defaultMinimized(withCommits, true, true)).toBe(true);
    const empty = worker({ state: "idle", turnEndedAt: 65_000, worktree: { ...tree, ahead: 0 } });
    expect(defaultMinimized(empty, false, true)).toBe(true);
  });

  it("stops the clock on a worker stopped on an error", () => {
    const stopped = worker({
      state: "idle",
      stoppedOnError: "API Error: 500",
      createdAt: 0,
      lastOutputAt: 30_000,
    });
    expect(workerElapsed(stopped, 500_000)).toBe("30s");
  });

  it("decides a done box's default once per turn end, not on every snapshot", () => {
    const a = worker({ paneId: "a", state: "idle", turnEndedAt: 10 });
    const b = worker({ paneId: "b", state: "working" });
    const first = settleDoneDefaults(new Map(), [a, b], new Set());
    expect(first.get("a")?.minimized).toBe(true);
    // b finishes: a keeps its strip instead of expanding with everyone else.
    const bDone = worker({ paneId: "b", state: "idle", turnEndedAt: 20 });
    const second = settleDoneDefaults(first, [a, bDone], new Set());
    expect(second.get("a")?.minimized).toBe(true);
    expect(second.get("b")?.minimized).toBe(false);
    // a is re-prompted and then finishes again with nobody working: decided afresh.
    const third = settleDoneDefaults(second, [{ ...a, turnEndedAt: 30 }, bDone], new Set());
    expect(third.get("a")?.minimized).toBe(false);
    // b works again: b drops out, a keeps what it had.
    const fourth = settleDoneDefaults(third, [{ ...a, turnEndedAt: 30 }, b], new Set());
    expect(fourth.has("b")).toBe(false);
    expect(fourth.get("a")?.minimized).toBe(false);
  });
});

describe("agentIdentity", () => {
  it("gives each agent its own shape and brand", () => {
    expect(agentIdentity("claude")).toMatchObject({
      family: "claude",
      radius: 18,
      brand: "#d97757",
    });
    expect(agentIdentity("codex")).toMatchObject({ family: "codex", radius: 6 });
    expect(agentIdentity("antigravity")).toMatchObject({
      family: "agy",
      radius: 12,
      brand: "#6ea0ff",
    });
    expect(agentIdentity("opencode")).toMatchObject({
      family: "swarm",
      radius: 10,
      brand: "#e3b341",
    });
    expect(agentIdentity("koragent").family).toBe("swarm");
    expect(agentIdentity("gemini")).toMatchObject({ family: "acp", radius: 14, brand: "#8ab4f8" });
    expect(agentIdentity("cursor")).toMatchObject({ family: "acp", name: "Cursor" });
  });
});

describe("time and last action", () => {
  it("formats elapsed and freezes it once done", () => {
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(252_000)).toBe("4m 12s");
    expect(formatElapsed(3_840_000)).toBe("1h 04m");
    expect(workerElapsed(worker({ createdAt: 0 }), 90_000)).toBe("1m 30s");
    expect(workerElapsed(worker({ state: "exited", lastOutputAt: 10_000 }), 90_000)).toBe("10s");
  });

  it("counts the retry down, never below zero", () => {
    expect(retryCountdown(5_000, 1_200)).toBe(4);
    expect(retryCountdown(5_000, 9_000)).toBe(0);
    expect(retryCountdown(null, 0)).toBeNull();
  });

  it("the strip shows the newest thing that says something", () => {
    const items: WorkerFeedItem[] = [
      { id: "a", at: 1, kind: "assistant", text: "Looking at it\nmore", streaming: false },
      {
        id: "t",
        at: 2,
        kind: "tool",
        tool: "Bash",
        title: "Bash pnpm test",
        detail: null,
        status: "running",
        added: null,
        removed: null,
      },
      { id: "u", at: 3, kind: "user", text: "steer", source: "human" },
    ];
    expect(lastActionText(worker({}), items)).toBe("Bash pnpm test");
    expect(lastActionText(worker({}), items.slice(0, 1))).toBe("Looking at it");
    expect(lastActionText(worker({ blocker: "trust dialog" }), [])).toBe("trust dialog");
  });
});

describe("workerDoingLine (the sprite window's title line)", () => {
  const step: WorkerFeedItem = {
    id: "t",
    at: 2,
    kind: "tool",
    tool: "Read",
    title: "Read letta.com/pricing",
    detail: null,
    status: "running",
    added: null,
    removed: null,
  };

  it("working: the latest step, no state word and never the model", () => {
    expect(workerDoingLine(worker({ model: "claude-sonnet-5-5" }), [step])).toEqual({
      text: "Read letta.com/pricing",
      tone: null,
    });
    expect(workerDoingLine(worker({}), [])).toEqual({ text: "Working", tone: null });
  });

  it("needs you is amber and says what it asks", () => {
    const w = worker({
      state: "blocked",
      pendingApproval: { requestId: "r", title: "Run npm view gitnexus" },
    } as Partial<FleetWorker>);
    expect(workerDoingLine(w, [step])).toEqual({
      text: "Needs you · Run npm view gitnexus",
      tone: "attn",
    });
  });

  it("stopped on an error is red and gives the reason; done says so first", () => {
    expect(
      workerDoingLine(worker({ state: "idle", stoppedOnError: "usage limit until 3pm" }), []),
    ).toEqual({ text: "Stopped on error · usage limit until 3pm", tone: "bad" });
    expect(workerDoingLine(worker({ state: "idle", turnEndedAt: 5 }), [step])).toEqual({
      text: "Done · Read letta.com/pricing",
      tone: null,
    });
  });
});

describe("window chrome", () => {
  const acts = (lights: ReturnType<typeof trafficLights>) => lights.map((l) => l.act);

  it("traffic lights are stop · minimize · zoom, in that order, in both variants", () => {
    for (const variant of ["box", "window"] as const) {
      expect(acts(trafficLights(worker({}), { variant, zoomed: false, stopArmed: false }))).toEqual(
        ["stop", "minimize", "zoom"],
      );
    }
  });

  it("labels follow the variant and the zoom state", () => {
    const box = trafficLights(worker({}), { variant: "box", zoomed: false, stopArmed: false });
    expect(box.map((l) => l.label)).toEqual(["Stop worker", "Minimize", "Expand"]);
    const boxZoomed = trafficLights(worker({}), { variant: "box", zoomed: true, stopArmed: false });
    expect(boxZoomed[2]).toMatchObject({
      label: "Back to the grid",
      hint: "Back to the grid (Esc)",
    });
    const win = trafficLights(worker({}), { variant: "window", zoomed: false, stopArmed: false });
    expect(win.map((l) => l.label)).toEqual([
      "Stop worker",
      "Minimize worker window",
      "Maximize worker window",
    ]);
    const winMax = trafficLights(worker({}), { variant: "window", zoomed: true, stopArmed: false });
    expect(winMax[2]!.label).toBe("Restore worker window");
  });

  it("red is dead once nothing runs, and says so when armed", () => {
    for (const state of ["exited", "asleep"] as const) {
      const [stop] = trafficLights(worker({ state }), {
        variant: "box",
        zoomed: false,
        stopArmed: false,
      });
      expect(stop).toMatchObject({ disabled: true, hint: "Not running" });
    }
    for (const state of ["working", "idle", "blocked"] as const) {
      expect(
        trafficLights(worker({ state }), { variant: "box", zoomed: false, stopArmed: false })[0]!
          .disabled,
      ).toBe(false);
    }
    expect(
      trafficLights(worker({}), { variant: "box", zoomed: false, stopArmed: true })[0]!.hint,
    ).toBe("Click again to stop this worker");
  });

  it("the subline is Name · model · @account, skipping what is missing", () => {
    expect(workerSubline(worker({ agent: "claude" }), "claude-sonnet-5-5")).toBe(
      "Claude · claude-sonnet-5-5",
    );
    expect(workerSubline(worker({ agent: "codex", account: "work" }), "gpt-5.5-codex")).toBe(
      "codex · gpt-5.5-codex · @work",
    );
    expect(workerSubline(worker({ agent: "antigravity" }), null)).toBe("Antigravity");
  });

  it("isExecTool picks shell tools only", () => {
    for (const t of ["Bash", "bash", "shell", "exec_command", "local_shell", "Command"])
      expect(isExecTool(t)).toBe(true);
    for (const t of ["Read", "Edit", "Grep", "WebFetch", "Write"])
      expect(isExecTool(t)).toBe(false);
  });
});

describe("pinned approvals", () => {
  const approval = (id: string, requestId: string, status: "open" | "accepted" | "declined") =>
    ({
      id,
      at: 0,
      kind: "approval",
      requestId,
      title: `Run ${requestId}`,
      detail: "npm test",
      status,
    }) as WorkerFeedItem;
  const text = (id: string) =>
    ({ id, at: 0, kind: "assistant", text: "hi", streaming: false }) as WorkerFeedItem;

  it("open approvals leave the feed and are pinned", () => {
    const { feed, pinned } = splitPinnedApprovals([text("a"), approval("b", "r1", "open")], null);
    expect(feed.map((i) => i.id)).toEqual(["a"]);
    expect(pinned).toEqual([{ requestId: "r1", title: "Run r1", detail: "npm test" }]);
  });

  it("answered approvals stay in the feed where they happened", () => {
    const { feed, pinned } = splitPinnedApprovals(
      [approval("b", "r1", "accepted"), text("c")],
      null,
    );
    expect(feed.map((i) => i.id)).toEqual(["b", "c"]);
    expect(pinned).toEqual([]);
  });

  it("a later answered copy of the same request un-pins it (either order)", () => {
    expect(
      splitPinnedApprovals([approval("b", "r1", "open"), approval("b2", "r1", "declined")], null)
        .pinned,
    ).toEqual([]);
    expect(
      splitPinnedApprovals([approval("b2", "r1", "accepted"), approval("b", "r1", "open")], null)
        .pinned,
    ).toEqual([]);
  });

  it("the roster's pending approval is pinned until the feed catches up, never twice", () => {
    expect(splitPinnedApprovals([], { requestId: "r9", title: "Edit x" }).pinned).toEqual([
      { requestId: "r9", title: "Edit x", detail: null },
    ]);
    expect(
      splitPinnedApprovals([approval("b", "r9", "open")], { requestId: "r9", title: "Edit x" })
        .pinned,
    ).toHaveLength(1);
    expect(
      splitPinnedApprovals([approval("b", "r9", "accepted")], { requestId: "r9", title: "Edit x" })
        .pinned,
    ).toEqual([]);
  });
});

describe("window tabs", () => {
  it("a GUI Claude worker gets Activity only — no fake terminal", () => {
    expect(workerWindowTabs(worker({ surface: "gui" }))).toEqual(["activity"]);
  });

  it("a swarm PTY worker gets a Terminal tab, and Report once it has one", () => {
    const swarm = { report: { bytes: 900 } } as unknown as NonNullable<FleetWorker["swarm"]>;
    expect(workerWindowTabs(worker({ surface: "gui", swarm, agent: "opencode" }))).toEqual([
      "activity",
      "terminal",
      "report",
    ]);
  });

  it("Transcript needs a record and a live worker (asleep shows its history as Activity)", () => {
    expect(workerWindowTabs(worker({ recordId: "r1" }))).toEqual(["activity", "transcript"]);
    expect(workerWindowTabs(worker({ recordId: "r1", state: "asleep" }))).toEqual(["activity"]);
  });
});
