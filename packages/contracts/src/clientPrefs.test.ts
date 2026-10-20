import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AgentId, AgentProfileId } from "./agentProfile.ts";
import * as Settings from "./clientPrefs.ts";

const client = {
  decode: Schema.decodeUnknownSync(Settings.ClientPrefsSchema),
  encode: Schema.encodeSync(Settings.ClientPrefsSchema),
  patch: Schema.decodeUnknownSync(Settings.ClientPrefsPatch),
};
const daemon = {
  decode: Schema.decodeUnknownSync(Settings.DaemonPrefs),
  encode: Schema.encodeSync(Settings.DaemonPrefs),
  patch: Schema.decodeUnknownSync(Settings.DaemonPrefsPatch),
};
const decodeClaude = Schema.decodeUnknownSync(Settings.ClaudePrefs);
const DEFAULTS = Settings.DEFAULT_DAEMON_PREFS;

type Side = typeof client | typeof daemon;

/**
 * The usual contract of one scalar preference: what an old file without it decodes to,
 * which values survive decode → encode and the patch boundary, and which are refused.
 */
function describeScalarPref(
  side: Side,
  key: string,
  spec: { fallback: unknown; accepts?: readonly unknown[]; refuses?: readonly unknown[] },
) {
  describe(key, () => {
    it(`decodes to ${JSON.stringify(spec.fallback)} when absent`, () => {
      expect((side.decode({}) as Record<string, unknown>)[key]).toEqual(spec.fallback);
    });

    for (const value of spec.accepts ?? []) {
      it(`keeps ${JSON.stringify(value)}`, () => {
        const decoded = side.decode({ [key]: value }) as never;
        expect((side.encode(decoded) as Record<string, unknown>)[key]).toEqual(value);
        expect((side.patch({ [key]: value }) as Record<string, unknown>)[key]).toEqual(value);
      });
    }

    for (const value of spec.refuses ?? []) {
      it(`refuses ${JSON.stringify(value)}`, () => {
        expect(() => side.decode({ [key]: value })).toThrow();
        expect(() => side.patch({ [key]: value })).toThrow();
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Client prefs
// ---------------------------------------------------------------------------

describe("client prefs", () => {
  describeScalarPref(client, "notificationMode", {
    fallback: "off",
    accepts: ["off", "notifications", "sound", "notifications-and-sound"],
    refuses: ["loud", false, null],
  });
  describeScalarPref(client, "inAppNotificationsEnabled", {
    fallback: false,
    accepts: [true, false],
    refuses: ["false", 0, null],
  });
  describeScalarPref(client, "diffFilesCollapsed", { fallback: false, accepts: [true, false] });
  describeScalarPref(client, "diffColorScheme", {
    fallback: "red-green",
    accepts: ["blue-orange", "red-green"],
    refuses: ["cyan-magenta"],
  });
  describeScalarPref(client, "loadBalancingEnabled", { fallback: false, accepts: [false, true] });
  describeScalarPref(client, "browserRecordingFrameRate", {
    fallback: 30,
    accepts: [60, 30],
    refuses: [25, 61, 144],
  });
  describeScalarPref(client, "glassOpacity", {
    fallback: 80,
    accepts: [40, 63, 100],
    refuses: [10, 100.5, 39, 101],
  });
  describeScalarPref(client, "appearanceContrast", {
    fallback: 100,
    accepts: [50, 125, 200],
    refuses: [49, 201, 120.5],
  });
  describeScalarPref(client, "hostIdentificationMode", {
    fallback: "artwork",
    accepts: ["none", "pill", "artwork"],
    refuses: ["icon"],
  });

  it("leaves notification keys out of an empty patch", () => {
    const patch = client.patch({});
    expect("notificationMode" in patch || "inAppNotificationsEnabled" in patch).toBe(false);
  });

  it("keeps load balancing off when only weights were saved", () => {
    expect(client.decode({ loadBalancingWeights: {} }).loadBalancingEnabled).toBe(false);
  });

  describe("panel animation duration", () => {
    it("is instant by default", () => {
      expect(client.decode({}).panelAnimationDurationMs).toBe(0);
    });
    it.each([0, 250, 400])("patches %d ms", (value) => {
      expect(client.patch({ panelAnimationDurationMs: value })).toEqual({
        panelAnimationDurationMs: value,
      });
    });
    it.each([-5, 401, 99.5])("refuses %d ms", (value) => {
      expect(() => client.patch({ panelAnimationDurationMs: value })).toThrow();
    });
  });

  describe("window capture", () => {
    it("is off by default, with all its feedback on", () => {
      const prefs = client.decode({});
      expect([
        prefs.captureEnabled,
        prefs.captureIncludeAccessibility,
        prefs.capturePlaySound,
        prefs.captureSound,
        prefs.captureFlash,
        prefs.captureAnimations,
      ]).toEqual([false, true, true, "soft-pop", true, true]);
    });

    it("patches every capture field", () => {
      const change = {
        captureAnimations: false,
        captureFlash: false,
        captureSound: "camera-shutter",
        capturePlaySound: false,
        captureIncludeAccessibility: false,
        captureEnabled: true,
      };
      expect(client.patch(change)).toEqual(change);
    });

    it("refuses a sound it does not ship", () => {
      expect(() => client.patch({ captureSound: "air-horn" })).toThrow();
    });
  });

  describe("retired and renamed keys", () => {
    it("drops old wrap keys and keeps word wrap on", () => {
      const prefs = client.decode({ chatWordWrap: false, diffWordWrap: false });
      expect(prefs.wordWrap).toBe(true);
      expect(Object.keys(prefs)).not.toEqual(expect.arrayContaining(["chatWordWrap"]));
      expect("diffWordWrap" in prefs).toBe(false);
    });

    it("drops the removed shortcut keys but reads the rest of the file", () => {
      const prefs = client.decode({
        keybindings: [{ key: "mod+p", command: "commandPalette.toggle" }],
        captureShortcut: { kind: "both-shift-keys" },
        confirmQuit: "double-click",
        wordWrap: false,
      });
      expect(prefs.wordWrap).toBe(false);
      for (const gone of ["keybindings", "captureShortcut", "confirmQuit"])
        expect(gone in prefs).toBe(false);
    });

    it("drops the sidebar v2 beta and compact sidebar keys", () => {
      const beta = client.decode({ sidebarV2ConfiguredByUser: true, sidebarV2Enabled: false });
      expect(beta.legacySidebarEnabled).toBe(false);
      expect("sidebarV2Enabled" in beta || "sidebarV2ConfiguredByUser" in beta).toBe(false);

      const compact = { sidebarCompactThreadRows: true, compactSidebarEnabled: true };
      const decoded = client.decode(compact);
      expect("compactSidebarEnabled" in decoded || "sidebarCompactThreadRows" in decoded).toBe(
        false,
      );
      expect(client.patch(compact)).toEqual({});
    });

    it("ignores the old context meter flag and the old blur-collapse trigger", () => {
      expect(
        "contextWindowMeterEnabled" in client.decode({ contextWindowMeterEnabled: false }),
      ).toBe(false);
      const prefs = client.decode({ composerCollapseOnBlur: false });
      expect(prefs.composerCollapseOnScroll).toBe(false);
      expect("composerCollapseOnBlur" in prefs).toBe(false);
    });

    it("renames legacy snapshot keys so their values survive", () => {
      const migrated = Settings.migrateLegacyClientPrefsKeys({
        wordWrap: false,
        snapShotSound: "camera-shutter",
        snapShotEnabled: true,
      });
      expect(migrated).toEqual({
        wordWrap: false,
        captureSound: "camera-shutter",
        captureEnabled: true,
      });
      const prefs = client.decode(migrated);
      expect([prefs.captureEnabled, prefs.captureSound]).toEqual([true, "camera-shutter"]);
    });

    it("lets a current key beat its legacy alias, and passes other input through as-is", () => {
      expect(
        Settings.migrateLegacyClientPrefsKeys({ captureFlash: false, snapShotFlash: true }),
      ).toEqual({
        captureFlash: false,
      });
      const plain = { wordWrap: true };
      expect(Settings.migrateLegacyClientPrefsKeys(plain)).toBe(plain);
      expect(Settings.migrateLegacyClientPrefsKeys(null)).toBeNull();
    });
  });

  describe("opt-in switches", () => {
    it.each([
      ["proactivePanelsEnabled", true],
      ["legacySidebarEnabled", true],
      ["confirmThreadUnpin", true],
      ["composerCollapseOnScroll", true],
    ] as const)("%s is off by default and patchable", (key, value) => {
      expect(client.decode({})[key]).toBe(false);
      expect(client.patch({ [key]: value })[key]).toBe(value);
    });

    it("keeps a saved legacy sidebar choice and refuses a string for unpin confirmation", () => {
      expect(client.decode({ legacySidebarEnabled: true }).legacySidebarEnabled).toBe(true);
      expect(() => client.patch({ confirmThreadUnpin: "no" })).toThrow();
    });
  });

  describe("merge method overrides", () => {
    it("start empty and accept squash, refuse an unknown method", () => {
      expect(client.decode({}).pullRequestMergeMethodOverrides).toEqual({});
      const overrides = { "proj-a": "squash" };
      expect(
        client.patch({ pullRequestMergeMethodOverrides: overrides })
          .pullRequestMergeMethodOverrides,
      ).toEqual(overrides);
      expect(() =>
        client.patch({ pullRequestMergeMethodOverrides: { "proj-a": "octopus" } }),
      ).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Daemon prefs
// ---------------------------------------------------------------------------

describe("daemon prefs", () => {
  describe("default permission mode", () => {
    it("is full access, also for files from before the setting", () => {
      expect([daemon.decode({}).defaultRuntimeMode, DEFAULTS.defaultRuntimeMode]).toEqual([
        "full-access",
        "full-access",
      ]);
    });

    it.each(["approval-required", "auto-accept-edits", "auto", "full-access"])(
      "%s works as the default and as a project override",
      (mode) => {
        const input = {
          projectSettingsOverrides: { p1: { defaultRuntimeMode: mode } },
          defaultRuntimeMode: mode,
        };
        expect(daemon.encode(daemon.decode(input))).toMatchObject(input);
        expect(daemon.patch(input)).toEqual(input);
      },
    );

    it("refuses an unknown mode everywhere", () => {
      expect(() => daemon.decode({ defaultRuntimeMode: "yolo" })).toThrow();
      expect(() => daemon.patch({ defaultRuntimeMode: "yolo" })).toThrow();
      expect(() =>
        daemon.patch({ projectSettingsOverrides: { p1: { defaultRuntimeMode: "yolo" } } }),
      ).toThrow();
    });
  });

  describe("usage price overrides", () => {
    const rates = { outputCostPerMillionTokens: 15, inputCostPerMillionTokens: 3 };

    it("start empty and trim the model id", () => {
      expect(daemon.decode({}).usagePriceOverrides).toEqual({});
      const prefs = daemon.decode({ usagePriceOverrides: { "\tlab/model-z ": rates } });
      expect(daemon.encode(prefs).usagePriceOverrides).toEqual({ "lab/model-z": rates });
    });

    it("allow zero, optional cache rates and null to delete", () => {
      const overrides = {
        "model-z": {
          inputCostPerMillionTokens: 0,
          outputCostPerMillionTokens: 0,
          cacheWriteCostPerMillionTokens: 3.75,
          cacheReadCostPerMillionTokens: 0.3,
        },
        "model-gone": null,
      };
      expect(daemon.patch({ usagePriceOverrides: overrides }).usagePriceOverrides).toEqual(
        overrides,
      );
    });

    const rateFields = ["input", "output", "cacheRead", "cacheWrite"].map(
      (kind) => `${kind}CostPerMillionTokens`,
    );
    for (const field of rateFields) {
      it(`refuse a negative, NaN, infinite or string ${field}`, () => {
        for (const bad of [-0.01, Number.NaN, Number.NEGATIVE_INFINITY, "3"]) {
          const usagePriceOverrides = { "model-z": { ...rates, [field]: bad } };
          expect(() => daemon.decode({ usagePriceOverrides })).toThrow();
          expect(() => daemon.patch({ usagePriceOverrides })).toThrow();
        }
      });
    }

    it("refuse a blank model id or a missing input/output rate", () => {
      const bad = [
        { "  ": rates },
        { "model-z": { outputCostPerMillionTokens: 15 } },
        { "model-z": { inputCostPerMillionTokens: 3 } },
      ];
      for (const usagePriceOverrides of bad)
        expect(() => daemon.patch({ usagePriceOverrides })).toThrow();
    });
  });

  describe("thread settlement", () => {
    it("settles on merge and after three idle days by default", () => {
      const prefs = daemon.decode({});
      expect([prefs.sidebarAutoSettleOnMerge, prefs.sidebarAutoSettleAfterDays]).toEqual([true, 3]);
    });

    it("can turn both rules off", () => {
      const off = { sidebarAutoSettleOnMerge: false, sidebarAutoSettleAfterDays: null };
      expect(daemon.decode(off)).toMatchObject(off);
      expect(daemon.patch(off)).toMatchObject(off);
    });

    it.each([0, -3, 91])("refuses %d days", (days) => {
      expect(() => daemon.decode({ sidebarAutoSettleAfterDays: days })).toThrow();
      expect(() => daemon.patch({ sidebarAutoSettleAfterDays: days })).toThrow();
    });
  });

  describe("provider instances", () => {
    it("default to an empty map while the legacy providers struct keeps its defaults", () => {
      expect(DEFAULTS.providerInstances).toEqual({});
      const prefs = daemon.decode({});
      expect(prefs.providerInstances).toEqual({});
      expect(prefs.providers.codex.enabled).toBe(true);
    });

    it("keep first-party and unknown fork drivers alike", () => {
      const prefs = daemon.decode({
        providerInstances: {
          codex_home: {
            driver: "codex",
            displayName: "Codex at home",
            config: { homePath: "~/.codex-home" },
          },
          codex_job: { driver: "codex", config: { homePath: "~/.codex-job" } },
          // A driver this build has never heard of must round-trip untouched.
          lmstudio_box: {
            driver: "lmstudio",
            displayName: "LM Studio",
            config: { endpoint: "http://127.0.0.1:1234" },
          },
        },
      });
      const at = (id: string) => prefs.providerInstances[AgentProfileId.make(id)];
      expect(at("codex_home")?.driver).toBe("codex");
      expect(at("codex_job")?.config).toEqual({ homePath: "~/.codex-job" });
      expect(at("lmstudio_box")?.driver).toBe("lmstudio");
      expect(at("lmstudio_box")?.config).toEqual({ endpoint: "http://127.0.0.1:1234" });
    });

    it("refuse a key that is not a slug", () => {
      expect(() => daemon.decode({ providerInstances: { "2nd": { driver: "codex" } } })).toThrow();
    });

    it("are an optional whole-map replacement in a patch, fork drivers included", () => {
      expect(daemon.patch({}).providerInstances).toBeUndefined();
      const patch = daemon.patch({
        providerInstances: {
          codex_home: { driver: "codex", config: { homePath: "~/.codex" } },
          lmstudio_box: { driver: "lmstudio", config: { endpoint: "http://127.0.0.1:1234" } },
        },
      });
      expect(patch.providerInstances?.[AgentProfileId.make("codex_home")]?.driver).toBe("codex");
      expect(patch.providerInstances?.[AgentProfileId.make("lmstudio_box")]?.driver).toBe(
        "lmstudio",
      );
    });
  });

  describe("provider enablement", () => {
    it("turns on only the stable providers by default", () => {
      const { providers } = daemon.decode({});
      expect({
        codex: providers.codex.enabled,
        claude: providers.claude.enabled,
        cursor: providers.cursor.enabled,
        grok: providers.grok.enabled,
        opencode: providers.opencode.enabled,
      }).toEqual({ codex: true, claude: true, cursor: false, grok: false, opencode: false });
    });

    it("keeps Cursor on for someone who switched it on", () => {
      const id = AgentProfileId.make("cursor");
      const prefs = daemon.decode({
        providerInstances: { [id]: { driver: AgentId.make("cursor"), enabled: true, config: {} } },
        providers: { cursor: { enabled: true } },
      });
      expect(prefs.providers.cursor.enabled).toBe(true);
      expect(Settings.resolveAgentProfileEnabled(prefs.providerInstances[id]!)).toBe(true);
    });

    it("resolves an instance: driver default, then flags, and any explicit false wins", () => {
      const resolve = Settings.resolveAgentProfileEnabled;
      const grok = AgentId.make("grok");
      const codex = AgentId.make("codex");
      const cases: Array<[Parameters<typeof resolve>[0], boolean]> = [
        [{ driver: grok, config: {} }, false],
        [{ driver: codex, config: {} }, true],
        [{ driver: AgentId.make("lmstudio"), config: {} }, true],
        [{ driver: grok, enabled: true, config: {} }, true],
        [{ driver: codex, enabled: false, config: {} }, false],
        [{ driver: grok, config: { enabled: true } }, true],
        [{ driver: grok, enabled: true, config: { enabled: false } }, false],
        [{ driver: codex, enabled: false, config: { enabled: true } }, false],
      ];
      for (const [instance, expected] of cases)
        expect(resolve(instance), JSON.stringify(instance)).toBe(expected);
    });
  });

  describe("model defaults", () => {
    it("generates text with Luna at low effort", () => {
      expect(DEFAULTS.textGenerationModelSelection).toEqual({
        instanceId: AgentProfileId.make("codex"),
        model: "gpt-5.6-luna",
        options: [{ id: "reasoningEffort", value: "low" }],
      });
    });
  });

  describe("source control", () => {
    it("starts worktrees from origin unless turned off", () => {
      expect(daemon.decode({}).newWorktreesStartFromOrigin).toBe(true);
      expect(daemon.patch({ newWorktreesStartFromOrigin: false }).newWorktreesStartFromOrigin).toBe(
        false,
      );
    });

    it("writes in the repo's conventions by default, with no writer model", () => {
      const prefs = daemon.decode({});
      expect(prefs.sourceControlWritingStyle).toEqual({
        customInstructions: "",
        followChangeRequestTemplates: true,
        mode: "repo_conventions",
      });
      expect(prefs.sourceControlWriterModelSelection).toBeNull();
    });

    it("trims custom instructions in a partial patch", () => {
      const patch = daemon.patch({
        sourceControlWritingStyle: { customInstructions: "\n Keep titles short. ", mode: "custom" },
      });
      expect(patch.sourceControlWritingStyle).toEqual({
        mode: "custom",
        customInstructions: "Keep titles short.",
      });
    });
  });

  describe("string trimming", () => {
    it("trims strings in a patch, but not inside a driver's own config", () => {
      const patch = daemon.patch({
        addProjectBaseDirectory: " ~/Code ",
        textGenerationModelSelection: { model: "\tgpt-5.5-mini " },
        observability: { otlpTracesUrl: " http://127.0.0.1:4318/v1/traces " },
        providers: {
          codex: {
            binaryPath: " /usr/local/bin/codex ",
            homePath: " ~/.codex ",
            launchArgs: " --profile work ",
          },
        },
        providerInstances: {
          codex_home: {
            driver: " codex ",
            displayName: " Home Codex ",
            config: { homePath: " ~/.codex-home " },
          },
        },
      });
      const home = patch.providerInstances?.[AgentProfileId.make("codex_home")];
      expect({
        dir: patch.addProjectBaseDirectory,
        model: patch.textGenerationModelSelection?.model,
        traces: patch.observability?.otlpTracesUrl,
        binary: patch.providers?.codex?.binaryPath,
        home: patch.providers?.codex?.homePath,
        args: patch.providers?.codex?.launchArgs,
        driver: home?.driver,
        name: home?.displayName,
      }).toEqual({
        dir: "~/Code",
        model: "gpt-5.5-mini",
        traces: "http://127.0.0.1:4318/v1/traces",
        binary: "/usr/local/bin/codex",
        home: "~/.codex",
        args: "--profile work",
        driver: "codex",
        name: "Home Codex",
      });
      expect(home?.config).toEqual({ homePath: " ~/.codex-home " });
    });

    it("trims while encoding stored prefs", () => {
      const base = daemon.decode({});
      const wire = daemon.encode({
        ...base,
        addProjectBaseDirectory: " ~/Code ",
        providers: {
          ...base.providers,
          codex: {
            ...base.providers.codex,
            binaryPath: " /usr/local/bin/codex ",
            launchArgs: " --profile work ",
          },
        },
      });
      expect([
        wire.addProjectBaseDirectory,
        wire.providers?.codex?.binaryPath,
        wire.providers?.codex?.launchArgs,
      ]).toEqual(["~/Code", "/usr/local/bin/codex", "--profile work"]);
    });
  });

  describe("host icon", () => {
    it("is null by default and for kinds from a newer build", () => {
      expect(daemon.decode({}).hostIcon).toBeNull();
      expect(daemon.decode({ hostIcon: "smart-fridge" }).hostIcon).toBeNull();
    });

    it.each(["mac-mini", "linux", "laptop"])("round-trips %s", (kind) => {
      const prefs = daemon.decode({ hostIcon: kind });
      expect(prefs.hostIcon).toBe(kind);
      expect(daemon.encode(prefs).hostIcon).toBe(kind);
    });
  });

  describe("Claude switches", () => {
    it("telemetry limiting is off until patched on", () => {
      expect([daemon.decode({}).limitClaudeTelemetry, DEFAULTS.limitClaudeTelemetry]).toEqual([
        false,
        false,
      ]);
      expect(daemon.patch({ limitClaudeTelemetry: true })).toEqual({ limitClaudeTelemetry: true });
      expect(
        daemon.encode(daemon.decode({ limitClaudeTelemetry: true })).limitClaudeTelemetry,
      ).toBe(true);
    });

    it("compaction size defaults to 200k and accepts 400k or full only", () => {
      expect([daemon.decode({}).claudeCompactAt, DEFAULTS.claudeCompactAt]).toEqual([
        "200k",
        "200k",
      ]);
      for (const size of ["400k", "full"])
        expect(daemon.patch({ claudeCompactAt: size })).toEqual({ claudeCompactAt: size });
      expect(() => daemon.patch({ claudeCompactAt: "2m" })).toThrow();
    });

    it("bounded reads and lean context keep their defaults and refuse junk", () => {
      const prefs = daemon.decode({});
      expect(prefs.boundedReads).toBe(DEFAULTS.boundedReads);
      expect(prefs.leanContext).toBe(false);
      expect(daemon.patch({ leanContext: true, boundedReads: "shadow" })).toEqual({
        boundedReads: "shadow",
        leanContext: true,
      });
      expect(() => daemon.patch({ boundedReads: "sometimes" })).toThrow();
      expect(() => daemon.patch({ leanContext: 1 })).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Claude provider prefs
// ---------------------------------------------------------------------------

describe("Claude provider prefs", () => {
  describe("auto-compaction window", () => {
    it("is empty (Claude's own default) when unset", () => {
      expect(decodeClaude({}).autoCompactWindow).toBe("");
    });
    it.each(["100000", "450000", "1000000"])("accepts %s", (value) => {
      expect(decodeClaude({ autoCompactWindow: value }).autoCompactWindow).toBe(value);
    });
    it.each(["50000", "1000001", "200k", "lots"])("refuses %s", (value) => {
      expect(() => decodeClaude({ autoCompactWindow: value })).toThrow();
    });
    it("is validated at the patch boundary too", () => {
      expect(() =>
        daemon.patch({ providers: { claude: { autoCompactWindow: "200k" } } }),
      ).toThrow();
      expect(
        daemon.patch({ providers: { claude: { autoCompactWindow: "450000" } } }),
      ).toBeDefined();
    });
  });

  describe("custom models", () => {
    const maxEffort = { id: "max", label: "Max", isDefault: true };
    const capabilities = {
      optionDescriptors: [
        { type: "select", label: "Reasoning", id: "effort", options: [maxEffort] },
      ],
    };

    it("mixes bare slugs with full entries", () => {
      const customModels = ["just-a-slug", { slug: "rich", name: "Rich", capabilities }];
      expect(decodeClaude({ customModels }).customModels).toEqual(customModels);
    });

    it("are accepted in a patch but must have a slug", () => {
      const entry = { slug: "m1", capabilities };
      expect(
        daemon.patch({ providers: { codex: { customModels: [entry] } } }).providers?.codex
          ?.customModels,
      ).toEqual([entry]);
      expect(() =>
        daemon.patch({ providers: { codex: { customModels: [{ name: "nameless" }] } } }),
      ).toThrow();
    });
  });
});
