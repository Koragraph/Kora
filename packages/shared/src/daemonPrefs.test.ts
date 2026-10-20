import * as Contracts from "@kora/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";

import { resolveDaemonBackgroundActivityPrefs } from "./backgroundActivityPrefs.ts";
import { applyDaemonPrefsPatch, parsePersistedDaemonTracingPrefs } from "./daemonPrefs.ts";
import { createModelPick } from "./modelOptions.ts";
import { resolveProjectCommands } from "./projectCommands.ts";

const { DEFAULT_DAEMON_PREFS: DEFAULTS, AgentProfileId, ProjectId } = Contracts;

type Prefs = typeof DEFAULTS;
type Patch = Parameters<typeof applyDaemonPrefsPatch>[1];

/** Apply patches left to right. */
const applyAll = (start: Prefs, ...patches: Patch[]): Prefs =>
  patches.reduce<Prefs>((prefs, patch) => applyDaemonPrefsPatch(prefs, patch), start);

// The server folds legacy per-project fields into the override maps before patches arrive.
const folded: Prefs = { ...DEFAULTS, projectSettingsFolded: true };

const CODEX = AgentProfileId.make("codex");
const OPENCODE = AgentProfileId.make("opencode");
const ms = Duration.toMillis;

describe("applying daemon pref patches", () => {
  describe("per-project script overrides", () => {
    const shared = {
      id: "verify",
      name: "Verify",
      command: "pnpm verify",
      icon: "play" as const,
      runOnWorktreeCreate: false,
    };
    const one = { id: ProjectId.make("proj-one"), scripts: [] };
    const two = { id: ProjectId.make("proj-two"), scripts: [] };
    const oneScript = { ...shared, command: "pnpm fmt" };
    const twoScript = { ...shared, command: "pnpm bundle" };

    const both = applyAll(
      folded,
      { defaultProjectScripts: [shared], projectScriptOverrides: { [one.id]: [oneScript] } },
      { projectScriptOverrides: { [two.id]: [twoScript] } },
    );

    it("adds an override for one project without dropping another's", () => {
      expect(resolveProjectCommands(both, one)).toEqual([oneScript]);
      expect(resolveProjectCommands(both, two)).toEqual([twoScript]);
    });

    it("an empty list clears one project only", () => {
      const cleared = applyAll(both, { projectScriptOverrides: { [one.id]: [] } });
      expect(resolveProjectCommands(cleared, one)).toEqual([]);
      expect(resolveProjectCommands(cleared, two)).toEqual([twoScript]);
    });

    it("null resets one project to the defaults", () => {
      const reset = applyAll(
        both,
        { projectScriptOverrides: { [one.id]: [] } },
        { projectScriptOverrides: { [one.id]: null } },
      );
      expect(resolveProjectCommands(reset, { ...one, scripts: [oneScript] })).toEqual([shared]);
      expect(resolveProjectCommands(reset, two)).toEqual([twoScript]);
      // Earlier snapshots are not mutated.
      expect(resolveProjectCommands(both, one)).toEqual([oneScript]);
    });
  });

  describe("model picks", () => {
    const highEffort = { id: "reasoningEffort", value: "high" };
    const miniWith = (...options: Array<{ id: string; value: unknown }>) =>
      createModelPick(CODEX, "gpt-5.5-mini", options as never);
    const withTextGen = {
      ...DEFAULTS,
      textGenerationModelSelection: miniWith(highEffort, { id: "fastMode", value: true }),
    };

    it("swaps the default chat model wholesale and clears it with null", () => {
      const sonnet = createModelPick(AgentProfileId.make("claude"), "sonnet");
      const swapped = applyAll(
        DEFAULTS,
        { defaultModelSelection: createModelPick(CODEX, "gpt-5.5", [highEffort] as never) },
        { defaultModelSelection: sonnet },
      );
      expect(swapped.defaultModelSelection).toEqual(sonnet);
      expect(applyAll(swapped, { defaultModelSelection: null }).defaultModelSelection).toBeNull();
    });

    it("text generation: a new instance and model replaces the old options", () => {
      const same = applyAll(withTextGen, {
        textGenerationModelSelection: { instanceId: CODEX, model: "gpt-5.5-mini" },
      });
      expect(same.textGenerationModelSelection).toEqual({
        instanceId: "codex",
        model: "gpt-5.5-mini",
      });

      const moved = applyAll(withTextGen, {
        textGenerationModelSelection: { instanceId: OPENCODE, model: "openai/gpt-5" },
      });
      expect(moved.textGenerationModelSelection).toEqual({
        instanceId: "opencode",
        model: "openai/gpt-5",
      });
    });

    it("text generation: an options-only patch merges into the current pick", () => {
      const next = applyAll(withTextGen, {
        textGenerationModelSelection: { options: [{ id: "fastMode", value: false }] },
      });
      expect(next.textGenerationModelSelection).toEqual({
        instanceId: "codex",
        model: "gpt-5.5-mini",
        options: [highEffort, { id: "fastMode", value: false }],
      });
    });

    it("text generation: accepts a full pick with an options array", () => {
      const options = [
        { id: "agent", value: "plan" },
        { id: "variant", value: "fast" },
      ];
      const next = applyAll(DEFAULTS, {
        textGenerationModelSelection: { instanceId: OPENCODE, model: "openai/gpt-5", options },
      });
      expect(next.textGenerationModelSelection).toEqual({
        instanceId: "opencode",
        model: "openai/gpt-5",
        options,
      });
    });

    it("source-control writer: replaced without old options, cleared by null", () => {
      const start = { ...DEFAULTS, sourceControlWriterModelSelection: miniWith(highEffort) };
      expect(
        applyAll(start, {
          sourceControlWriterModelSelection: { instanceId: OPENCODE, model: "openai/gpt-5" },
        }).sourceControlWriterModelSelection,
      ).toEqual({ instanceId: "opencode", model: "openai/gpt-5" });
      expect(
        applyAll(
          { ...DEFAULTS, sourceControlWriterModelSelection: miniWith() },
          {
            sourceControlWriterModelSelection: null,
          },
        ).sourceControlWriterModelSelection,
      ).toBeNull();
    });
  });

  describe("keyed maps", () => {
    it("providerInstances: a patched entry replaces the stored one entirely", () => {
      const driver = Contracts.AgentId.make("codex");
      const base = {
        driver,
        displayName: "Codex Home",
        enabled: true,
        config: { homePath: "~/.codex-home" },
      };
      const start = {
        ...DEFAULTS,
        providerInstances: { [CODEX]: { ...base, accentColor: "#123456" } },
      };
      expect(
        applyAll(start, { providerInstances: { [CODEX]: base } }).providerInstances[CODEX],
      ).toEqual(base);
    });

    it("usageLimitSources: entries are added and removed one at a time", () => {
      const [left, right] = ["proxy-left", "proxy-right"].map((raw) =>
        Contracts.QuotaSourceId.make(raw),
      ) as [Contracts.QuotaSourceId, Contracts.QuotaSourceId];
      const source = (url: string) => ({
        kind: "cliproxy" as const,
        url,
        managementKey: "k",
        enabled: true,
      });
      const start = { ...DEFAULTS, usageLimitSources: { [left]: source("http://left:9000") } };

      const grown = applyAll(start, {
        usageLimitSources: { [right]: source("http://right:9000") },
      });
      expect(Object.keys(grown.usageLimitSources)).toEqual([left, right]);
      const shrunk = applyAll(grown, { usageLimitSources: { [left]: null } });
      expect(Object.keys(shrunk.usageLimitSources)).toEqual([right]);
    });

    it("usagePriceOverrides: one model is replaced or removed, others stay", () => {
      const price = { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 15 };
      const withCache = applyAll(DEFAULTS, {
        usagePriceOverrides: { "model-x": { ...price, cacheReadCostPerMillionTokens: 0.3 } },
      });
      const replaced = applyAll(
        withCache,
        { usagePriceOverrides: { "model-y": price } },
        { usagePriceOverrides: { "model-x": price } },
      );
      expect(replaced.usagePriceOverrides).toEqual({ "model-x": price, "model-y": price });
      expect(
        applyAll(replaced, { usagePriceOverrides: { "model-x": null } }).usagePriceOverrides,
      ).toEqual({
        "model-y": price,
      });
      expect(withCache.usagePriceOverrides["model-x"]?.cacheReadCostPerMillionTokens).toBe(0.3);
    });
  });

  describe("background activity", () => {
    type Overrides = NonNullable<NonNullable<Patch["backgroundActivity"]>["overrides"]>;
    type Base = "balanced" | "performance" | "battery-saver";

    const preset = (profile: Base) => ({ schemaVersion: 1 as const, profile, overrides: {} });
    const customOn = (baseProfile: Base, overrides: Overrides) => ({
      schemaVersion: 1 as const,
      profile: "custom" as const,
      baseProfile,
      overrides,
    });
    const fetchEvery = (seconds: number) => ({
      automaticGitFetchInterval: Duration.seconds(seconds),
    });

    it("a preset is stored versioned and mirrored onto the legacy fields", () => {
      const next = applyAll(DEFAULTS, { backgroundActivity: preset("battery-saver") });
      expect(next.backgroundActivity).toEqual(preset("battery-saver"));
      expect(next.backgroundActivityProfile).toBe("battery-saver");
      expect(ms(next.automaticGitFetchInterval)).toBe(0);
      expect(ms(next.providerHealthRefreshInterval)).toBe(15 * 60_000);
    });

    it("a legacy interval patch becomes a custom profile on the current base", () => {
      const next = applyAll(DEFAULTS, fetchEvery(15));
      expect(next.backgroundActivity).toEqual(customOn("balanced", fetchEvery(15)));
      const resolved = resolveDaemonBackgroundActivityPrefs(next);
      expect(resolved.profile).toBe("balanced");
      expect(ms(resolved.automaticGitFetchInterval)).toBe(15_000);
    });

    it("an unrelated patch preserves hand-set legacy intervals", () => {
      const start = {
        ...DEFAULTS,
        backgroundActivityProfile: "performance" as const,
        automaticGitFetchInterval: Duration.seconds(9),
        providerHealthRefreshInterval: Duration.minutes(2),
      };
      const next = applyAll(start, {
        sourceControlWriterModelSelection: createModelPick(CODEX, "gpt-5.5-mini"),
      });
      expect(next.backgroundActivity).toEqual(
        customOn("performance", {
          ...fetchEvery(9),
          providerHealthRefreshInterval: Duration.minutes(2),
        }),
      );
      expect(next.backgroundActivityProfile).toBe("performance");
      expect(ms(next.automaticGitFetchInterval)).toBe(9_000);
      expect(ms(next.providerHealthRefreshInterval)).toBe(120_000);
    });

    it("overrides parked under a preset are not revived by a new override", () => {
      const start = {
        ...DEFAULTS,
        backgroundActivity: {
          ...preset("battery-saver"),
          overrides: { providerHealthRefreshInterval: Duration.seconds(5) },
        },
      };
      expect(applyAll(start, fetchEvery(15)).backgroundActivity).toEqual(
        customOn("battery-saver", fetchEvery(15)),
      );
    });

    it("the structured field beats legacy fields in the same patch", () => {
      const next = applyAll(DEFAULTS, {
        ...fetchEvery(5),
        backgroundActivityProfile: "performance",
        backgroundActivity: preset("battery-saver"),
      });
      expect(next.backgroundActivity).toEqual(preset("battery-saver"));
      expect(next.backgroundActivityProfile).toBe("battery-saver");
      expect(ms(next.automaticGitFetchInterval)).toBe(0);
    });

    it("custom collapses back to the preset when the overrides match it", () => {
      const next = applyAll(DEFAULTS, fetchEvery(15), fetchEvery(30));
      expect(next.backgroundActivity).toEqual(preset("balanced"));
      expect(next.backgroundActivityProfile).toBe("balanced");
      expect(ms(next.automaticGitFetchInterval)).toBe(30_000);
    });

    it("overrides equal to the base profile are dropped on write", () => {
      expect(
        applyAll(DEFAULTS, { backgroundActivity: customOn("balanced", fetchEvery(30)) })
          .backgroundActivity,
      ).toEqual(preset("balanced"));
    });

    it("a new overrides record replaces the old one instead of merging", () => {
      const next = applyAll(
        DEFAULTS,
        {
          backgroundActivity: customOn("balanced", {
            ...fetchEvery(15),
            providerHealthRefreshInterval: Duration.minutes(3),
          }),
        },
        { backgroundActivity: { overrides: fetchEvery(10) } },
      );
      expect(next.backgroundActivity).toEqual(customOn("balanced", fetchEvery(10)));
    });

    it("intervals sent with a profile switch become overrides of that profile", () => {
      const next = applyAll(DEFAULTS, {
        ...fetchEvery(0),
        backgroundActivityProfile: "performance",
        providerHealthRefreshInterval: Duration.minutes(4),
      });
      expect(next.backgroundActivity).toEqual(
        customOn("performance", {
          ...fetchEvery(0),
          providerHealthRefreshInterval: Duration.minutes(4),
        }),
      );
    });

    it("resolution ignores overrides stored beside a preset", () => {
      const resolved = resolveDaemonBackgroundActivityPrefs({
        ...DEFAULTS,
        backgroundActivity: { ...preset("balanced"), overrides: { pauseWhenOnBattery: true } },
      });
      expect(resolved.pauseWhenOnBattery).toBe(false);
    });
  });

  describe("Claude switches", () => {
    it("limitClaudeTelemetry toggles without touching other fields", () => {
      const on = applyAll(folded, { limitClaudeTelemetry: true });
      expect(on.limitClaudeTelemetry).toBe(true);
      expect(on.defaultRuntimeMode).toBe(folded.defaultRuntimeMode);
      expect(applyAll(on, { limitClaudeTelemetry: false }).limitClaudeTelemetry).toBe(false);
    });

    it("claudeCompactAt is set without touching other fields", () => {
      const next = applyAll(folded, { claudeCompactAt: "full" });
      expect(next.claudeCompactAt).toBe("full");
      expect(next.defaultRuntimeMode).toBe(folded.defaultRuntimeMode);
    });
  });
});

describe("reading persisted tracing prefs", () => {
  const unset = { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  const read = (value: unknown) =>
    parsePersistedDaemonTracingPrefs(typeof value === "string" ? value : JSON.stringify(value));

  it.each([
    ["no observability block", "{}"],
    ["blank URLs", { observability: { otlpTracesUrl: " \t", otlpMetricsUrl: "" } }],
    ["broken JSON", '{"observability":'],
  ])("leaves both URLs unset for %s", (_label, raw) => {
    expect(read(raw)).toEqual(unset);
  });

  it("trims the configured URLs", () => {
    expect(
      read({
        observability: {
          otlpMetricsUrl: "\thttp://127.0.0.1:4318/v1/metrics ",
          otlpTracesUrl: " http://127.0.0.1:4318/v1/traces\n",
        },
      }),
    ).toEqual({
      otlpTracesUrl: "http://127.0.0.1:4318/v1/traces",
      otlpMetricsUrl: "http://127.0.0.1:4318/v1/metrics",
    });
  });
});
