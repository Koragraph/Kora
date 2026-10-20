import { DEFAULT_UNIFIED_PREFS } from "@kora/contracts/clientPrefs";
import type {
  AgentProfileConfig,
  AgentProfileId,
  UnifiedPrefs,
  DaemonPrefs,
  AgentId,
} from "@kora/contracts";

export type BrowserDefaultPrefs = Pick<
  UnifiedPrefs,
  | "browserRecordingFrameRate"
  | "browserDefaultZoomFactor"
  | "browserDefaultAppearance"
  | "browserDefaultViewport"
  | "browserLinkTarget"
>;

export function buildAgentProfileUpdatePatch(input: {
  readonly settings: Pick<DaemonPrefs, "providers" | "providerInstances">;
  readonly instanceId: AgentProfileId;
  readonly instance: AgentProfileConfig;
  readonly driver: AgentId;
  readonly isDefault: boolean;
  readonly textGenerationModelSelection?: DaemonPrefs["textGenerationModelSelection"] | undefined;
}): Partial<UnifiedPrefs> {
  type LegacyAgentPrefs = DaemonPrefs["providers"][keyof DaemonPrefs["providers"]];
  const legacyAgentDefaults = DEFAULT_UNIFIED_PREFS.providers as Record<
    string,
    LegacyAgentPrefs | undefined
  >;
  const legacyAgentDefault = input.isDefault ? legacyAgentDefaults[input.driver] : undefined;
  const providerInstances = {
    ...input.settings.providerInstances,
    [input.instanceId]: input.instance,
  };
  return {
    ...(legacyAgentDefault !== undefined
      ? {
          providers: {
            ...input.settings.providers,
            [input.driver]: legacyAgentDefault,
          } as DaemonPrefs["providers"],
        }
      : {}),
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
    providerInstances,
  };
}

// ── Background-activity interval helpers ─────────────────────────────
// Shared by the General panel's interval rows and the Providers panel's
// health-check row.
