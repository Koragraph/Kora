// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- a plain node:test file reading a contracts fixture from disk (and waiting out a real grace timer).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FleetSwarmWorker } from "@kora/contracts";
import * as Schema from "effect/Schema";

import { FleetService, swarmActivity, toFleetSwarmWorker } from "./fleet-service.ts";

const fixture = JSON.parse(
  fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../contracts/src/fixtures/fleet-worker-swarm.sample.json",
    ),
    "utf8",
  ),
);

function deepKeys(v: unknown, prefix = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) {
    for (const el of v) deepKeys(el, `${prefix}[]`, out);
    return out;
  }
  if (v && typeof v === "object") {
    for (const [k, child] of Object.entries(v)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      deepKeys(child, p, out);
    }
  }
  return out;
}

const runtimeMeta = () => ({
  ...structuredClone(fixture.swarm),
  reportPath: "/w/.kora/swarm/s3.md",
});

test("toFleetSwarmWorker drops exactly reportPath (key set equals the fixture's FleetWorker.swarm)", () => {
  const wire = toFleetSwarmWorker(runtimeMeta());
  assert.deepEqual([...deepKeys(wire)].sort(), [...deepKeys(fixture.swarm)].sort());
  assert.deepEqual(wire, fixture.swarm);
  assert.equal("reportPath" in wire, false);
});

test("toFleetSwarmWorker carries the foreman (additive) and it decodes against the contract", () => {
  const foreman = {
    state: "escalated",
    attempt: 2,
    maxAttempts: 2,
    check: "pnpm test",
    review: false,
    verdicts: [
      {
        attempt: 1,
        paneId: "p5",
        model: "opencode/big-pickle",
        check: { state: "failed", exitCode: 1, durationMs: 900, tail: "1 failing" },
        gate: "passed",
        review: null,
        failure: "check",
        durationMs: 60000,
        at: 1790000300000,
      },
    ],
    result: {
      kind: "escalation",
      attempts: 2,
      worktree: "/w",
      diffStat: "1 file changed",
      checkTail: null,
      lastFailure: "check failed (exit 1):\n1 failing",
    },
  };
  const wire = toFleetSwarmWorker({ ...runtimeMeta(), foreman } as any);
  assert.deepEqual(wire.foreman, foreman);
  assert.deepEqual(Schema.decodeUnknownSync(FleetSwarmWorker)(wire).foreman, foreman);
  assert.equal("foreman" in toFleetSwarmWorker(runtimeMeta()), false, "absent when off");
});

function pane(id: string, over: Record<string, unknown> = {}) {
  const e = new EventEmitter() as any;
  Object.assign(e, {
    id,
    agent: "opencode",
    name: "w",
    state: "idle",
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
    worktree: { path: "/w", branch: "kora/opencode-1", mainRoot: "/r" },
    ledger: { costUsd: 1.5 },
    swarm: null,
    read: () => "screen",
    write() {},
    resize() {},
    ...over,
  });
  return e;
}

function harness(
  opts: {
    tokens?: Map<string, { input: number; cached: number; output: number }>;
    leader?: { input: number; cached: number; output: number; turns: number } | null;
  } = {},
) {
  const rt = new EventEmitter() as any;
  rt.panes = new Map();
  rt.fleetGet = () => ({ plan: "", events: [] });
  const reads: string[] = [];
  const retries: string[] = [];
  const extends_: { paneId: string; minutes: number }[] = [];
  const stopped: string[] = [];
  rt.swarm = {
    readReport: async (id: string) => {
      reads.push(id);
      return { text: "## Done", truncated: false, updatedAt: 5 };
    },
    taskForPane: (id: string) => (id === "p5" ? { orchestratorId: "chat:k1", taskId: "s3" } : null),
    retryWorker: async (id: string) => {
      retries.push(id);
      return id === "p7" ? { taskId: "s3", newPaneId: "p10" } : null;
    },
    extendWorker: (id: string, minutes: number) => {
      extends_.push({ paneId: id, minutes });
      return id === "p7" ? { taskId: "s3" } : null;
    },
    userStopped: (id: string) => {
      stopped.push(id);
      return { taskId: "s3" };
    },
  };
  const events: any[] = [];
  const svc = new FleetService(
    rt,
    {
      threadForOrchestrator: (o) => (o === "chat:k1" ? { threadId: "t1", cwd: "/r" } : null),
      orchestratorIdFor: (t) => (t === "t1" ? "chat:k1" : null),
      onWorkerEvent: (threadId, e) => events.push({ threadId, e }),
      leaderTokensFor: () => opts.leader ?? null,
    },
    { tokens: { forWorktree: (p) => opts.tokens?.get(p) ?? null } },
  );
  return { rt, svc, events, reads, retries, extends_, stopped };
}

