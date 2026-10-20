"use strict";
// Model test: Team·Orchestrator spawns ONE worker (a free OpenCode worker, not Claude) and merges its work.
// One Claude leader turn against the isolated swarm-e2e daemon (:8798). Pass = a worker attached, kora_merge ran,
// and src/hello.js exists on the main checkout with the expected export.
// Usage: node qa/e2e/model/orchestrator.cjs   (writes qa/findings/model.jsonl on failure)
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const E2E = path.resolve(__dirname, "../../../packages/runtime/scripts/swarm-e2e");
const { RT, BASE, env } = require(path.join(E2E, "env.cjs"));
const { KoraClient } = require(path.join(RT, "dist/protocol/client.js"));
const FINDINGS = path.resolve(__dirname, "../../findings/model.jsonl");

(async () => {
  const dir = path.join(BASE, "repos", `qa-orch-${Date.now().toString(36)}`);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/index.js"), "export const x = 1;\n");
  const g = (...a) =>
    execFileSync("git", ["-c", "user.email=qa@kora.local", "-c", "user.name=Kora QA", ...a], {
      cwd: dir,
      encoding: "utf8",
    });
  g("init", "-q", "-b", "main");
  g("add", ".");
  g("commit", "-qm", "init");

  const c = new KoraClient(env.KORA_SOCKET_PATH);
  await c.connect(5000);
  const th = await c.call("chat.thread.create", {
    agent: "claude",
    cwd: dir,
    agentMode: "orchestrator",
    model: { model: "claude-sonnet-5" },
    title: "qa orchestrator",
  });
  const id = th.id ?? th.threadId;
  await c.call("chat.session.setPermissionMode", { threadId: id, mode: "full-access" });
  await c.call("chat.events.subscribe", { threadIds: [id] });
  const tools = [];
  let mergedResult = false; // MCP fleet calls reach the socket as tool.result text, not tool.started names
  let attached = 0;
  let pickerShown = 0;
  let settled = null;
  const t0 = Date.now();
  const done = new Promise((resolve) => {
    c.on("chat.event", (e) => {
      if (e?.threadId !== id) return;
      if (e.type === "tool.started") tools.push(e.toolName);
      if (e.type === "worker.attached") attached++;
      // The user picks the workers (worker picker): approve the lead's proposal as-is, like a click on Approve.
      // Without this the lead waits on kora_ask_workers forever (the spec predates the picker and hung 10+ min).
      if (e.type === "worker-picker.requested") {
        pickerShown++;
        c.call("chat.userInput.respond", {
          threadId: id,
          requestId: e.requestId,
          answers: { picks: e.picks },
        }).catch(() => {});
      }
      if (e.type === "tool.result" && /^merged:/m.test(String(e.output ?? ""))) mergedResult = true;
      if (e.type === "turn.settled") {
        settled = e;
        resolve();
      }
    });
    setTimeout(resolve, 15 * 60_000).unref();
  });
  await c.call("chat.turn.send", {
    threadId: id,
    text: [
      "Orchestrate exactly ONE worker, then merge it. Do not write the file yourself.",
      '1. kora_spawn with agent:"opencode", worktree:true, title:"hello", and this prompt: "Create src/hello.js containing exactly `export const hello = () => \'hi\';` and commit it with message \'add hello\'. Nothing else."',
      "2. kora_wait for that worker until it is done.",
      "3. kora_merge that worker.",
      "Then reply with one line: MERGED or FAILED plus the reason.",
    ].join("\n"),
  });
  await done;
  const file = path.join(dir, "src/hello.js");
  const ok = fs.existsSync(file) && /hello/.test(fs.readFileSync(file, "utf8"));
  const merged = mergedResult || tools.some((t) => /kora_merge/.test(t));
  const log = g("log", "--oneline").trim();
  const res = {
    settled: settled && { state: settled.state, error: settled.errorMessage ?? null },
    secs: Math.round((Date.now() - t0) / 1000),
    tools,
    workersAttached: attached,
    pickerShown,
    mergedTool: merged,
    fileOnMain: ok,
    log,
  };
  console.log(JSON.stringify(res, null, 2));
  if (!(ok && merged && attached > 0)) {
    fs.mkdirSync(path.dirname(FINDINGS), { recursive: true });
    fs.appendFileSync(
      FINDINGS,
      JSON.stringify({
        area: "model",
        round: process.env.KORA_QA_ROUND || "r1",
        test: "orchestrator spawn + merge",
        control: "Team·Orchestrator › spawn one worker + merge",
        steps: ["orchestrator thread, full access", "prompt: spawn 1 opencode worker, wait, merge"],
        expected: "worker attached, kora_merge ran, src/hello.js on main",
        actual: JSON.stringify(res).slice(0, 1500),
        severity: "wrong",
        at: new Date().toISOString(),
      }) + "\n",
    );
    process.exitCode = 1;
  }
  c.close();
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
