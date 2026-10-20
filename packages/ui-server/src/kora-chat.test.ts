// @effect-diagnostics globalDate:off -- the engine under test uses plain timestamps; node:test mock timers drive them.
// @effect-diagnostics nodeBuiltinImport:off -- a throwaway KORA_HOME for the engine's persisted projection.
// The chat engine's Kora-authored turns (swarm S1, CP3): ONE flushPending for the mode notice + worker notes,
// the notice kept out of the user's bubble, the mode toggle, and X4 — a leader rate limit collects worker notes
// and delivers exactly one digest turn after the reset.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { setHost, type KoraPendingModeNotice, type UiHost } from "./host.ts";

process.env.KORA_HOME = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-chat-test-"));

type Turn = { threadId: string; text?: string; origin?: string; koraNotice?: string };

/** A fake daemon: the runtime's notify seam + a SessionManager that records turns and keeps notices like the runtime. */
function fakeHost() {
  const notifyListeners: Array<(m: string, p: unknown) => void> = [];
  const turns: Turn[] = [];
  const modes = new Map<string, string>();
  const permCalls: Array<{ id: string; mode: string; beforeTurns: number }> = [];
  const modelCalls: Array<{ id: string; model: string; effort?: string }> = [];
  const notices = new Map<string, KoraPendingModeNotice | null>();
  let n = 0;
  const sessions = {
    create: (p: { agent: string; cwd: string; agentMode?: string }) => {
      const id = `k${++n}`;
      modes.set(id, p.agentMode ?? "chat");
      notices.set(
        id,
        p.agentMode === "swarm"
          ? { from: "chat", to: "swarm", text: "[kora] NOTICE swarm on" }
          : null,
      );
      return { id, title: "t", agent: p.agent, cwd: p.cwd };
    },
    setPermissionMode: (id: string, mode: string) => {
      permCalls.push({ id, mode, beforeTurns: turns.length });
    },
    setOrchestrator: async () => ({}),
    changeModel: async (id: string, m: { model: string; effort?: string }) => {
      modelCalls.push({ id, model: m.model, ...(m.effort ? { effort: m.effort } : {}) });
    },
    setAgentMode: async (id: string, mode: string) => {
      const from = modes.get(id) ?? "chat";
      modes.set(id, mode);
      const notice =
        mode === "swarm" || from === "swarm"
          ? ({ from, to: mode, text: `[kora] NOTICE ${from}->${mode}` } as KoraPendingModeNotice)
          : null;
      notices.set(id, notice);
      return { thread: { id, title: "t", agent: "claude", cwd: "/r" }, notice };
    },
    takeModeNotice: (id: string) => {
      const v = notices.get(id) ?? null;
      notices.set(id, null);
      return v;
    },
    sendTurn: async (p: Turn) => {
      turns.push(p);
      return { turnId: `turn_${turns.length}` };
    },
    interrupt: async () => {},
    delete: async () => {},
    respondApproval: async () => {},
    respondUserInput: async () => {},
  };
  const runtime = {
    panes: new Map(),
    graph: {
      callTool: async () => ({ text: "", data: null, ms: 0 }),
      status: async () => ({ indexed: false }),
    },
    noteSource: null,
    on: (_e: string, fn: (m: string, p: unknown) => void) => {
      notifyListeners.push(fn);
    },
  };
  const fleetOps = {
    list: () => [],
    prompt: async () => ({}),
    wait: async () => ({}),
    read: () => "",
    kill: () => {},
    mergeVerify: async () => ({ pairs: [], order: [] }),
    merge: () => ({
      ok: true,
      merged: null,
      into: null,
      conflicts: [],
      message: "",
      commitsMerged: 0,
    }),
    setPlan: () => {},
    getPlan: () => "",
  };
  const h = {
    runtime,
    sessions,
    managerRuntime: { notify: () => {} },
    makeFleetOps: () => fleetOps,
    proxyPaneId: (id: string) => `chat:${id}`,
    listClaudeModels: async () => null,
    version: "test",
    log: () => {},
    swarm: {},
  } as unknown as UiHost;
  const notify = (koraThreadId: string, ev: Record<string, unknown>) => {
    for (const l of notifyListeners)
      l("chat.event", { threadId: koraThreadId, seq: 0, at: Date.now(), ...ev });
  };
  return { h, turns, notify, notices, permCalls, modelCalls };
}

const fake = fakeHost();
setHost(fake.h);
const { chatEngine } = await import("./kora-chat.ts");
const engine = chatEngine();
const internals = engine as unknown as {
  threads: Map<
    string,
    {
      koraThreadId: string;
      messages: Array<{ text: string; role: string; notice?: unknown }>;
      modelSelection: {
        instanceId: string;
        model: string;
        options?: Array<{ id: string; value: string }>;
      };
    }
  >;
  onWorkerEvent(threadId: string, event: unknown): void;
};

