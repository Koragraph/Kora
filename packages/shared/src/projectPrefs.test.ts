import * as Contracts from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyDaemonPrefsPatch } from "./daemonPrefs.ts";
import { createModelPick } from "./modelOptions.ts";
import { resolveProjectPrefs } from "./projectPrefs.ts";

const BASE = Contracts.DEFAULT_DAEMON_PREFS;
const MINE = Contracts.ProjectId.make("proj-mine");
const THEIRS = Contracts.ProjectId.make("proj-theirs");

type Patch = Parameters<typeof applyDaemonPrefsPatch>[1];
const withPatch = (patch: Patch, from = BASE) => applyDaemonPrefsPatch(from, patch);

const pick = (profile: string, model: string) =>
  createModelPick(Contracts.AgentProfileId.make(profile), model);

describe("resolving prefs for one project", () => {
  it("returns the environment prefs unchanged when nothing is overridden", () => {
    const { settings, sources } = resolveProjectPrefs(BASE, MINE);
    expect(settings).toBe(BASE);
    expect(
      new Set(Contracts.PROJECT_SCOPED_DAEMON_SETTING_KEYS.map((key) => sources[key])),
    ).toEqual(new Set(["environment"]));
  });

  it("accepts a missing project id or a null project snapshot", () => {
    // A new-task flow can resolve before its project is known.
    expect(resolveProjectPrefs(BASE, null).settings).toBe(BASE);
    expect(resolveProjectPrefs(BASE, null, null).settings).toBe(BASE);
  });

  it("overrides only the keys a project sets, null included", () => {
    const prefs = withPatch({
      sidebarAutoSettleAfterDays: 5,
      defaultAutoPull: true,
      projectSettingsOverrides: {
        [MINE]: { sidebarAutoSettleAfterDays: null, defaultAutoPull: false },
      },
    });
    const mine = resolveProjectPrefs(prefs, MINE);

    expect([mine.settings.defaultAutoPull, mine.settings.sidebarAutoSettleAfterDays]).toEqual([
      false,
      null,
    ]);
    expect([mine.sources.defaultAutoPull, mine.sources.sidebarAutoSettleAfterDays]).toEqual([
      "project",
      "project",
    ]);
    expect(mine.settings.defaultThreadEnvMode).toBe(prefs.defaultThreadEnvMode);
    expect(mine.sources.defaultThreadEnvMode).toBe("environment");
    expect(resolveProjectPrefs(prefs, THEIRS).settings.defaultAutoPull).toBe(true);
  });

  describe("overrides naming a disabled provider fall back to the environment", () => {
    const disabledClaude = { providers: { claude: { enabled: false } } } satisfies Patch;

    it("for the default model", () => {
      const prefs = withPatch({
        ...disabledClaude,
        projectSettingsOverrides: { [MINE]: { defaultModelSelection: pick("claude", "haiku") } },
      });
      const mine = resolveProjectPrefs(prefs, MINE);
      expect(mine.settings.defaultModelSelection).toBeNull();
      expect(mine.sources.defaultModelSelection).toBe("environment");
    });

    it("for the text generation model", () => {
      const prefs = withPatch({
        ...disabledClaude,
        projectSettingsOverrides: {
          [MINE]: { textGenerationModelSelection: pick("claude", "haiku") },
        },
      });
      const mine = resolveProjectPrefs(prefs, MINE);
      expect(mine.settings.textGenerationModelSelection).toEqual(
        prefs.textGenerationModelSelection,
      );
      expect(mine.sources.textGenerationModelSelection).toBe("environment");
    });
  });

  describe("legacy fields on the project aggregate", () => {
    const legacyModel = pick("codex", "gpt-5.5-mini");
    const aggregate = {
      defaultThreadEnvMode: "local" as const,
      defaultModelSelection: legacyModel,
    };
    const unfoldedPrefs = { ...BASE, projectSettingsFolded: false };

    it("are honoured before the server folds them", () => {
      const before = resolveProjectPrefs(unfoldedPrefs, MINE, aggregate);
      expect(before.settings.defaultModelSelection).toEqual(legacyModel);
      expect(before.sources.defaultModelSelection).toBe("project");
      expect(before.settings.defaultThreadEnvMode).toBe("local");
    });

    it("lose to a stored override even before the fold", () => {
      const prefs = {
        ...unfoldedPrefs,
        projectSettingsOverrides: { [MINE]: { defaultThreadEnvMode: "worktree" as const } },
      };
      expect(resolveProjectPrefs(prefs, MINE, aggregate).settings.defaultThreadEnvMode).toBe(
        "worktree",
      );
    });

    it("are ignored once folded, so a reset in the record sticks", () => {
      const after = resolveProjectPrefs({ ...BASE, projectSettingsFolded: true }, MINE, aggregate);
      expect(after.settings.defaultModelSelection).toBeNull();
      expect(after.sources.defaultModelSelection).toBe("environment");
    });
  });
});

describe("patching project overrides", () => {
  it("mirrors the generic record onto the per-key legacy maps", () => {
    const prefs = withPatch({
      projectSettingsOverrides: {
        [THEIRS]: { defaultProjectScripts: [] },
        [MINE]: { enableAgentBrowserAccess: false, defaultAutoPull: true },
      },
    });
    expect({
      pull: prefs.projectAutoPullOverrides,
      browser: prefs.projectAgentBrowserAccessOverrides,
      scripts: prefs.projectScriptOverrides,
    }).toEqual({
      pull: { [MINE]: true },
      browser: { [MINE]: false },
      scripts: { [THEIRS]: [] },
    });
  });

  it("folds legacy per-key patches into the record, and null removes a key", () => {
    const written = withPatch({
      projectAgentBrowserAccessOverrides: { [THEIRS]: true, [MINE]: false },
      projectAutoPullOverrides: { [MINE]: true },
    });
    expect(written.projectSettingsOverrides).toEqual({
      [MINE]: { enableAgentBrowserAccess: false, defaultAutoPull: true },
      [THEIRS]: { enableAgentBrowserAccess: true },
    });

    const removed = withPatch(
      { projectAgentBrowserAccessOverrides: { [THEIRS]: null, [MINE]: null } },
      written,
    );
    expect(removed.projectSettingsOverrides).toEqual({ [MINE]: { defaultAutoPull: true } });
  });

  it("prefers the record entry when the same patch also carries a stale legacy map", () => {
    const start = withPatch({ projectSettingsOverrides: { [MINE]: { defaultAutoPull: true } } });
    // Leaving defaultAutoPull out of the record clears it; the legacy map must not revive it.
    const next = withPatch(
      {
        projectAutoPullOverrides: { [THEIRS]: false, [MINE]: true },
        projectSettingsOverrides: { [MINE]: { defaultThreadEnvMode: "local" } },
      },
      start,
    );
    expect(next.projectSettingsOverrides).toEqual({
      [THEIRS]: { defaultAutoPull: false },
      [MINE]: { defaultThreadEnvMode: "local" },
    });
  });
});