test("snapshot: swarm workers carry `swarm` (no cost) and the thread gets the measured activity", () => {
  const { rt, svc } = harness();
  const a = runtimeMeta();
  rt.panes.set("p7", pane("p7", { swarm: a }));
  const b = {
    ...runtimeMeta(),
    taskId: "s4",
    attempt: 1,
    previousPaneIds: [],
    verify: { state: "passed", bounces: 0, summary: null },
  };
  rt.panes.set("p8", pane("p8", { swarm: b }));
  rt.panes.set("p9", pane("p9", { agent: "claude" }));
  const snap = svc.snapshot("t1")!;
  const w7 = snap.workers.find((w) => w.paneId === "p7")!;
  assert.equal(w7.costUsd, null);
  assert.equal(w7.swarm?.taskId, "s3");
  assert.equal(snap.workers.find((w) => w.paneId === "p9")!.swarm, undefined);
  assert.equal(snap.workers.find((w) => w.paneId === "p9")!.costUsd, 1.5);
  assert.deepEqual(snap.swarm, {
    delegated: 2,
    reportsReturned: 2,
    respawns: 1,
    passedFirstTry: 1,
    bounced: 1,
    byModel: [
      { provider: "zen", model: "opencode/big-pickle", modelLabel: "big-pickle", workers: 2 },
    ],
    exhausted: false,
  });
  assert.equal(swarmActivity([]), null);
  rt.panes.delete("p7");
  rt.panes.delete("p8");
  assert.equal(svc.snapshot("t1")!.swarm, undefined, "no swarm workers → no key");
});

test("value meter: measured worker tokens per task (attempts counted once) and the leader's tokens", () => {
  const tokens = new Map([
    ["/w/a", { input: 1000, cached: 5000, output: 200 }],
    ["/w/b", { input: 10, cached: 0, output: 5 }],
  ]);
  const { rt, svc } = harness({
    tokens,
    leader: { input: 300, cached: 90_000, output: 1200, turns: 3 },
  });
  const wt = (p: string) => ({ path: p, branch: "kora/x", mainRoot: "/r" });
  // task s3 ran on two panes (a failover) in one worktree; s4 in its own; s5 has no OpenCode session yet
  rt.panes.set("p5", pane("p5", { swarm: { ...runtimeMeta(), attempt: 1 }, worktree: wt("/w/a") }));
  rt.panes.set("p7", pane("p7", { swarm: runtimeMeta(), worktree: wt("/w/a") }));
  rt.panes.set(
    "p8",
    pane("p8", { swarm: { ...runtimeMeta(), taskId: "s4" }, worktree: wt("/w/b") }),
  );
  rt.panes.set(
    "p9",
    pane("p9", { swarm: { ...runtimeMeta(), taskId: "s5" }, worktree: wt("/w/c") }),
  );
  rt.panes.set("p10", pane("p10", { agent: "claude", worktree: wt("/w/a") }));
  const snap = svc.snapshot("t1")!;
  assert.deepEqual(snap.workers.find((w) => w.paneId === "p7")!.tokens, tokens.get("/w/a"));
  assert.equal(snap.workers.find((w) => w.paneId === "p9")!.tokens, undefined, "not measured");
  assert.equal(
    snap.workers.find((w) => w.paneId === "p10")!.tokens,
    undefined,
    "not a swarm worker",
  );
  assert.deepEqual(snap.swarm!.workerTokens, { input: 1010, cached: 5000, output: 205, tasks: 2 });
  assert.deepEqual(snap.swarm!.leaderTokens, {
    input: 300,
    cached: 90_000,
    output: 1200,
    turns: 3,
  });
  assert.equal(JSON.stringify(snap).includes("$"), false, "no dollar figure anywhere");
});

