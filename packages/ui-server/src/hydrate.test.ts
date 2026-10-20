import test from "node:test";
import assert from "node:assert/strict";
import { hydrateRecord, toPermissionMode } from "./hydrate.ts";

// Permission-mode replay and graph freshness at resume moved into the daemon's SessionManager
// (kora/src/session/session-manager.test.ts); this covers the projection normalisation that stays here.

function rec(over: Record<string, unknown> = {}) {
  return {
    threadId: "t1",
    koraThreadId: "nh1",
    cwd: "/repo",
    runtimeMode: "full-access",
    session: { status: "idle" },
    latestTurn: { state: "completed" },
    currentAssistant: { partial: "x" },
    activities: [{ sequence: 3 }, { sequence: 9 }, {}],
    ...over,
  } as any;
}

test("toPermissionMode maps the composer's runtime modes onto kora permission modes", () => {
  assert.equal(toPermissionMode("full-access"), "full-access");
  assert.equal(toPermissionMode("auto-accept-edits"), "auto-accept-edits");
  assert.equal(toPermissionMode("auto"), "auto");
  assert.equal(toPermissionMode("approval-required"), "supervised");
});

test("hydrate reports a record persisted mid-turn and normalises legacy fields", () => {
  const r = rec({
    session: { status: "running" },
    koraSessionId: undefined,
    providerDriver: undefined,
    agentMode: undefined,
    pendingNotes: [{ stale: true }],
  });
  const out = hydrateRecord(r);
  assert.equal(out.interrupted, true);
  assert.equal(out.maxSeq, 9);
  assert.equal(r.currentAssistant, null);
  assert.equal(r.koraSessionId, null);
  assert.equal(r.providerDriver, "claude");
  assert.equal(r.agentMode, "chat");
  assert.deepEqual(r.pendingNotes, []);
  assert.equal(hydrateRecord(rec({ latestTurn: { state: "running" } })).interrupted, true);
  assert.equal(hydrateRecord(rec()).interrupted, false);
});

test("hydrate migrates the legacy Claude driver id on the record and its session", () => {
  const r = rec({
    providerDriver: "claudeAgent",
    session: { status: "ready", providerName: "claudeAgent" },
  });
  hydrateRecord(r);
  assert.equal(r.providerDriver, "claude");
  assert.equal(r.session.providerName, "claude");
  const codex = rec({ providerDriver: "codex", session: { providerName: "codex" } });
  hydrateRecord(codex);
  assert.equal(codex.providerDriver, "codex");
  assert.equal(codex.session.providerName, "codex");
});

test("hydrate keeps swarm, maps an unknown mode to orchestrator and drops the leader-limit timers", () => {
  const s = rec({ agentMode: "swarm", leaderLimit: { until: 1, timer: null }, digestNext: true });
  hydrateRecord(s);
  assert.equal(s.agentMode, "swarm");
  assert.equal("leaderLimit" in s, false);
  assert.equal("digestNext" in s, false);
  const u = rec({ agentMode: "hive" });
  hydrateRecord(u);
  assert.equal(u.agentMode, "orchestrator");
});

test("hydrate keeps only a human STOP note across a restart (the lead must still hear it)", () => {
  const stop = { kind: "stopped", paneId: "p2", text: "[kora] the human STOPPED worker p2" };
  const r = rec({ pendingNotes: [{ kind: "idle", paneId: "p1", text: "x" }, stop, null] });
  hydrateRecord(r);
  assert.deepEqual(r.pendingNotes, [stop]);
});

test("openRequests: what a dead turn was still waiting on (approval, question, worker pick) - and only that", async () => {
  const { openRequests } = await import("./hydrate.ts");
  const acts = [
    { kind: "approval.requested", payload: { requestId: "a1" } },
    { kind: "approval.requested", payload: { requestId: "a2" } },
    { kind: "approval.resolved", payload: { requestId: "a1", decision: "accept" } },
    { kind: "user-input.requested", payload: { requestId: "q1" } },
    { kind: "user-input.requested", payload: { requestId: "q2" } },
    { kind: "user-input.resolved", payload: { requestId: "q2" } },
    { kind: "worker-picker.requested", payload: { requestId: "w1" } },
    { kind: "tool.started", payload: { requestId: "ignored" } },
    { kind: "approval.requested", payload: {} },
    { kind: "approval.requested" },
  ];
  assert.deepEqual(openRequests(acts), { approvals: ["a2"], userInputs: ["q1"], pickers: ["w1"] });
  assert.deepEqual(openRequests([]), { approvals: [], userInputs: [], pickers: [] });
});
