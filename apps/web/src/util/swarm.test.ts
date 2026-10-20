import { describe, expect, it } from "vite-plus/test";

import type { SwarmStatus, SwarmSupplyState } from "@kora/contracts";

import {
  formatSwarmActivity,
  formatSwarmModel,
  formatUsd,
  parseTaskCap,
  resolveSwarmToggleAvailability,
  SWARM_PROVIDER_META,
  SWARM_WORKER_SOURCES,
  swarmPhaseChrome,
  swarmSupply,
  swarmWorkerSourceStates,
} from "./swarm";
import {
  SWARM_FLEET_WORKER,
  SWARM_STATUS_NEEDS_CONSENT,
  SWARM_STATUS_READY,
} from "./swarm.fixtures";

describe("resolveSwarmToggleAvailability", () => {
  it("is hidden without the host capability", () => {
    expect(
      resolveSwarmToggleAvailability({
        capability: false,
        selectedProvider: "claude",
        status: SWARM_STATUS_READY,
      }).kind,
    ).toBe("hidden");
  });

  it("is disabled only for a leader with no fleet bridge", () => {
    const a = resolveSwarmToggleAvailability({
      capability: true,
      selectedProvider: "antigravity",
      status: SWARM_STATUS_READY,
    });
    expect(a.kind).toBe("disabled");
    for (const selectedProvider of ["codex", "opencode"])
      expect(
        resolveSwarmToggleAvailability({
          capability: true,
          selectedProvider,
          status: SWARM_STATUS_READY,
        }).kind,
      ).toBe("ready");
  });

  it("needs setup when not ready or still loading", () => {
    for (const status of [SWARM_STATUS_NEEDS_CONSENT, null]) {
      expect(
        resolveSwarmToggleAvailability({ capability: true, selectedProvider: "claude", status })
          .kind,
      ).toBe("needs-setup");
    }
  });

  it("is ready for a Claude leader on a ready host", () => {
    expect(
      resolveSwarmToggleAvailability({
        capability: true,
        selectedProvider: "claude",
        status: SWARM_STATUS_READY,
      }).kind,
    ).toBe("ready");
  });
});

describe("swarm copy", () => {
  it("never promises Zen works without a key and labels Cerebras a trial", () => {
    for (const meta of Object.values(SWARM_PROVIDER_META)) {
      expect(meta.unlocksCopy.toLowerCase()).not.toContain("no key needed");
    }
    expect(SWARM_PROVIDER_META.cerebras.label).toMatch(/trial/i);
    expect(SWARM_PROVIDER_META.zen.keyOptional).toBe(true);
  });

  it("maps phases onto tile chrome", () => {
    expect(swarmPhaseChrome("rate-limited")).toEqual({ state: "waiting", label: "rate-limited" });
    expect(swarmPhaseChrome("exhausted").state).toBe("needs-you");
    expect(swarmPhaseChrome("failed").state).toBe("exited");
    expect(swarmPhaseChrome("running")).toEqual({ state: null, label: null });
  });

  it("formats the worker model from the fixture", () => {
    const swarm = SWARM_FLEET_WORKER.swarm!;
    expect(formatSwarmModel(swarm.provider, swarm.modelLabel)).toBe("zen · big-pickle");
  });

  it("activity is measured counts only: no dollars, no 'saved'", () => {
    const lines = formatSwarmActivity({
      delegated: 3,
      reportsReturned: 2,
      respawns: 1,
      passedFirstTry: 1,
      bounced: 1,
      byModel: [
        { provider: "zen", model: "opencode/big-pickle", modelLabel: "big-pickle", workers: 2 },
      ],
      exhausted: false,
    });
    expect(lines).toEqual([
      "3 delegated",
      "2 reports",
      "1 passed first try",
      "1 bounced",
      "1 failover",
      "zen · big-pickle × 2 workers",
    ]);
    const text = lines.join(" ");
    expect(text).not.toContain("$");
    expect(text.toLowerCase()).not.toContain("sav");
  });
});