let seq = 0;
async function newThread(agentMode: "chat" | "orchestrator" | "swarm", instanceId = "claude") {
  const threadId = `th${++seq}`;
  await engine.dispatch({
    type: "createThread",
    threadId,
    projectId: "p1",
    title: "t",
    modelSelection: { instanceId, model: "m" },
    runtimeMode: "full-access",
    interactionMode: "default",
    agentMode,
    branch: null,
    worktreePath: "/r",
    createdAt: new Date().toISOString(),
  } as never);
  const kora = internals.threads.get(threadId)!.koraThreadId;
  return { threadId, kora };
}
async function userTurn(threadId: string, text: string, modelPick?: unknown) {
  await engine.dispatch({
    type: "turn.start",
    threadId,
    message: { messageId: `m_${++seq}`, text, attachments: [] },
    ...(modelPick ? { modelSelection: modelPick } : {}),
    createdAt: new Date().toISOString(),
  } as never);
}
const messages = (threadId: string) => internals.threads.get(threadId)!.messages;
const activities = (threadId: string) => engine.getThreadDetail(threadId)!.thread.activities;
const report = (paneId: string) => ({
  kind: "swarm-report",
  paneId,
  taskId: `task-${paneId}`,
  verify: { state: "passed", bounces: 0, summary: null },
});
const turnsFor = (kora: string) => fake.turns.filter((t) => t.threadId === kora);

NodeTest.test(
  "every user turn re-asserts the composer's permission mode before the session runs (old heads carry none)",
  async () => {
    const { threadId, kora } = await newThread("chat");
    fake.permCalls.length = 0;
    const before = fake.turns.length;
    await userTurn(threadId, "hello");
    const call = fake.permCalls.find((c) => c.id === kora);
    NodeAssert.ok(call, "setPermissionMode called for the turn");
    NodeAssert.equal(call.mode, "full-access");
    NodeAssert.equal(call.beforeTurns, before, "mode lands BEFORE sendTurn");
  },
);

NodeTest.test(
  "a thread created in swarm: the notice rides on the first user turn and never shows in the bubble",
  async () => {
    const { threadId, kora } = await newThread("swarm");
    await userTurn(threadId, "build the thing");
    const t = turnsFor(kora)[0]!;
    NodeAssert.equal(t.text, "build the thing");
    NodeAssert.equal(t.koraNotice, "[kora] NOTICE swarm on");
    const bubble = messages(threadId).at(-1)!;
    NodeAssert.equal(bubble.text, "build the thing", "the bubble shows only the user's text");
    NodeAssert.equal(bubble.notice, undefined);
    await userTurn(threadId, "again");
    NodeAssert.equal(turnsFor(kora)[1]!.koraNotice, undefined, "delivered once");
  },
);

NodeTest.test(
  "an idle switch to swarm sends nothing; the notice rides on the user's next message",
  async () => {
    NodeTest.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { threadId, kora } = await newThread("chat");
      await userTurn(threadId, "hello");
      fake.notify(kora, { type: "turn.started", turnId: "turn_1" });
      fake.notify(kora, { type: "turn.settled", turnId: "turn_1", state: "completed" });
      NodeTest.mock.timers.tick(500);
      const before = turnsFor(kora).length;
      await engine.dispatch({
        type: "setThreadAgentMode",
        threadId,
        agentMode: "swarm",
      } as never);
      NodeTest.mock.timers.tick(5_000);
      NodeAssert.equal(turnsFor(kora).length, before, "the switch alone starts no turn");
      NodeAssert.ok(
        activities(threadId).some((a) => a.kind === "agent-mode.switched"),
        "divider still shows",
      );
      await userTurn(threadId, "now go");
      const t = turnsFor(kora).at(-1)!;
      NodeAssert.equal(t.text, "now go");
      NodeAssert.ok(
        t.koraNotice?.startsWith("[kora] NOTICE chat->swarm"),
        "notice rides on the next user turn",
      );
    } finally {
      NodeTest.mock.timers.reset();
    }
  },
);

NodeTest.test(
  "a flip mid-turn: the divider lands at once; after the settle ONE combined turn (notice first, then notes)",
  async () => {
    NodeTest.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { threadId, kora } = await newThread("orchestrator");
      await userTurn(threadId, "hello");
      fake.notify(kora, { type: "turn.started", turnId: "turn_1" });
      // A worker note arrives mid-turn, then the human flips to swarm mid-turn: nothing is sent yet.
      internals.onWorkerEvent(threadId, {
        kind: "done",
        paneId: "p1",
        exitCode: 0,
        title: "slice",
      });
      await engine.dispatch({
        type: "setThreadAgentMode",
        threadId,
        agentMode: "swarm",
      } as never);
      NodeAssert.ok(
        activities(threadId).some((a) => a.kind === "agent-mode.switched"),
        "divider appended at once",
      );
      NodeAssert.equal(turnsFor(kora).length, 1, "mid-turn: held");
      fake.notify(kora, { type: "turn.settled", turnId: "turn_1", state: "completed" });
      NodeTest.mock.timers.tick(500);
      const sent = turnsFor(kora);
      NodeAssert.equal(sent.length, 2, "exactly one Kora turn");
      NodeAssert.equal(sent[1]!.origin, "kora-notice");
      NodeAssert.ok(sent[1]!.text!.startsWith("[kora] NOTICE orchestrator->swarm"));
      NodeAssert.ok(sent[1]!.text!.includes("worker p1"));
      const msg = messages(threadId).at(-1)!;
      NodeAssert.deepEqual(msg.notice, {
        kind: "agent-mode-switched",
        from: "orchestrator",
        to: "swarm",
      });
      NodeTest.mock.timers.tick(5_000);
      NodeAssert.equal(turnsFor(kora).length, 2, "no second flush");
    } finally {
      NodeTest.mock.timers.reset();
    }
  },
);

