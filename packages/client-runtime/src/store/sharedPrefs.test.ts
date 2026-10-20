import { DEFAULT_DAEMON_PREFS, ProjectId, AgentId, AgentProfileId } from "@kora/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  filterSharedDaemonPatch,
  splitSharedDaemonPatch,
  supportsSharedPrefsSync,
} from "./sharedPrefs.ts";

const restartCapabilities = { threadRestartContinuation: true };

describe("supportsSharedPrefsSync", () => {
  const server = (phase: string, capabilities: Record<string, boolean>) =>
    supportsSharedPrefsSync({
      daemonConfig: { environment: { capabilities } },
      connection: { phase },
    } as Parameters<typeof supportsSharedPrefsSync>[0]);

  it("needs a live connection and the auto-settle capability together", () => {
    expect(server("connected", { threadAutoSettlement: true })).toBe(true);
    expect(server("connected", {})).toBe(false);
    expect(server("reconnecting", { threadAutoSettlement: true })).toBe(false);
  });
});

describe("splitSharedDaemonPatch", () => {
  it("keeps project overrides on this host, since project ids are per host", () => {
    const overrides = { [ProjectId.make("proj")]: { defaultAutoPull: true } };
    const split = splitSharedDaemonPatch({
      sidebarAutoSettleOnMerge: false,
      projectSettingsOverrides: overrides,
    });
    expect(split.localPatch).toEqual({ projectSettingsOverrides: overrides });
    expect(split.sharedPatch).toEqual({ sidebarAutoSettleOnMerge: false });
  });

  it("shares preferences and keeps per-machine keys local", () => {
    const shared = {
      newWorktreesStartFromOrigin: true,
      continueThreadsAfterServerUpdate: true,
      sidebarAutoSettleOnMerge: false,
      sidebarAutoSettleAfterDays: 7,
    };
    const local = { defaultThreadEnvMode: "worktree", enableAgentBrowserAccess: false } as const;
    expect(splitSharedDaemonPatch({ ...local, ...shared })).toEqual({
      localPatch: local,
      sharedPatch: shared,
    });
  });
});

describe("filterSharedDaemonPatch", () => {
  const instance = (driver: string, enabled: boolean) => ({
    config: {},
    enabled,
    driver: AgentId.make(driver),
  });
  const prefs = {
    ...DEFAULT_DAEMON_PREFS,
    textGenerationModelSelection: {
      model: "claude-opus-4-6",
      instanceId: AgentProfileId.make("claude"),
    },
    providerInstances: { claude: instance("claude", true), codex: instance("codex", false) },
  };
  const resetSelection = {
    textGenerationModelSelection: DEFAULT_DAEMON_PREFS.textGenerationModelSelection,
  };

  // Without the restart capability the continue flag is dropped; the disabled-provider reset only
  // goes to the host that made it.
  it.each([true, false])("reset of a disabled default provider, origin=%s", (isOrigin) => {
    const patch = {
      ...resetSelection,
      sidebarAutoSettleAfterDays: 7,
      continueThreadsAfterServerUpdate: true,
    };
    const expected = isOrigin
      ? { ...resetSelection, sidebarAutoSettleAfterDays: 7 }
      : { sidebarAutoSettleAfterDays: 7 };
    expect(filterSharedDaemonPatch(patch, undefined, prefs, prefs, isOrigin)).toEqual(expected);
  });

  it.each([true, false])("passes the restart flag (%s) to a host that supports it", (value) => {
    const patch = { sidebarAutoSettleAfterDays: 7, continueThreadsAfterServerUpdate: value };
    expect(filterSharedDaemonPatch(patch, restartCapabilities)).toEqual(patch);
  });
});
