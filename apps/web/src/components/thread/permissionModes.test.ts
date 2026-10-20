import { AgentId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { permissionOptionFor, permissionOptionsFor } from "./permissionModes";

describe("a blob's permission menu shows the true posture", () => {
  it("Auto is highlighted for every mode an Auto blob can run in, on every engine; Ask only for approval-required", () => {
    for (const driver of [
      ...(["claude", "codex", "opencode"] as const).map((d) => AgentId.make(d)),
      undefined,
    ]) {
      for (const mode of ["auto", "auto-accept-edits"] as const) {
        expect(permissionOptionFor(driver, mode, { blob: true }).label).toBe("Auto");
      }
      expect(permissionOptionFor(driver, "approval-required", { blob: true }).label).toBe("Ask");
      expect(permissionOptionFor(driver, "full-access", { blob: true }).label).toBe("Full");
      expect(permissionOptionsFor(driver, { blob: true }).map((o) => o.label)).toEqual([
        "Ask",
        "Auto",
        "Full",
      ]);
    }
  });
});

describe("Antigravity's permission menu offers only levels that never wait", () => {
  const agy = AgentId.make("antigravity");
  it("lists Read only / Accept edits / Full access under agy's own names", () => {
    expect(permissionOptionsFor(agy).map((o) => [o.mode, o.label])).toEqual([
      ["approval-required", "Read only"],
      ["auto-accept-edits", "Accept edits"],
      ["full-access", "Full access"],
    ]);
    expect(permissionOptionsFor(agy).find((o) => o.mode === "full-access")?.danger).toBe(true);
  });
  it("shows a thread on Auto as Full access (the driver runs it with --dangerously-skip-permissions)", () => {
    expect(permissionOptionFor(agy, "auto").label).toBe("Full access");
    expect(permissionOptionFor(agy, "auto-accept-edits").label).toBe("Accept edits");
  });
});