NodeTest.test(
  "X4: usage.rate-limit → 3 worker notes → exactly one digest turn after the reset",
  async () => {
    NodeTest.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
    try {
      const { threadId, kora } = await newThread("swarm");
      await userTurn(threadId, "go"); // takes the creation notice
      fake.notify(kora, { type: "turn.started", turnId: "turn_1" });
      fake.notify(kora, { type: "turn.settled", turnId: "turn_1", state: "failed" });
      fake.notify(kora, {
        type: "usage.rate-limit",
        message: "limit",
        resetsAt: Date.now() + 60_000,
      });
      const limited = activities(threadId).filter((a) => a.kind === "leader.rate-limited");
      NodeAssert.equal(limited.length, 1);
      NodeAssert.equal((limited[0]!.payload as { until: number }).until, Date.now() + 60_000);
      NodeTest.mock.timers.tick(500); // the settle flush: held by the limit
      internals.onWorkerEvent(threadId, report("p4"));
      internals.onWorkerEvent(threadId, report("p5"));
      internals.onWorkerEvent(threadId, {
        kind: "swarm-exhausted",
        paneId: "p6",
        taskId: "task-p6",
        tried: ["a", "b"],
      });
      NodeTest.mock.timers.tick(30_000);
      NodeAssert.equal(turnsFor(kora).length, 1, "nothing reaches a rate-limited leader");
      NodeTest.mock.timers.tick(40_000); // past the reset (+ grace)
      const sent = turnsFor(kora);
      NodeAssert.equal(sent.length, 2, "exactly one digest turn");
      NodeAssert.equal(sent[1]!.origin, "kora-notice");
      NodeAssert.ok(sent[1]!.text!.startsWith("[kora] While you were rate-limited"));
      for (const p of ["p4", "p5", "p6"]) NodeAssert.ok(sent[1]!.text!.includes(p), p);
      NodeAssert.deepEqual(messages(threadId).at(-1)!.notice, { kind: "fleet-note" });
      NodeTest.mock.timers.tick(600_000);
      NodeAssert.equal(turnsFor(kora).length, 2, "still one");
    } finally {
      NodeTest.mock.timers.reset();
    }
  },
);

NodeTest.test("a Codex or OpenCode thread leads a swarm, at create and at the toggle", async () => {
  const { threadId } = await newThread("chat", "codex");
  await engine.dispatch({ type: "setThreadAgentMode", threadId, agentMode: "swarm" } as never);
  NodeAssert.equal(engine.getThreadDetail(threadId)!.thread.agentMode, "swarm");
  NodeAssert.ok(!activities(threadId).some((a) => a.tone === "error"));
  for (const driver of ["codex", "opencode"]) {
    const created = await newThread("swarm", driver);
    NodeAssert.equal(engine.getThreadDetail(created.threadId)!.thread.agentMode, "swarm", driver);
  }
});

NodeTest.test(
  "Antigravity has no fleet bridge: a swarm/orchestrator draft starts as chat and orchestrator is refused",
  async () => {
    for (const mode of ["swarm", "orchestrator"] as const) {
      const made = await newThread(mode, "antigravity");
      NodeAssert.equal(engine.getThreadDetail(made.threadId)!.thread.agentMode, "chat", mode);
    }
    const { threadId } = await newThread("chat", "antigravity");
    await engine.dispatch({
      type: "setThreadAgentMode",
      threadId,
      agentMode: "orchestrator",
    } as never);
    NodeAssert.equal(engine.getThreadDetail(threadId)!.thread.agentMode, "chat");
    NodeAssert.ok(
      activities(threadId).some(
        (a) => a.tone === "error" && /Orchestrator isn't available/.test(a.summary),
      ),
    );
    const codex = await newThread("orchestrator", "codex");
    NodeAssert.equal(engine.getThreadDetail(codex.threadId)!.thread.agentMode, "orchestrator");
  },
);

NodeTest.test(
  "a plain chat thread hears its workers too (chat delegates through kora_spawn)",
  async () => {
    NodeTest.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const chat = await newThread("chat");
      await userTurn(chat.threadId, "x");
      fake.notify(chat.kora, { type: "turn.started", turnId: "t" });
      fake.notify(chat.kora, { type: "turn.settled", turnId: "t", state: "completed" });
      NodeTest.mock.timers.tick(500);
      internals.onWorkerEvent(chat.threadId, report("p9"));
      NodeTest.mock.timers.tick(5_000);
      NodeAssert.equal(turnsFor(chat.kora).length, 2, "the worker's report reaches the chat lead");
    } finally {
      NodeTest.mock.timers.reset();
    }
  },
);

