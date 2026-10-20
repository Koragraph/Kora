import type {
  ModelPick,
  HostId,
  ExecutionHostCapabilities,
  DaemonPrefsPatch,
  DaemonPrefs,
} from "@kora/contracts";
import { isModelPickAgentEnabled } from "@kora/shared/daemonPrefs";

import type { HostLinkPhase } from "../link/presentation.ts";

// Preferences that live in each server's settings.json only because the server acts on them
// (auto-settling threads with no client attached), but that the user wants the same everywhere.
const SHARED_KEYS = [
  ...(["continueThreadsAfterServerUpdate", "sidebarAutoSettleAfterDays"] as const),
  ...(["sidebarAutoSettleOnMerge", "newWorktreesStartFromOrigin"] as const),
  ...(["sourceControlWritingStyle", "textGenerationModelSelection"] as const),
] as const;

export type SharedDaemonSettingKey = (typeof SHARED_KEYS)[number];

const isSharedKey = (key: string): key is SharedDaemonSettingKey =>
  (SHARED_KEYS as ReadonlyArray<string>).includes(key);

/** Shared keys go to every environment; everything else (project overrides, machine settings) stays on the primary. */
export function splitSharedDaemonPatch(patch: DaemonPrefsPatch): {
  sharedPatch: DaemonPrefsPatch;
  localPatch: DaemonPrefsPatch;
} {
  const localPatch: Record<string, unknown> = {};
  const sharedPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    (isSharedKey(key) ? sharedPatch : localPatch)[key] = value;
  }
  return {
    sharedPatch: sharedPatch as DaemonPrefsPatch,
    localPatch: localPatch as DaemonPrefsPatch,
  };
}

const driverOf = (settings: DaemonPrefs, instanceId: string): string =>
  (settings.providerInstances as Record<string, { driver: string } | undefined>)[instanceId]
    ?.driver ?? instanceId;

/** Drop the preferences a particular target host cannot honour. */
export function filterSharedDaemonPatch(
  patch: DaemonPrefsPatch,
  capabilities: Pick<ExecutionHostCapabilities, "threadRestartContinuation"> | undefined,
  settings?: DaemonPrefs,
  sourcePrefs: DaemonPrefs | undefined = settings,
  targetIsSource = false,
): DaemonPrefsPatch {
  const filtered: { -readonly [K in keyof DaemonPrefsPatch]: DaemonPrefsPatch[K] } = { ...patch };

  if (filtered.textGenerationModelSelection !== undefined && !targetIsSource) {
    const pick = filtered.textGenerationModelSelection;
    // Writes to the source itself keep the server's own fallback behaviour.
    const unsupported =
      settings === undefined ||
      (sourcePrefs !== undefined &&
        driverOf(
          settings,
          pick.instanceId ?? sourcePrefs.textGenerationModelSelection.instanceId,
        ) !==
          driverOf(
            sourcePrefs,
            pick.instanceId ?? sourcePrefs.textGenerationModelSelection.instanceId,
          )) ||
      !isModelPickAgentEnabled(settings, {
        ...settings.textGenerationModelSelection,
        ...pick,
      } as ModelPick);
    if (unsupported) delete filtered.textGenerationModelSelection;
  }

  if (capabilities?.threadRestartContinuation !== true) {
    delete filtered.continueThreadsAfterServerUpdate;
  }
  return filtered;
}

export function supportsSharedPrefsSync(environment: {
  readonly connection: { readonly phase: HostLinkPhase };
  readonly daemonConfig: {
    readonly environment: {
      readonly capabilities: Pick<ExecutionHostCapabilities, "threadAutoSettlement">;
    };
  } | null;
}): boolean {
  return (
    environment.connection.phase === "connected" &&
    environment.daemonConfig?.environment.capabilities.threadAutoSettlement === true
  );
}

export interface SharedPrefsHost {
  readonly hostId: HostId;
  readonly label: string;
  readonly syncEligible: boolean;
  readonly settings: DaemonPrefs | null;
  readonly capabilities?: Pick<ExecutionHostCapabilities, "threadRestartContinuation">;
}