test("swarm.worker notifications become engine events; a superseded pane's exit is not a DONE", async () => {
  const { rt, events } = harness();
  const old = pane("p5", { swarm: { ...runtimeMeta(), phase: "respawning" } });
  rt.panes.set("p5", old);
  rt.emit("notify", "pane.updated", { id: "p5" });
  old.exited = true;
  rt.emit("notify", "pane.updated", { id: "p5" });
  assert.deepEqual(
    events.map((x) => x.e.kind),
    ["spawned"],
    "no done for a pane being replaced",
  );
  rt.emit("notify", "swarm.worker", {
    orchestratorId: "chat:k1",
    event: {
      kind: "failover",
      paneId: "p5",
      taskId: "s3",
      newPaneId: "p7",
      fromModel: "a",
      toModel: "b",
    },
  });
  rt.emit("notify", "swarm.worker", {
    orchestratorId: "chat:k1",
    event: {
      kind: "report",
      paneId: "p7",
      taskId: "s3",
      verify: { state: "passed", bounces: 0, summary: null },
    },
  });
  rt.emit("notify", "swarm.worker", {
    orchestratorId: "chat:k1",
    event: { kind: "exhausted", paneId: "p7", taskId: "s3", tried: ["a", "b"] },
  });
  rt.emit("notify", "swarm.worker", {
    orchestratorId: "chat:k1",
    event: {
      kind: "bounced",
      paneId: "p7",
      taskId: "s3",
      verify: { state: "bounced", bounces: 1, summary: "x" },
    },
  });
  rt.emit("notify", "swarm.worker", {
    orchestratorId: "chat:other",
    event: { kind: "report", paneId: "p1", taskId: "s1" },
  });
  assert.deepEqual(
    events.slice(1).map((x) => x.e),
    [
      {
        kind: "swarm-failover",
        paneId: "p5",
        taskId: "s3",
        newPaneId: "p7",
        fromModel: "a",
        toModel: "b",
      },
      {
        kind: "swarm-report",
        paneId: "p7",
        taskId: "s3",
        verify: { state: "passed", bounces: 0, summary: null },
      },
      { kind: "swarm-exhausted", paneId: "p7", taskId: "s3", tried: ["a", "b"] },
      {
        kind: "swarm-bounced",
        paneId: "p7",
        taskId: "s3",
        verify: { state: "bounced", bounces: 1, summary: "x" },
      },
    ],
  );
  assert.ok(events.every((x) => x.threadId === "t1"));
});

test("readReport routes to SwarmService for the thread's own workers (live or from the registry) only", async () => {
  const { rt, svc, reads } = harness();
  rt.panes.set("p7", pane("p7", { swarm: runtimeMeta() }));
  rt.panes.set("p8", pane("p8", { orchestratorId: "chat:other" }));
  assert.deepEqual(await svc.readReport("t1", "p7"), {
    text: "## Done",
    truncated: false,
    updatedAt: 5,
  });
  assert.deepEqual(
    await svc.readReport("t1", "p5"),
    { text: "## Done", truncated: false, updatedAt: 5 },
    "reaped / pre-restart pane via taskForPane",
  );
  assert.equal(await svc.readReport("t1", "p8"), null, "another thread's worker");
  assert.equal(await svc.readReport("t1", "p99"), null);
  assert.equal(await svc.readReport("nope", "p7"), null);
  assert.deepEqual(reads, ["p7", "p5"]);
});

test("retry: owned swarm worker → SwarmService.retryWorker, a local note, and a fleet touch", async () => {
  const { rt, svc, retries } = harness();
  rt.panes.set("p7", pane("p7", { swarm: runtimeMeta() }));
  const r = await svc.retry("t1", "p7");
  assert.deepEqual(r, { newPaneId: "p10" });
  assert.deepEqual(retries, ["p7"]);
  const note = svc.snapshot("t1")!.events.find((e) => e.workerId === "p7");
  assert.match(note!.text, /p7.*p10/);
});