NodeTest.test(
  "the leader's measured tokens are summed per settled turn (the swarm value meter reads them)",
  async () => {
    const { threadId, kora } = await newThread("swarm");
    const usage = (input: number, cached: number, output: number) => ({
      usageStatus: "complete",
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
    });
    fake.notify(kora, { type: "turn.started", turnId: "u1" });
    fake.notify(kora, {
      type: "turn.settled",
      turnId: "u1",
      state: "completed",
      usage: usage(100, 20_000, 400),
    });
    fake.notify(kora, { type: "turn.started", turnId: "u2" });
    fake.notify(kora, {
      type: "turn.settled",
      turnId: "u2",
      state: "completed",
      usage: usage(50, 30_000, 100),
    });
    // an unavailable usage is not a turn of measured tokens
    fake.notify(kora, { type: "turn.started", turnId: "u3" });
    fake.notify(kora, {
      type: "turn.settled",
      turnId: "u3",
      state: "completed",
      usage: { usageStatus: "unavailable" },
    });
    NodeAssert.deepEqual(
      (engine as unknown as { threads: Map<string, { leaderUsage?: unknown }> }).threads.get(
        threadId,
      )!.leaderUsage,
      { input: 150, cached: 50_000, output: 500, turns: 2 },
    );
  },
);

NodeTest.test(
  "plan mode on a harness without a plan tool: a plan reply becomes the plan card, a clarifying question does not",
  async () => {
    const { threadId, kora } = await newThread("chat");
    const rec = (engine as unknown as { threads: Map<string, any> }).threads.get(threadId)!;
    rec.providerDriver = "codex";
    rec.interactionMode = "plan";
    const reply = async (turnId: string, text: string) => {
      fake.notify(kora, { type: "turn.started", turnId });
      fake.notify(kora, {
        type: "content.delta",
        turnId,
        stream: "assistant_text",
        itemId: `i_${turnId}`,
        delta: text,
      });
      fake.notify(kora, { type: "turn.settled", turnId, state: "completed" });
    };
    await reply("turn_q", "Which database should this use?");
    NodeAssert.equal(rec.proposedPlans?.length ?? 0, 0, "a question is not a plan");
    await reply("turn_p", "## Plan\n1. Add the table\n2. Wire the repository\n3. Test it");
    NodeAssert.equal(rec.proposedPlans?.length, 1);
    NodeAssert.match(rec.proposedPlans[0].planMarkdown, /Add the table/);
  },
);

NodeTest.test(
  "content.delta: a new itemId mid-turn (a text block after a tool call) gets a paragraph break",
  async () => {
    const { threadId, kora } = await newThread("chat");
    await userTurn(threadId, "go");
    fake.notify(kora, { type: "turn.started", turnId: "turn_1" });
    fake.notify(kora, {
      type: "content.delta",
      turnId: "turn_1",
      stream: "assistant_text",
      itemId: "item_1",
      delta: "blocking them.",
    });
    // A tool call happens between the two text items (no content.delta for it).
    fake.notify(kora, {
      type: "content.delta",
      turnId: "turn_1",
      stream: "assistant_text",
      itemId: "item_2",
      delta: "The free swarm workers are stuck.",
    });
    const bubble = messages(threadId).at(-1)!;
    NodeAssert.equal(bubble.text, "blocking them.\n\nThe free swarm workers are stuck.");
  },
);

NodeTest.test(
  "content.delta: the SAME itemId after an intervening question/tool still starts a new paragraph",
  async () => {
    const { threadId, kora } = await newThread("chat");
    await userTurn(threadId, "go");
    fake.notify(kora, { type: "turn.started", turnId: "turn_1" });
    const text = (delta: string) =>
      fake.notify(kora, {
        type: "content.delta",
        turnId: "turn_1",
        stream: "assistant_text",
        itemId: "turn_1:text:0",
        delta,
      });
    text("not free ones).");
    fake.notify(kora, {
      type: "tool.started",
      turnId: "turn_1",
      itemId: "tool_1",
      toolKind: "dynamic_tool_call",
      toolName: "AskUserQuestion",
      title: "Question",
    });
    text("Go ahead and enable it.");
    NodeAssert.equal(messages(threadId).at(-1)!.text, "not free ones).\n\nGo ahead and enable it.");
  },
);

NodeTest.test(
  "content.delta: deltas within the SAME itemId concatenate with no inserted break",
  async () => {
    const { threadId, kora } = await newThread("chat");
    await userTurn(threadId, "go");
    fake.notify(kora, { type: "turn.started", turnId: "turn_1" });
    fake.notify(kora, {
      type: "content.delta",
      turnId: "turn_1",
      stream: "assistant_text",
      itemId: "item_1",
      delta: "Good, confirmed ",
    });
    fake.notify(kora, {
      type: "content.delta",
      turnId: "turn_1",
      stream: "assistant_text",
      itemId: "item_1",
      delta: "KV-cache numbers.",
    });
    const bubble = messages(threadId).at(-1)!;
    NodeAssert.equal(bubble.text, "Good, confirmed KV-cache numbers.");
  },
);

