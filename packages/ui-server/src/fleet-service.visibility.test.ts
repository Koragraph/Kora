// What reaches the lead after its turn ended: an idle that followed a dialog, an error stall kora could not clear, and a
// worker that says "working" but has gone quiet. Runtime + hooks are fakes; IDLE_GRACE_MS runs on mocked timers.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { FleetService, WORKER_STALL_MS, WORKER_TOOL_STALL_MS } from "./fleet-service.ts";

function setup() {
  const rt = new EventEmitter() as any;
  rt.panes = new Map();
  rt.fleetGet = () => ({ plan: "", events: [] });
  const events: any[] = [];
  const svc = new FleetService(
    rt,
    {
      threadForOrchestrator: (o) => (o === "chat:k1" ? { threadId: "t1", cwd: "/r" } : null),
      orchestratorIdFor: (t) => (t === "t1" ? "chat:k1" : null),
      onWorkerEvent: (_threadId, e) => events.push(e),
    },
    { tokens: { forWorktree: () => null } },
  );
  const p = new EventEmitter() as any;
  Object.assign(p, {
    id: "p1",
    agent: "claude",
    name: "tests",
    state: "working",
    blocker: null,
    exited: false,
    exitCode: null,
    pid: 1,
    cwd: "/w",
    cols: 80,
    rows: 24,
    role: "worker",
    orchestratorId: "chat:k1",
    createdAt: 1,
    lastOutputAt: 1,
    worktree: null,
    swarm: null,
    errorStall: null,
    read: () => "⏺ done\n❯ ",
    write() {},
    resize() {},
  });
  rt.panes.set("p1", p);
  const state = (s: string, extra: Record<string, unknown> = {}) => {
    Object.assign(p, { state: s, ...extra });
    rt.emit("notify", "agent.state", { paneId: "p1" });
  };
  return { rt, svc, p, events, state };
}

test("working → blocked → idle still tells the lead the worker is done", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { events, state } = setup();
  state("working");
  state("blocked", { blocker: "Allow edit?" });
  state("idle", { blocker: null });
  t.mock.timers.tick(3100);
  assert.deepEqual(
    events.filter((e) => e.kind === "idle").map((e) => e.paneId),
    ["p1"],
  );
});

test("an error stall: silent while kora retries, one note once the auto-continue is spent", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { rt, p, events, state } = setup();
  state("working");
  state("idle", {
    errorStall: {
      line: "API Error: The response stopped arriving",
      at: 5,
      retries: 1,
      retrying: true,
    },
  });
  t.mock.timers.tick(3100);
  assert.equal(events.filter((e) => e.kind === "idle").length, 0, "no note while retrying");
  p.errorStall = {
    line: "API Error: The response stopped arriving",
    at: 5,
    retries: 3,
    retrying: false,
  };
  rt.emit("notify", "pane.updated", { paneId: "p1" });
  rt.emit("notify", "pane.updated", { paneId: "p1" });
  t.mock.timers.tick(3100);
  const notes = events.filter((e) => e.kind === "idle");
  assert.equal(notes.length, 1, "deduped");
  assert.match(notes[0].problem, /error-stalled .*response stopped arriving.*3\/3/);
});

test("stall sweep: one note per quiet episode of a working worker", () => {
  const { svc, p, events, state } = setup();
  state("working");
  p.lastOutputAt = 1_000;
  svc.sweepStalls(1_000 + WORKER_STALL_MS - 1);
  assert.equal(events.filter((e) => e.kind === "stalled").length, 0);
  svc.sweepStalls(1_000 + WORKER_STALL_MS + 1);
  svc.sweepStalls(1_000 + WORKER_STALL_MS + 60_000);
  assert.equal(events.filter((e) => e.kind === "stalled").length, 1);
  p.lastOutputAt = 2_000_000; // it wrote again, then went quiet again: a new episode
  svc.sweepStalls(2_000_000 + WORKER_STALL_MS + 1);
  assert.equal(events.filter((e) => e.kind === "stalled").length, 2);
  p.state = "idle";
  p.lastOutputAt = 9_000_000;
  svc.sweepStalls(9_000_000 + WORKER_STALL_MS * 2);
  assert.equal(
    events.filter((e) => e.kind === "stalled").length,
    2,
    "idle workers are not stalled",
  );
});

test("stall sweep: a running tool call gets the longer window; a worker Kora is retrying gets none", () => {
  const { svc, p, events, state } = setup();
  state("working");
  const stalled = () => events.filter((e) => e.kind === "stalled").length;
  p.toolRunning = true;
  p.lastOutputAt = 1_000;
  svc.sweepStalls(1_000 + WORKER_STALL_MS + 1);
  assert.equal(stalled(), 0, "a 5-min build is not a hang");
  svc.sweepStalls(1_000 + WORKER_TOOL_STALL_MS + 1);
  assert.equal(stalled(), 1, "a tool quiet for 20 min is");
  p.toolRunning = false;
  p.lastOutputAt = 5_000_000;
  p.errorStall = { line: "No response", at: 1, retries: 1, retrying: true };
  svc.sweepStalls(5_000_000 + WORKER_STALL_MS + 1);
  assert.equal(stalled(), 1, "no note while Kora retries it");
});
