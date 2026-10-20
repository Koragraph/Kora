// @effect-diagnostics nodeBuiltinImport:off -- plain Node unit test of the spawn helpers.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { killChild } from "./winSpawn.ts";

const fake = (pid: number | undefined, exitCode: number | null = null) => {
  const sent: Array<NodeJS.Signals | undefined> = [];
  return {
    sent,
    child: {
      pid,
      exitCode,
      signalCode: null,
      kill(sig?: NodeJS.Signals) {
        sent.push(sig);
        return true;
      },
    },
  };
};

NodeTest.test("killChild: macOS/Linux send exactly the signal given, never a tree kill", () => {
  const trees: number[] = [];
  const a = fake(42);
  killChild(a.child, "SIGKILL", "darwin", (p) => trees.push(p));
  NodeAssert.deepEqual(a.sent, ["SIGKILL"]);
  NodeAssert.deepEqual(trees, []);
});

NodeTest.test("killChild: Windows ends the live pid's tree and sends no signal", () => {
  const trees: number[] = [];
  const live = fake(42);
  killChild(live.child, "SIGKILL", "win32", (p) => trees.push(p));
  const exited = fake(43, 0);
  killChild(exited.child, "SIGKILL", "win32", (p) => trees.push(p));
  NodeAssert.deepEqual(trees, [42]);
  NodeAssert.deepEqual(live.sent, []);
  NodeAssert.deepEqual(exited.sent, []);
});