NodeTest.test(
  "content.delta: a new itemId is not double-separated when the prior block already ends in whitespace",
  async () => {
    const { threadId, kora } = await newThread("chat");
    await userTurn(threadId, "go");
    fake.notify(kora, { type: "turn.started", turnId: "turn_1" });
    fake.notify(kora, {
      type: "content.delta",
      turnId: "turn_1",
      stream: "assistant_text",
      itemId: "item_1",
      delta: "First block.\n\n",
    });
    fake.notify(kora, {
      type: "content.delta",
      turnId: "turn_1",
      stream: "assistant_text",
      itemId: "item_2",
      delta: "Second block.",
    });
    const bubble = messages(threadId).at(-1)!;
    NodeAssert.equal(bubble.text, "First block.\n\nSecond block.");
  },
);

NodeTest.test(
  "composer chips reach the model: startTurn expands context records, the bubble keeps the raw text",
  async () => {
    const { threadId, kora } = await newThread("chat");
    const text = "why does [T1](kora-context://v1/terminal/ctx_t) fail?";
    const context = {
      records: [
        {
          version: 1,
          contextId: "ctx_t",
          kind: "terminal",
          label: "T1",
          terminalId: "term-1",
          terminalLabel: "Terminal 1",
          lineStart: 1,
          lineEnd: 1,
          text: "boom",
        },
      ],
    };
    await engine.dispatch({
      type: "turn.start",
      threadId,
      message: { messageId: `m_${++seq}`, text, attachments: [], context },
      createdAt: new Date().toISOString(),
    } as never);
    const sent = turnsFor(kora).at(-1)!;
    NodeAssert.match(sent.text ?? "", /<context kind="terminal" id="ctx_t">/);
    NodeAssert.match(sent.text ?? "", /boom/);
    const bubble = messages(threadId).at(-1)! as { text: string; context?: unknown };
    NodeAssert.equal(bubble.text, text);
    NodeAssert.deepEqual(bubble.context, context);
  },
);

NodeTest.test(
  "the model and effort the composer shows are the ones the session gets: a turn that changes them is applied first",
  async () => {
    const { threadId, kora } = await newThread("chat"); // created on { instanceId: "claude", model: "m" }
    fake.modelCalls.length = 0;
    await userTurn(threadId, "same selection", { instanceId: "claude", model: "m" });
    NodeAssert.equal(fake.modelCalls.length, 0, "an unchanged selection is a no-op");
    await userTurn(threadId, "switch", {
      instanceId: "claude",
      model: "sonnet",
      options: [{ id: "effort", value: "low" }],
    });
    NodeAssert.deepEqual(fake.modelCalls, [{ id: kora, model: "sonnet", effort: "low" }]);
    const head = internals.threads.get(threadId)!.modelSelection;
    NodeAssert.equal(head.model, "sonnet", "the thread record follows the picker");
    NodeAssert.equal(head.options?.[0]?.value, "low");
    await userTurn(threadId, "back to default effort", { instanceId: "claude", model: "sonnet" });
    NodeAssert.deepEqual(
      fake.modelCalls.at(-1),
      { id: kora, model: "sonnet" },
      "dropping the effort is a change too",
    );
  },
);

NodeTest.test(
  "a thread.meta.update carrying a model selection applies it; a selection from another provider is ignored",
  async () => {
    const { threadId, kora } = await newThread("chat");
    fake.modelCalls.length = 0;
    await engine.dispatch({
      type: "updateThreadMeta",
      threadId,
      modelSelection: { instanceId: "claude", model: "haiku" },
    } as never);
    NodeAssert.deepEqual(fake.modelCalls, [{ id: kora, model: "haiku" }]);
    await engine.dispatch({
      type: "updateThreadMeta",
      threadId,
      modelSelection: { instanceId: "codex", model: "gpt-5.5" },
    } as never);
    NodeAssert.equal(fake.modelCalls.length, 1, "a Claude thread never becomes a Codex one");
    NodeAssert.equal(internals.threads.get(threadId)!.modelSelection.model, "haiku");
  },
);

NodeTest.test(
  "a worker that went idle on an error: the lead gets a STOPPED note (not left waiting)",
  async () => {
    NodeTest.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const chat = await newThread("chat");
      await userTurn(chat.threadId, "x");
      fake.notify(chat.kora, { type: "turn.started", turnId: "t" });
      fake.notify(chat.kora, { type: "turn.settled", turnId: "t", state: "completed" });
      NodeTest.mock.timers.tick(500);
      internals.onWorkerEvent(chat.threadId, {
        kind: "idle",
        paneId: "p2",
        title: "Agent memory graphs",
        tail: "■ You’ve hit your usage limit.",
        problem: "■ You’ve hit your usage limit.",
        idleSince: Date.now(),
      });
      NodeTest.mock.timers.tick(5_000);
      const sent = turnsFor(chat.kora).at(-1)!;
      NodeAssert.match(sent.text!, /worker p2 \("Agent memory graphs"\) STOPPED on an error/);
      NodeAssert.match(sent.text!, /usage limit/);
      NodeAssert.ok(activities(chat.threadId).some((a) => a.kind === "worker.idle"));
    } finally {
      NodeTest.mock.timers.reset();
    }
  },
);