test("retry: not owned by the thread → null; not a swarm worker, or SwarmService refuses → throws", async () => {
  const { rt, svc } = harness();
  rt.panes.set("p6", pane("p6")); // owned, but no `swarm` meta
  rt.panes.set("p8", pane("p8", { orchestratorId: "chat:other", swarm: runtimeMeta() }));
  assert.equal(await svc.retry("t1", "p99"), null, "unknown pane");
  assert.equal(await svc.retry("t1", "p8"), null, "another thread's worker");
  await assert.rejects(svc.retry("t1", "p6"), /not a swarm worker/);
  // "p5" is owned per threadForOrchestrator/pane defaults (see readReport test) but its retryWorker fake answers null.
  rt.panes.set("p5", pane("p5", { swarm: runtimeMeta() }));
  await assert.rejects(svc.retry("t1", "p5"), /cannot be retried/);
});

test("extend: owned swarm worker → SwarmService.extendWorker with the given minutes, a local note, a fleet touch", async () => {
  const { rt, svc, extends_ } = harness();
  rt.panes.set("p7", pane("p7", { swarm: runtimeMeta() }));
  const ok = await svc.extend("t1", "p7", 15);
  assert.equal(ok, true);
  assert.deepEqual(extends_, [{ paneId: "p7", minutes: 15 }]);
  const note = svc.snapshot("t1")!.events.find((e) => e.workerId === "p7");
  assert.match(note!.text, /p7.*15 more minutes/);
});

test("extend: not owned by the thread → false; not a swarm worker, or SwarmService refuses → throws", async () => {
  const { rt, svc } = harness();
  rt.panes.set("p6", pane("p6"));
  rt.panes.set("p5", pane("p5", { swarm: runtimeMeta() })); // extendWorker fake answers null for anything but p7
  assert.equal(await svc.extend("t1", "p99", 5), false, "unknown pane");
  await assert.rejects(svc.extend("t1", "p6", 5), /not a swarm worker/);
  await assert.rejects(svc.extend("t1", "p5", 5), /cannot be extended/);
});

test("kill: a pane that is already gone does not throw; the worker is still recorded as stopped", () => {
  const { rt, svc, stopped } = harness();
  rt.killPane = (id: string) => {
    rt.panes.delete(id);
    throw new Error("no pane p7");
  };
  rt.panes.set("p7", pane("p7", { swarm: runtimeMeta(), state: "working", name: "tax" }));
  assert.equal(svc.kill("t1", "p7"), true);
  assert.deepEqual(stopped, ["p7"]);
  assert.equal(svc.snapshot("t1")!.workers.find((x) => x.paneId === "p7")?.stoppedByUser, true);
});

// Swarm QA 2026-10-02: the human stopped a swarm worker from the Tasks panel; the task vanished from the panel and the
// lead respawned it. A kill is a decision: the worker stays listed as stopped and the lead gets a "stopped" event.
test("kill: a stopped swarm worker stays listed (stoppedByUser), SwarmService hears it, the lead gets 'stopped'", () => {
  const { rt, svc, events, stopped } = harness();
  rt.killPane = (id: string) => rt.panes.delete(id);
  rt.panes.set("p7", pane("p7", { swarm: runtimeMeta(), state: "working", name: "tax" }));
  assert.equal(svc.kill("t1", "p7"), true);
  assert.deepEqual(stopped, ["p7"]);
  const w = svc.snapshot("t1")!.workers.find((x) => x.paneId === "p7");
  assert.ok(w, "still listed after the pane is gone");
  assert.equal(w!.stoppedByUser, true);
  assert.equal(w!.state, "exited");
  assert.equal(w!.swarm?.phase, "failed");
  assert.deepEqual(
    events.filter((x) => x.e.kind === "stopped").map((x) => x.e),
    [{ kind: "stopped", paneId: "p7", title: "tax", taskId: "s3" }],
  );
  assert.equal(
    events.filter((x) => x.e.kind === "done").length,
    0,
    "never an EXITED/continue note",
  );
});

