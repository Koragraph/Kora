import type { SwarmStatus } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { SWARM_STATUS_OPENCODE_MISSING, SWARM_STATUS_READY } from "../../util/swarm.fixtures";
import { quickSetupRows } from "./SwarmQuickSetup";
import { yourComputer } from "../../util/utils";

const zenOnly = (status: SwarmStatus, lastTest: unknown): SwarmStatus => ({
  ...status,
  providers: status.providers.map((p) =>
    p.provider === "zen"
      ? ({ ...p, lastTest } as SwarmStatus["providers"][number])
      : { ...p, enabled: false },
  ),
});

describe("quickSetupRows (one-sheet Swarm setup)", () => {
  it("a fresh Mac: OpenCode to download (size, from GitHub, nothing else changes), models to check", () => {
    const status = zenOnly(
      {
        ...SWARM_STATUS_OPENCODE_MISSING,
        install: { ...SWARM_STATUS_OPENCODE_MISSING.install, version: "1.18.32" },
      },
      null,
    );
    const [opencode, models] = quickSetupRows(status, false);
    expect(opencode).toMatchObject({ id: "opencode", state: "todo" });
    expect(opencode!.detail).toContain("about 46 MB");
    expect(opencode!.detail).toContain(`Nothing else on ${yourComputer()} changes`);
    expect(models).toMatchObject({ id: "models", state: "todo" });
  });

  it("shows download progress with a Cancel handle", () => {
    const status: SwarmStatus = {
      ...SWARM_STATUS_OPENCODE_MISSING,
      install: {
        operationId: "op-1",
        phase: "downloading",
        downloadedBytes: 12_300_000,
        totalBytes: 46_300_000,
        version: "1.18.32",
        installedVersion: null,
        message: null,
      },
    };
    const [opencode] = quickSetupRows(status, false);
    expect(opencode).toMatchObject({
      state: "busy",
      detail: "Downloading… 12.3 of 46.3 MB",
      cancelId: "op-1",
      progress: { done: 12_300_000, total: 46_300_000 },
    });
  });

  it("explains an offline download plainly instead of the raw network error", () => {
    const status: SwarmStatus = {
      ...SWARM_STATUS_OPENCODE_MISSING,
      install: {
        ...SWARM_STATUS_OPENCODE_MISSING.install,
        phase: "failed",
        message: "network error: ENOTFOUND",
      },
    };
    const [opencode] = quickSetupRows(status, false);
    expect(opencode).toMatchObject({ state: "failed" });
    expect(opencode!.detail).toContain("couldn't reach GitHub");
  });

  it("ticks both rows on a ready Mac and never asks the user to pick a model", () => {
    const [opencode, models] = quickSetupRows(SWARM_STATUS_READY, false);
    expect(opencode).toMatchObject({ state: "done" });
    expect(models).toMatchObject({ state: "done" });
    expect(models!.detail).toContain("you never have to choose");
  });

  it("a failed free-model check says what to do; another working provider takes over quietly", () => {
    const failedTest = {
      ok: false,
      outcome: "unreachable",
      message: "fetch failed",
      freeModels: [],
      latencyMs: null,
      testedAt: 1,
      limits: null,
    };
    const [, alone] = quickSetupRows(zenOnly(SWARM_STATUS_READY, failedTest), false);
    expect(alone).toMatchObject({ state: "failed" });
    expect(alone!.detail).toContain("Check your internet connection");
    const withOpenRouter: SwarmStatus = {
      ...SWARM_STATUS_READY,
      providers: SWARM_STATUS_READY.providers.map((p) =>
        p.provider === "zen" ? ({ ...p, lastTest: failedTest } as typeof p) : p,
      ),
    };
    const [, covered] = quickSetupRows(withOpenRouter, false);
    expect(covered).toMatchObject({ state: "done" });
    expect(quickSetupRows(SWARM_STATUS_READY, true)[1]).toMatchObject({ state: "busy" });
  });
});
