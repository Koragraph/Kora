import { permissionOptionFor, permissionOptionsFor } from "../../thread/permissionModes";

import type { AgentId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

const agent = (id: string) => id as AgentId;
import { POSTURES, postureAccessMode, postureCopy, postureOfAccessMode } from "./postureCopy";

describe("a blob's postures read Ask / Auto / Full everywhere", () => {
  it("copy and mapping round-trip", () => {
    expect(POSTURES.map((p) => p.label)).toEqual(["Ask", "Auto", "Full"]);
    expect(postureCopy("ask").body).toMatch(/every command/);
    expect(postureAccessMode("auto", "claude")).toBe("auto");
    expect(postureAccessMode("auto", "codex")).toBe("auto-accept-edits");
    expect(postureOfAccessMode("approval-required")).toBe("ask");
    expect(postureOfAccessMode("full-access")).toBe("full");
    expect(postureOfAccessMode("auto-accept-edits")).toBe("auto");
  });
  it("the selected posture is read back whatever mode the thread is in", () => {
    expect(permissionOptionFor(agent("claude"), "auto", { blob: true }).label).toBe("Auto");
    expect(permissionOptionFor(agent("claude"), "auto-accept-edits", { blob: true }).label).toBe(
      "Auto",
    );
    expect(permissionOptionFor(agent("codex"), "auto", { blob: true }).label).toBe("Auto");
    expect(permissionOptionFor(agent("codex"), "approval-required", { blob: true }).label).toBe(
      "Ask",
    );
    expect(permissionOptionFor(agent("claude"), "full-access", { blob: true }).label).toBe("Full");
  });
  it("the composer's permission menu on a blob lists Ask / Auto / Full for every engine (never Default / Accept edits / bypass)", () => {
    for (const engine of ["claude", "codex", "opencode"] as const) {
      const options = permissionOptionsFor(agent(engine), { blob: true });
      expect(options.map((o) => o.label)).toEqual(["Ask", "Auto", "Full"]);
      expect(options.map((o) => o.description).join(" ")).not.toMatch(
        /bypass|Claude Code|sandbox|danger-full-access/i,
      );
      expect(options.find((o) => o.label === "Full")?.danger).toBe(true);
    }
    expect(permissionOptionsFor(agent("claude"), { blob: true }).map((o) => o.mode)).toEqual([
      "approval-required",
      "auto",
      "full-access",
    ]);
    expect(permissionOptionsFor(agent("codex"), { blob: true }).map((o) => o.mode)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "full-access",
    ]);
    // the Code surface keeps its own names
    expect(permissionOptionsFor(agent("claude")).map((o) => o.label)).toEqual([
      "Default",
      "Accept edits",
      "Auto",
      "Full access",
    ]);
  });
});