test("a retired (merged, closed by Kora) swarm worker stays listed but sends the lead no EXITED note", () => {
  const { rt, svc, events } = harness();
  const p = pane("p8", { swarm: { ...runtimeMeta(), phase: "done" } });
  rt.panes.set("p8", p);
  rt.emit("notify", "pane.updated", { id: "p8" });
  p.retired = true;
  p.exited = true;
  rt.emit("notify", "pane.updated", { id: "p8" });
  assert.equal(events.filter((x) => x.e.kind === "done").length, 0);
  assert.equal(svc.snapshot("t1")!.workers.find((w) => w.paneId === "p8")?.state, "exited");
});

test("a worker the lead killed (pane.closed before any exit) stays listed as exited — never 'No workers yet'", () => {
  const { rt, svc } = harness();
  rt.panes.set("p3", pane("p3", { agent: "claude", state: "working", name: "slice A" }));
  rt.emit("notify", "pane.updated", { id: "p3" });
  rt.panes.delete("p3");
  rt.emit("notify", "pane.closed", { paneId: "p3", exitCode: null });
  const w = svc.snapshot("t1")!.workers.find((x) => x.paneId === "p3");
  assert.equal(w?.state, "exited");
  assert.equal(w?.title, "slice A");
  // A swarm pane being replaced by a failover is not remembered as a separate ended worker.
  rt.panes.set("p4", pane("p4", { swarm: { ...runtimeMeta(), phase: "respawning" } }));
  rt.emit("notify", "pane.updated", { id: "p4" });
  rt.panes.delete("p4");
  rt.emit("notify", "pane.closed", { paneId: "p4", exitCode: null });
  assert.equal(
    svc.snapshot("t1")!.workers.some((x) => x.paneId === "p4"),
    false,
  );
});

test("a closed worker that has a sleep record shows once (asleep), not also as an exited tile", () => {
  const { rt, svc } = harness();
  rt.panes.set("p3", pane("p3", { agent: "claude", state: "working", name: "slice A" }));
  rt.emit("notify", "pane.updated", { id: "p3" });
  rt.panes.delete("p3");
  rt.emit("notify", "pane.closed", { paneId: "p3", exitCode: null });
  rt.workerSleeper = () => ({
    list: () => [
      {
        recordId: "w_1",
        paneId: "p3",
        orchestratorId: "chat:k1",
        agent: "claude",
        title: "slice A",
        cwd: "/r",
        status: "asleep",
        createdAt: 1,
        sleptAt: 2,
        finalReport: null,
        branchKept: false,
        worktree: null,
        changes: null,
        session: { id: null, transcriptPath: null },
      },
    ],
  });
  const ws = svc.snapshot("t1")!.workers;
  assert.deepEqual(
    ws.map((w) => `${w.paneId}:${w.state}`),
    ["w_1:asleep"],
  );
});

// Swarm QA 2026-10-02 #5: after a daemon restart a stopped (or finished) swarm task vanished from the Tasks list.
test("snapshot after a restart: tasks restored from tasks.json are listed (stopped stays stopped), never twice", () => {
  const { rt, svc } = harness();
  const base = {
    model: "opencode/big-pickle",
    provider: "zen",
    attempt: 1,
    worktree: { path: "/w2", branch: "kora/opencode-2", mainRoot: "/r" },
    report: null,
  };
  rt.swarm.restoredTasks = (o: string) =>
    o === "chat:k1"
      ? [
          {
            ...base,
            taskId: "s1",
            title: "tax",
            status: "failed",
            userStopped: true,
            paneIds: ["p1"],
          },
          {
            ...base,
            taskId: "s2",
            title: "cart",
            status: "done",
            userStopped: false,
            paneIds: ["p2"],
            report: { bytes: 9, updatedAt: 42, preview: "## Done" },
          },
          {
            ...base,
            taskId: "s3",
            title: "live again",
            status: "done",
            userStopped: false,
            paneIds: ["p5"],
          },
        ]
      : [];
  // s3 was resumed: its live pane (p1 after the restart — ids restart per daemon) is the one listed.
  rt.panes.set("p1", pane("p1", { swarm: { ...runtimeMeta(), taskId: "s3" } }));
  const snap = svc.snapshot("t1")!;
  const s1 = snap.workers.find((w) => w.swarm?.taskId === "s1")!;
  assert.equal(s1.paneId, "s1", "a task id, never a recycled pane id");
  assert.equal(s1.state, "exited");
  assert.equal(s1.stoppedByUser, true);
  assert.equal(s1.swarm?.phase, "failed");
  assert.equal(s1.worktree, null, "no merge button on a tile no pane backs");
  const s2 = snap.workers.find((w) => w.swarm?.taskId === "s2")!;
  assert.equal(s2.swarm?.phase, "done");
  assert.equal(s2.swarm?.report?.preview, "## Done");
  assert.equal(snap.workers.filter((w) => w.swarm?.taskId === "s3").length, 1);
  assert.equal(snap.workers.find((w) => w.swarm?.taskId === "s3")!.paneId, "p1");
  assert.equal(JSON.stringify(snap).includes("undefined"), false);
});

