import { assert, describe, it } from "@effect/vitest";

import { daemonPidAlive, serverLogSaysPortTaken } from "./ShellKoraDaemon.ts";

const since = Date.parse("2026-10-04T03:00:00.000Z");
const taken =
  "ui: chat UI server NOT RUNNING — port 8797 on 127.0.0.1 is already in use by another program — quit that program";

describe("serverLogSaysPortTaken", () => {
  it("finds a port clash logged after the app started", () => {
    const log = [
      "2026-10-04T02:59:58.000Z server 0.2.0 listening on /Users/x/.kora/kora.sock (pid 1)",
      `2026-10-04T03:00:02.000Z ${taken}`,
      "2026-10-04T03:00:03.000Z worktree sweep: 0 scanned",
    ].join("\n");
    assert.isTrue(serverLogSaysPortTaken(log, since));
  });

  it("ignores a clash from an earlier run", () => {
    const log = [
      `2026-10-03T20:00:02.000Z ${taken}`,
      "2026-10-04T03:00:01.000Z server 0.2.0 listening on /Users/x/.kora/kora.sock (pid 2)",
    ].join("\n");
    assert.isFalse(serverLogSaysPortTaken(log, since));
  });

  it("is false for an empty or unreadable log", () => {
    assert.isFalse(serverLogSaysPortTaken("", since));
    assert.isFalse(serverLogSaysPortTaken("garbage\nmore garbage", since));
  });
});

describe("daemonPidAlive", () => {
  it("is true for a live pid file, false for a missing, garbage or dead one", async () => {
    const NodeFS = await import("node:fs");
    const NodeOS = await import("node:os");
    const NodePath = await import("node:path");
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-pidfile-"));
    try {
      const file = NodePath.join(dir, "daemon.pid");
      assert.isFalse(daemonPidAlive(file));
      NodeFS.writeFileSync(file, `${process.pid}\n`);
      assert.isTrue(daemonPidAlive(file));
      NodeFS.writeFileSync(file, "not a pid\n");
      assert.isFalse(daemonPidAlive(file));
      NodeFS.writeFileSync(file, "999999\n");
      assert.isFalse(daemonPidAlive(file));
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
