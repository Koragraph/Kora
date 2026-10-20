import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { workerScreenTail } from "./fleet-service.ts";

NodeTest.test("workerScreenTail: the error a worker stopped on, and the end of its screen", () => {
  const codex =
    "╭──────╮\n│ model: gpt-6-luna │\n╰──────╯\n\n› Research task\n■ You’ve hit your usage limit. Upgrade to Plus.\n\n› Ask Codex to do anything\n";
  const r = workerScreenTail(codex);
  NodeAssert.equal(r.problem, "■ You’ve hit your usage limit. Upgrade to Plus.");
  NodeAssert.match(r.tail, /Ask Codex to do anything$/);
  NodeAssert.equal(workerScreenTail("⏺ pong\n❯ \n").problem, null);
  NodeAssert.match(workerScreenTail("API Error: 401 — Please run /login").problem ?? "", /login/);
});