test("a CLI worker whose first prompt is still pending never sends a false 'finished its turn' note (pl5 S2-2)", async () => {
  const { rt, svc, events } = harness();
  void svc;
  const a = pane("p3", { agent: "claude", state: "working", promptPending: true });
  const b = pane("p4", { agent: "claude", state: "working" });
  rt.panes.set("p3", a);
  rt.panes.set("p4", b);
  rt.emit("notify", "agent.state", { paneId: "p3" });
  rt.emit("notify", "agent.state", { paneId: "p4" });
  a.state = "idle";
  b.state = "idle";
  rt.emit("notify", "agent.state", { paneId: "p3" });
  rt.emit("notify", "agent.state", { paneId: "p4" });
  await new Promise((r) => setTimeout(r, 3300));
  const idle = events.filter((x) => x.e.kind === "idle").map((x) => x.e.paneId);
  assert.deepEqual(idle, ["p4"]);
});

test("a worker that worked and went idle is Done with a frozen clock; one stopped on an API error says so", () => {
  const { rt, svc } = harness();
  svc.doneGraceMs = 0;
  const a = pane("p5", { agent: "claude", state: "working" });
  const b = pane("p6", { agent: "claude", state: "idle" });
  const c = pane("p7", { agent: "claude", state: "working" });
  for (const p of [a, b, c]) rt.panes.set(p.id, p);
  for (const id of ["p5", "p6", "p7"]) rt.emit("notify", "agent.state", { paneId: id });
  a.state = "idle";
  c.state = "idle";
  c.errorStall = { line: "API Error: 500", at: 1, retries: 3, retrying: false };
  rt.emit("notify", "agent.state", { paneId: "p5" });
  rt.emit("notify", "agent.state", { paneId: "p7" });
  const byId = new Map(svc.snapshot("t1")!.workers.map((w) => [w.paneId, w]));
  assert.equal(typeof byId.get("p5")!.turnEndedAt, "number", "worked then idle: done");
  assert.equal(byId.get("p6")!.turnEndedAt, undefined, "idle before any work: not done");
  assert.equal(byId.get("p7")!.stoppedOnError, "API Error: 500");
  assert.equal(typeof byId.get("p7")!.turnEndedAt, "number", "a stopped box's clock stops too");
  a.state = "working";
  rt.emit("notify", "agent.state", { paneId: "p5" });
  assert.equal(svc.snapshot("t1")!.workers.find((w) => w.paneId === "p5")!.turnEndedAt, undefined);
});