NodeTest.test(
  "an idle worker the lead already looked at (kora_wait / kora_read) gets the transcript row but no extra turn",
  async () => {
    NodeTest.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const chat = await newThread("chat");
      await userTurn(chat.threadId, "x");
      fake.notify(chat.kora, { type: "turn.started", turnId: "t" });
      fake.notify(chat.kora, { type: "turn.settled", turnId: "t", state: "completed" });
      NodeTest.mock.timers.tick(500);
      const before = turnsFor(chat.kora).length;
      (engine as any).leadSawWorker.set("p4", Date.now() + 1000);
      internals.onWorkerEvent(chat.threadId, {
        kind: "idle",
        paneId: "p4",
        title: "beta",
        tail: "⏺ beta",
        problem: null,
        idleSince: Date.now(),
      });
      NodeTest.mock.timers.tick(5_000);
      NodeAssert.equal(turnsFor(chat.kora).length, before, "no extra turn");
      NodeAssert.ok(
        activities(chat.threadId).some((a) => a.kind === "worker.idle"),
        "row still shown",
      );
    } finally {
      NodeTest.mock.timers.reset();
    }
  },
);

NodeTest.test(
  "a stalled worker wakes an idle lead; a stalled note is dropped once the worker wrote again",
  async () => {
    NodeTest.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const chat = await newThread("chat");
      await userTurn(chat.threadId, "x");
      fake.notify(chat.kora, { type: "turn.started", turnId: "t" });
      fake.notify(chat.kora, { type: "turn.settled", turnId: "t", state: "completed" });
      NodeTest.mock.timers.tick(500);
      const panes = (engine as any).runtime.panes as Map<string, any>;
      const quietSince = Date.now() - 6 * 60_000;
      panes.set("p6", { id: "p6", state: "working", exited: false, lastOutputAt: quietSince });
      const stalled = {
        kind: "stalled",
        paneId: "p6",
        title: "hung",
        quietMs: 6 * 60_000,
        tail: "✻ Thinking…",
        lastOutputAt: quietSince,
      };
      const before = turnsFor(chat.kora).length;
      internals.onWorkerEvent(chat.threadId, stalled);
      NodeTest.mock.timers.tick(5_000);
      NodeAssert.equal(turnsFor(chat.kora).length, before + 1);
      NodeAssert.match(
        turnsFor(chat.kora).at(-1)!.text!,
        /worker p6 \("hung"\) says it is working but has written nothing for 6 min/,
      );
      NodeAssert.ok(activities(chat.threadId).some((a) => a.kind === "worker.stalled"));
      fake.notify(chat.kora, { type: "turn.started", turnId: "t2" });
      fake.notify(chat.kora, { type: "turn.settled", turnId: "t2", state: "completed" });
      NodeTest.mock.timers.tick(500);
      const after = turnsFor(chat.kora).length;
      (engine as any).leadSawWorker.delete("p6");
      panes.get("p6").lastOutputAt = Date.now(); // it moved on before the lead could hear
      internals.onWorkerEvent(chat.threadId, stalled);
      NodeTest.mock.timers.tick(5_000);
      NodeAssert.equal(turnsFor(chat.kora).length, after, "stale stalled note: no turn");
      panes.delete("p6");
    } finally {
      NodeTest.mock.timers.reset();
    }
  },
);

NodeTest.test(
  "context meter: every token-usage field reaches the activity, tied to its turn, and only the newest row is kept",
  async () => {
    const { threadId, kora } = await newThread("chat");
    await userTurn(threadId, "hello");
    fake.notify(kora, { type: "turn.started", turnId: "turn_1" });
    fake.notify(kora, {
      type: "thread.token-usage",
      turnId: "turn_1",
      usage: {
        usedTokens: 42_756,
        maxTokens: 1_000_000,
        cachedInputTokens: 42_500,
        source: "estimate",
      },
    });
    fake.notify(kora, {
      type: "thread.token-usage",
      turnId: "turn_1",
      usage: {
        usedTokens: 44_850,
        maxTokens: 1_000_000,
        autoCompactThreshold: 967_000,
        compactsAutomatically: true,
        costUsd: 0.0123,
        source: "provider",
      },
    });
    const rows = activities(threadId).filter((a) => a.kind === "context-window.updated");
    NodeAssert.equal(rows.length, 1, "superseded readings are dropped from the persisted thread");
    const p = rows[0]!.payload as Record<string, unknown>;
    NodeAssert.equal(rows[0]!.turnId, "turn_1");
    NodeAssert.equal(p.usedTokens, 44_850);
    NodeAssert.equal(p.maxTokens, 1_000_000);
    NodeAssert.equal(p.autoCompactThreshold, 967_000);
    NodeAssert.equal(p.compactsAutomatically, true);
    NodeAssert.equal(p.costUsd, 0.0123);
    NodeAssert.equal(p.source, "provider");
    NodeAssert.equal(p.cachedInputTokens, null, "absent fields are null, never undefined");
  },
);

