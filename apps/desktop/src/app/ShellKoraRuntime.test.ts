// @effect-diagnostics nodeBuiltinImport:off -- writes a throwaway log file.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { lastRuntimeReason } from "./ShellKoraRuntime.ts";

describe("lastRuntimeReason", () => {
  it("returns the script's last reason without its timestamp prefix", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-rt-reason-"));
    const log = NodePath.join(dir, "app-launch.log");
    NodeFS.writeFileSync(
      log,
      "[kora-runtime 10:00:00] starting the kora daemon\n[kora-runtime 10:00:01] port 8797 is held by pid 41 (node) — not starting\nnoise\n",
    );
    expect(lastRuntimeReason(log)).toBe("port 8797 is held by pid 41 (node) — not starting");
    NodeFS.rmSync(dir, { recursive: true });
  });

  it("is empty for a missing log", () => {
    expect(lastRuntimeReason("/nonexistent/app-launch.log")).toBe("");
  });
});