test("turnEndedAt edges: blocked then idle counts, a pending first prompt and a swarm worker do not, and repeat idles keep the first time", async () => {
  const { rt, svc } = harness();
  svc.doneGraceMs = 0;
  const a = pane("p8", { agent: "claude", state: "working" });
  const b = pane("p9", { agent: "claude", state: "working", promptPending: true });
  const c = pane("p10", {
    agent: "opencode",
    state: "working",
    swarm: { ...runtimeMeta(), phase: "running" },
  });
  for (const p of [a, b, c]) rt.panes.set(p.id, p);
  for (const p of [a, b, c]) rt.emit("notify", "agent.state", { paneId: p.id });
  a.state = "blocked";
  rt.emit("notify", "agent.state", { paneId: "p8" });
  a.state = "idle";
  b.state = "idle";
  c.state = "idle";
  for (const p of [a, b, c]) rt.emit("notify", "agent.state", { paneId: p.id });
  const get = (id: string) => svc.snapshot("t1")!.workers.find((w) => w.paneId === id)!;
  const first = get("p8").turnEndedAt;
  assert.equal(typeof first, "number", "working → blocked → idle is a finished turn");
  assert.equal(get("p9").turnEndedAt, undefined, "its first prompt has not been taken yet");
  assert.equal(get("p10").turnEndedAt, undefined, "swarm workers report through their own phase");
  await new Promise((r) => setTimeout(r, 15));
  rt.emit("notify", "pane.updated", { paneId: "p8" });
  rt.emit("notify", "agent.state", { paneId: "p8" });
  assert.equal(get("p8").turnEndedAt, first, "a repeat idle does not move the frozen clock");
  assert.equal(JSON.stringify(svc.snapshot("t1")).includes("undefined"), false, "wire-safe");
});

test("a GUI worker's own turn end wins, so Done survives a ui-server restart (no in-memory history)", () => {
  const { rt, svc } = harness();
  const p = pane("p11", {
    agent: "claude",
    state: "idle",
    info: () => ({ surface: "gui", turnEndedAt: 4242 }),
  });
  rt.panes.set("p11", p);
  rt.emit("notify", "agent.state", { paneId: "p11" });
  assert.equal(svc.snapshot("t1")!.workers.find((w) => w.paneId === "p11")!.turnEndedAt, 4242);
});