NodeTest.test(
  "a usage limit from any thread lands on the provider's usage view with its reset",
  async () => {
    const { daemonConfig } = await import("./config.ts");
    const { threadId, kora } = await newThread("chat", "codex");
    await userTurn(threadId, "hello");
    const resetsAt = Date.parse("2026-10-16T14:55:00Z");
    fake.notify(kora, {
      type: "usage.rate-limit",
      message: "You’ve hit your usage limit.",
      resetsAt,
    });
    fake.notify(kora, {
      type: "usage.limits",
      report: { provider: "codex", windows: [], limited: true, resetsAt },
    });
    const codex = daemonConfig.providers.find((p) => p.instanceId === "codex")!;
    NodeAssert.deepEqual(codex.usageLimits?.limited, {
      resetsAt: "2026-10-16T14:55:00.000Z",
      message: "You’ve hit your usage limit.",
    });
  },
);

NodeTest.test("a compaction leaves one visible row with its before/after sizes", async () => {
  const { threadId, kora } = await newThread("chat");
  await userTurn(threadId, "/compact");
  fake.notify(kora, {
    type: "context.compacted",
    trigger: "manual",
    preTokens: 32_829,
    postTokens: 1_124,
    turnId: "turn_9",
  });
  const row = activities(threadId).find((a) => a.kind === "context-compaction")!;
  NodeAssert.equal(row.summary, "Context compacted · 32.8k → 1.1k tokens of conversation");
  NodeAssert.equal(row.tone, "info");
});

NodeTest.test(
  "after a daemon restart killed a fleet lead's turn, the restart note rides ONCE on its next turn (not in the bubble)",
  async () => {
    const { FLEET_RESTART_NOTE } = await import("./kora-chat.ts");
    const { threadId, kora } = await newThread("swarm");
    await userTurn(threadId, "build it"); // takes the swarm-on notice
    // What hydrate sets for an interrupted fleet thread.
    (internals.threads.get(threadId) as unknown as { restartNote?: string }).restartNote =
      FLEET_RESTART_NOTE;
    await userTurn(threadId, "continue");
    const t = turnsFor(kora).at(-1)!;
    NodeAssert.equal(t.text, "continue");
    NodeAssert.equal(t.koraNotice, FLEET_RESTART_NOTE);
    NodeAssert.match(t.koraNotice!, /kora_workers/);
    NodeAssert.equal(
      messages(threadId).at(-1)!.text,
      "continue",
      "the bubble shows only the user's text",
    );
    await userTurn(threadId, "and again");
    NodeAssert.equal(turnsFor(kora).at(-1)!.koraNotice, undefined, "delivered once");
  },
);

// QA 2026-10-10 (swarm S1-1): a worker finishing after the human pressed Stop woke the lead into a turn nobody asked for.
NodeTest.test(
  "Stop on a swarm lead holds worker notes (no wake-up); the next user message carries one STOP note with what collected",
  async () => {
    const { threadId, kora } = await newThread("swarm");
    await userTurn(threadId, "go");
    fake.notify(kora, { type: "turn.started", turnId: "turn_1" });
    fake.notify(kora, { type: "turn.settled", turnId: "turn_1", state: "completed" });
    const before = turnsFor(kora).length;
    await engine.dispatch({ type: "turn.interrupt", threadId } as never);
    internals.onWorkerEvent(threadId, report("p9"));
    internals.onWorkerEvent(threadId, {
      kind: "idle",
      paneId: "p8",
      title: "t",
      tail: "",
      idleSince: 0,
    });
    NodeAssert.equal(turnsFor(kora).length, before, "a note after Stop never wakes the lead");
    await userTurn(threadId, "ok, carry on");
    const t = turnsFor(kora).at(-1)!;
    NodeAssert.match(t.koraNotice ?? "", /the human pressed STOP/);
    NodeAssert.match(t.koraNotice ?? "", /may have STARTED a worker/);
    NodeAssert.match(
      t.koraNotice ?? "",
      /swarm worker p9/,
      "the note that collected rides on this turn",
    );
    // released: a later worker note flows again once the lead is idle
    fake.notify(kora, { type: "turn.started", turnId: "turn_2" });
    fake.notify(kora, { type: "turn.settled", turnId: "turn_2", state: "completed" });
    const n = turnsFor(kora).length;
    internals.onWorkerEvent(threadId, report("p10"));
    NodeAssert.equal(
      turnsFor(kora).length,
      n + 1,
      "notes wake the lead again after the person wrote",
    );
  },
);

NodeTest.test("isFolderTrustPrompt: an agent's trust dialog, not any blocker", async () => {
  const { isFolderTrustPrompt } = await import("./kora-chat.ts");
  NodeAssert.equal(
    isFolderTrustPrompt("Quick safety check: Is this a project you created or one you trust?"),
    true,
  );
  NodeAssert.equal(isFolderTrustPrompt("Do you trust the files in this folder?"), true);
  NodeAssert.equal(isFolderTrustPrompt("Allow Bash(rm -rf build)?"), false);
  NodeAssert.equal(isFolderTrustPrompt(null), false);
});

