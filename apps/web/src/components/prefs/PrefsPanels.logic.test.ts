import {
  DEFAULT_DAEMON_PREFS,
  AgentId,
  AgentProfileId,
  type AgentProfileConfig,
} from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildAgentProfileUpdatePatch } from "./PrefsPanels.logic";
describe("buildAgentProfileUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = AgentProfileId.make("codex");
    const nextInstance = {
      driver: AgentId.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/kora/codex",
      },
    } satisfies AgentProfileConfig;

    const patch = buildAgentProfileUpdatePatch({
      settings: {
        ...DEFAULT_DAEMON_PREFS,
        providers: {
          ...DEFAULT_DAEMON_PREFS.providers,
          codex: {
            ...DEFAULT_DAEMON_PREFS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: AgentId.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_DAEMON_PREFS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = AgentProfileId.make("codex_personal");
    const nextInstance = {
      driver: AgentId.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies AgentProfileConfig;

    const patch = buildAgentProfileUpdatePatch({
      settings: DEFAULT_DAEMON_PREFS,
      instanceId,
      instance: nextInstance,
      driver: AgentId.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});