test("worker boxes: subscribeWorker = snapshot then upserts for that pane only; GUI steer is a message, a PTY steer keystrokes", async () => {
  const { Effect, Stream, Fiber } = await import("effect");
  const { rt, svc } = harness();
  const item = (id: string, text: string) => ({
    id,
    at: 1,
    kind: "assistant",
    text,
    streaming: false,
    extra: undefined,
  });
  const steers: string[] = [];
  const keys: string[] = [];
  rt.workerFeed = (id: string) => (id === "p7" ? [item("a1", "hello")] : null);
  rt.humanSteer = async (id: string, text: string) => void steers.push(`${id}:${text}`);
  rt.humanWrite = (id: string, text: string) => void keys.push(`${id}:${text}`);
  rt.off = rt.off.bind(rt);
  rt.panes.set(
    "p7",
    pane("p7", { agent: "claude", steerSink: async () => {}, info: () => ({ surface: "gui" }) }),
  );
  rt.panes.set("p8", pane("p8"));
  const base = rt.listenerCount("notify"); // FleetService's own
  const got: any[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(svc.subscribeWorker("t1", "p7"), (e) => Effect.sync(() => void got.push(e))),
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(rt.listenerCount("notify"), base + 1);
  rt.emit("notify", "pane.feed", { paneId: "p8", item: item("x", "other pane") });
  rt.emit("notify", "pane.feed", { paneId: "p7", item: item("a2", "second") });
  rt.emit("notify", "pane.feed", { paneId: "p7", item: item("a2", "second, longer") });
  await new Promise((r) => setTimeout(r, 20));
  await Effect.runPromise(Fiber.interrupt(fiber)); // the client unsubscribed
  assert.deepEqual(
    got.map((e) => e.type),
    ["snapshot", "upsert", "upsert"],
  );
  assert.equal(got[0].items[0].text, "hello");
  assert.equal("extra" in got[1].item, false, "undefined never reaches the wire");
  assert.equal(got[2].item.text, "second, longer");
  assert.equal(
    rt.listenerCount("notify"),
    base,
    "the listener is removed when the client unsubscribes",
  );
  assert.equal(await svc.steer("t1", "p7", "use hi.txt", true), true);
  assert.equal(await svc.steer("t1", "p8", "y", true), true);
  assert.deepEqual(steers, ["p7:use hi.txt"]);
  assert.deepEqual(keys, ["p8:y", "p8:\r"]);
  assert.equal(
    await svc.respondApproval("t1", "p8", "r1", "accept"),
    false,
    "no runtime hook → refused",
  );
});

// ── audit 2026-10-15 (5-bugs-web #4 #6 #8 #9, 3-bugs-fleet #12, 7-ux-onboarding-fleet #2 #21) ──

test("Done waits out the idle grace: a short idle inside a turn never flashes the box to Done (web #4)", async () => {
  const { rt, svc } = harness();
  svc.doneGraceMs = 40;
  const touched: string[] = [];
  const origTouch = (svc as any).touchFleet.bind(svc);
  (svc as any).touchFleet = (t: string) => {
    touched.push(t);
    origTouch(t);
  };
  const a = pane("p5", { agent: "claude", state: "working" });
  rt.panes.set("p5", a);
  rt.emit("notify", "agent.state", { paneId: "p5" });
  a.state = "idle";
  rt.emit("notify", "agent.state", { paneId: "p5" });
  const get = () => svc.snapshot("t1")!.workers.find((w) => w.paneId === "p5")!;
  assert.equal(get().turnEndedAt, undefined, "inside the grace: still not Done");
  touched.length = 0;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(typeof get().turnEndedAt, "number", "after the grace: Done");
  assert.ok(touched.includes("t1"), "the snapshot is refreshed when the grace ends");
});

test("pane.closed prunes the per-worker maps (fleet #12, web #9)", () => {
  const { rt, svc } = harness();
  const a = pane("p5", { agent: "claude", state: "working" });
  rt.panes.set("p5", a);
  rt.emit("notify", "agent.state", { paneId: "p5" });
  (svc as any).notifiedStall.set("p5", 1);
  (svc as any).notifiedErrorStall.set("p5", "1:1");
  assert.ok((svc as any).workerState.has("p5"));
  rt.panes.delete("p5");
  rt.emit("notify", "pane.closed", { paneId: "p5" });
  for (const m of ["workerState", "notifiedStall", "notifiedErrorStall", "notifiedBlocker"])
    assert.equal((svc as any)[m].has("p5"), false, m);
});

test("subscribeWorker streams nothing for a worker this thread does not own (web #8)", async () => {
  const { Effect, Stream, Fiber } = await import("effect");
  const { rt, svc } = harness();
  rt.off = rt.off.bind(rt);
  rt.workerFeed = () => [];
  rt.panes.set("p7", pane("p7", { agent: "claude", orchestratorId: "chat:other" }));
  const got: any[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(svc.subscribeWorker("t1", "p7"), (e) => Effect.sync(() => void got.push(e))),
  );
  await new Promise((r) => setTimeout(r, 20));
  rt.emit("notify", "pane.feed", {
    paneId: "p7",
    item: { id: "x", at: 1, kind: "assistant", text: "secret", streaming: false },
  });
  await new Promise((r) => setTimeout(r, 20));
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.deepEqual(
    got.map((e) => e.type),
    ["snapshot"],
  );
  assert.deepEqual(got[0].items, []);
});

test("merge refuses a worker that is still working or waiting on a question (UX #2)", async () => {
  const { rt, svc } = harness();
  const merged: string[] = [];
  rt.worktreeMerge = async ({ paneId }: { paneId: string }) => {
    merged.push(paneId);
    return {
      ok: true,
      merged: "kora/x",
      into: "main",
      message: "merged",
      conflicts: [],
      commitsMerged: 1,
    };
  };
  rt.panes.set("p5", pane("p5", { agent: "claude", state: "working" }));
  rt.panes.set("p6", pane("p6", { agent: "claude", state: "blocked" }));
  rt.panes.set("p7", pane("p7", { agent: "claude", state: "idle" }));
  const w = await svc.merge("t1", "p5", true);
  assert.equal(w!.ok, false);
  assert.match(w!.message, /still working/);
  assert.match((await svc.merge("t1", "p6", true))!.message, /waiting for an answer/);
  assert.equal((await svc.merge("t1", "p7", true))!.ok, true);
  assert.deepEqual(merged, ["p7"]);
});