NodeTest.test(
  "the thread head says when it waits on an approval or a question, and pushes the change (pl4 S2-1)",
  async () => {
    const { threadId, kora } = await newThread("chat");
    const heads: Array<{ hasPendingApprovals: boolean; hasPendingUserInput: boolean }> = [];
    const listener = (item: { kind: string; thread?: { id: string } }) => {
      if (item.kind === "thread-upserted" && item.thread?.id === threadId)
        heads.push(item.thread as never);
    };
    const listeners = (engine as unknown as { shellListeners: Set<typeof listener> })
      .shellListeners;
    listeners.add(listener);
    try {
      fake.notify(kora, { type: "turn.started", turnId: "ta" });
      fake.notify(kora, {
        type: "approval.opened",
        requestId: "ra",
        requestKind: "command",
        title: "Run a command",
        turnId: "ta",
      });
      NodeAssert.equal(heads.at(-1)?.hasPendingApprovals, true, "approval opened → flag on");
      NodeAssert.equal(heads.at(-1)?.hasPendingUserInput, false);
      fake.notify(kora, { type: "approval.resolved", requestId: "ra", decision: "accept" });
      NodeAssert.equal(heads.at(-1)?.hasPendingApprovals, false, "answered → flag off");
      fake.notify(kora, {
        type: "user-input.requested",
        requestId: "rq",
        questions: [],
        turnId: "ta",
      });
      NodeAssert.equal(heads.at(-1)?.hasPendingUserInput, true, "question open → flag on");
      fake.notify(kora, { type: "user-input.resolved", requestId: "rq", answers: {} });
      NodeAssert.equal(heads.at(-1)?.hasPendingUserInput, false);
    } finally {
      listeners.delete(listener);
    }
  },
);

NodeTest.test("project rename and icon persist (pl4 S2-2)", async () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-proj-meta-"));
  await engine.dispatch({
    type: "createProject",
    projectId: "pmeta",
    title: "Repo",
    workspaceRoot: dir,
    createdAt: new Date().toISOString(),
  } as never);
  await engine.dispatch({
    type: "updateProjectMeta",
    projectId: "pmeta",
    title: "Renamed",
    projectIcon: { kind: "lucide", name: "terminal" },
  } as never);
  const projects = JSON.parse(
    NodeFS.readFileSync(
      NodePath.join(process.env.KORA_HOME!, "kora-daemon", "projects.json"),
      "utf8",
    ),
  ) as Array<{ id: string; title: string; projectIcon?: unknown }>;
  const p = projects.find((x) => x.id === "pmeta");
  NodeAssert.equal(p?.title, "Renamed");
  NodeAssert.deepEqual(p?.projectIcon, { kind: "lucide", name: "terminal" });
  await NodeAssert.rejects(
    engine.dispatch({ type: "updateProjectMeta", projectId: "nope", title: "x" } as never),
  );
});

NodeTest.test("archive and unarchive reach the runtime chat store (pl1 S3-2)", async () => {
  const { threadId, kora } = await newThread("chat");
  const calls: string[] = [];
  const sessions = (fake.h as unknown as { sessions: Record<string, unknown> }).sessions;
  sessions.archive = (id: string) => calls.push(`archive:${id}`);
  sessions.unarchive = (id: string) => calls.push(`unarchive:${id}`);
  sessions.stop = async (id: string) => {
    calls.push(`stop:${id}`);
  };
  try {
    await engine.dispatch({ type: "archiveThread", threadId } as never);
    await engine.dispatch({ type: "unarchiveThread", threadId } as never);
    // Archiving also stops the provider session (aud1 S3-4); unarchiving never starts one.
    NodeAssert.deepEqual(calls, [`archive:${kora}`, `stop:${kora}`, `unarchive:${kora}`]);
  } finally {
    delete sessions.archive;
    delete sessions.unarchive;
    delete sessions.stop;
  }
});

NodeTest.test(
  "removing a project cleans Kora's entries in its repo, unless another project shares it",
  async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-proj-clean-"));
    const cleaned: string[] = [];
    const h = fake.h as unknown as { removeRepoFootprint?: (cwd: string) => Promise<unknown> };
    h.removeRepoFootprint = async (cwd: string) => {
      cleaned.push(cwd);
      return { root: cwd, removed: [], trustRevoked: false };
    };
    const mk = (projectId: string) =>
      engine.dispatch({
        type: "createProject",
        projectId,
        title: "Repo",
        workspaceRoot: dir,
        createdAt: new Date().toISOString(),
      } as never);
    try {
      await mk("pclean-a");
      await mk("pclean-b");
      await engine.dispatch({ type: "deleteProject", projectId: "pclean-a" } as never);
      NodeAssert.deepEqual(cleaned, [], "another project still uses the folder");
      await engine.dispatch({ type: "deleteProject", projectId: "pclean-b" } as never);
      NodeAssert.deepEqual(cleaned, [dir]);
    } finally {
      delete h.removeRepoFootprint;
    }
  },
);