describe("worker sources", () => {
  const supplyState: SwarmSupplyState = {
    supply: "free-first",
    paid: { enabled: true, maxTaskUsd: 0.05, models: [] },
    local: {
      ollama: { enabled: true, baseUrl: "http://127.0.0.1:11434", models: ["qwen3-coder"] },
      lmstudio: { enabled: false, baseUrl: "http://127.0.0.1:1234", models: [] },
    },
  };
  const withAgents = (
    status: SwarmStatus,
    patch: (p: SwarmStatus["providers"][number]) => SwarmStatus["providers"][number],
  ): SwarmStatus => ({ ...status, providers: status.providers.map(patch) });
  const keyed = (status: SwarmStatus) =>
    withAgents(status, (p) =>
      p.provider === "openrouter" ? { ...p, enabled: true, hasKey: true } : p,
    );

  it("every choice names its privacy trade-off; free says it may log and train", () => {
    expect(SWARM_WORKER_SOURCES.free.privacy).toMatch(/may log .* train/);
    expect(SWARM_WORKER_SOURCES.local.privacy).toMatch(/stay on this machine/);
    expect(SWARM_WORKER_SOURCES.openrouter.privacy).toMatch(/OpenRouter/);
  });

  it("an older daemon without supplyState: local is unavailable, OpenRouter is free-only", () => {
    expect(swarmSupply(SWARM_STATUS_READY)).toBeNull();
    const states = swarmWorkerSourceStates(keyed(SWARM_STATUS_READY));
    expect(states.local).toEqual({ state: "unavailable", detail: "Needs a newer Kora" });
    expect(states.openrouter).toEqual({ state: "on", detail: "On · free models only" });
  });

  it("with supplyState: paid shows the per-task cap, local names the servers", () => {
    const states = swarmWorkerSourceStates(keyed({ ...SWARM_STATUS_READY, supplyState }));
    expect(states.openrouter.detail).toBe("On · paid models up to $0.05 a task");
    expect(states.local).toEqual({ state: "on", detail: "On · Ollama" });
  });

  it("local only turns the cloud sources off", () => {
    const states = swarmWorkerSourceStates(
      keyed({ ...SWARM_STATUS_READY, supplyState: { ...supplyState, supply: "local-only" } }),
    );
    expect(states.free.state).toBe("off");
    expect(states.openrouter.state).toBe("off");
    expect(states.local.state).toBe("on");
  });

  it("free is off when Zen is off, and flags a failed test", () => {
    const off = withAgents(SWARM_STATUS_READY, (p) =>
      p.provider === "zen" ? { ...p, enabled: false } : p,
    );
    expect(swarmWorkerSourceStates(off).free.state).toBe("off");
    const failed = withAgents(SWARM_STATUS_READY, (p) =>
      p.provider === "zen"
        ? {
            ...p,
            enabled: true,
            lastTest: {
              ok: false,
              outcome: "unreachable",
              message: null,
              freeModels: [],
              latencyMs: null,
              testedAt: 1,
              limits: null,
            },
          }
        : p,
    );
    expect(swarmWorkerSourceStates(failed).free.detail).toMatch(/test it again/);
  });

  it("parseTaskCap and formatUsd", () => {
    expect(parseTaskCap("")).toBeNull();
    expect(parseTaskCap(" $0.05 ")).toBe(0.05);
    expect(parseTaskCap(".005")).toBe(0.005);
    expect(parseTaskCap("0")).toBe("invalid");
    expect(parseTaskCap("6")).toBe("invalid");
    expect(parseTaskCap("five")).toBe("invalid");
    expect(parseTaskCap("0.0005")).toBe("invalid");
    expect(formatUsd(0.05)).toBe("$0.05");
    expect(formatUsd(0.005)).toBe("$0.005");
    expect(formatUsd(2)).toBe("$2");
  });
});

describe("resolveSwarmToggleAvailability: git repository", () => {
  it("stays usable in a plain folder, flagged noGit; offered normally when a repo or unknown", () => {
    const plain = resolveSwarmToggleAvailability({
      capability: true,
      selectedProvider: "claude",
      status: SWARM_STATUS_READY,
      isGitRepo: false,
    });
    expect(plain.kind).toBe("ready");
    expect(plain).toMatchObject({ noGit: true });
    expect(plain.tooltip).toMatch(/no git/);
    for (const isGitRepo of [true, null] as const) {
      expect(
        resolveSwarmToggleAvailability({
          capability: true,
          selectedProvider: "claude",
          status: SWARM_STATUS_READY,
          isGitRepo,
        }).kind,
      ).toBe("ready");
    }
  });
});

describe("helperWaitLabel (the lead's live line while helpers work)", () => {
  const w = (state: string) => ({ state }) as unknown as import("@kora/contracts").FleetWorker;
  it("counts busy helpers, puts a blocked one first, and is null when none are busy", async () => {
    const { helperWaitLabel } = await import("./swarm");
    expect(helperWaitLabel([w("working")])).toBe("Waiting for 1 helper");
    expect(helperWaitLabel([w("working"), w("unknown"), w("exited")])).toBe(
      "Waiting for 2 helpers",
    );
    expect(helperWaitLabel([w("working"), w("blocked")])).toBe("1 helper needs you");
    expect(helperWaitLabel([w("idle"), w("exited"), w("asleep")])).toBeNull();
    expect(helperWaitLabel(undefined)).toBeNull();
  });
});
