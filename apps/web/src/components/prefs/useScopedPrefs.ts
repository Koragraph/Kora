import {
  planProjectOverridesClear,
  persistScopedPrefsPatch,
  type ProjectOverrideEntry,
  planScopedPrefsClear,
  planScopedPrefsPatch,
  type ScopedSettingSource,
  scopedPrefsAreMixed,
  scopedPrefsSource,
  type ScopedPrefsPatch,
} from "./scopedPrefs";
import { useOptionalPrefsScope, usePrefsScope } from "./PrefsScopeContext";
import { toastManager } from "../ui/toast";
import { persistClientPrefsPatch, mergeHostPrefs, useClientPrefs } from "../../hooks/usePrefs";
import { useAtomAction } from "../../atoms/use-atom-command";
import { daemonHost } from "../../atoms/server";
import type { UnifiedPrefs } from "@kora/contracts/clientPrefs";
import {
  type ProjectScopedDaemonSettingKey,
  DEFAULT_DAEMON_PREFS,
  type DaemonPrefs,
} from "@kora/contracts";
import { useCallback, useMemo } from "react";

export function useScopedPrefs<T = UnifiedPrefs>(selector?: (settings: UnifiedPrefs) => T): T {
  const { target } = usePrefsScope();
  const clientPrefs = useClientPrefs();
  const daemonPrefs = target?.settings ?? DEFAULT_DAEMON_PREFS;
  const merged = useMemo(
    () => mergeHostPrefs(daemonPrefs, clientPrefs),
    [daemonPrefs, clientPrefs],
  );
  return useMemo(() => (selector ? selector(merged) : (merged as T)), [merged, selector]);
}

export function useScopedPrefsMixed(keys: readonly (keyof DaemonPrefs)[]): boolean {
  const { targets } = usePrefsScope();
  return scopedPrefsAreMixed(targets, keys);
}

export function useScopedSettingSource(keys: readonly (keyof DaemonPrefs)[]): ScopedSettingSource {
  const { targets } = usePrefsScope();
  return scopedPrefsSource(targets, keys);
}

type Plan = Parameters<typeof persistScopedPrefsPatch>[0] & { unavailableReason: string | null };

function useRunPlan() {
  const updateSettings = useAtomAction(daemonHost.updateSettings, { reportFailure: false });
  return useCallback(
    async (plan: Plan) => {
      if (plan.unavailableReason) {
        toastManager.add({
          description: plan.unavailableReason,
          title: "Setting not saved",
          type: "warning",
        });
        return;
      }
      const { failedHosts, savedHostCount } = await persistScopedPrefsPatch(
        plan,
        (write) => updateSettings(write as never) as Promise<{ _tag: "Success" | "Failure" }>,
        persistClientPrefsPatch,
      );
      if (failedHosts.length === 0) return;
      const someSaved = savedHostCount > 0;
      toastManager.add({
        type: "error",
        title: someSaved ? "Setting saved on some environments" : "Setting not saved",
        description:
          `Could not update ${failedHosts.map((host) => host.label).join(", ")}.` +
          (someSaved ? " The other selected environments saved the change." : ""),
      });
    },
    [updateSettings],
  );
}

export function useUpdateScopedPrefs(): (patch: ScopedPrefsPatch) => void {
  const { scope, environments } = usePrefsScope();
  const run = useRunPlan();
  return useCallback(
    (patch) => void run(planScopedPrefsPatch(scope, environments, patch)),
    [environments, run, scope],
  );
}

export function useClearScopedPrefs(): (keys: readonly ProjectScopedDaemonSettingKey[]) => void {
  const context = useOptionalPrefsScope();
  const run = useRunPlan();
  return useCallback(
    (keys) => {
      if (!context) return;
      void run(planScopedPrefsClear(context.scope, context.environments, keys));
    },
    [context, run],
  );
}

export function useClearProjectOverrides(): (
  entries: readonly ProjectOverrideEntry[],
  keys: readonly ProjectScopedDaemonSettingKey[],
) => void {
  const context = useOptionalPrefsScope();
  const run = useRunPlan();
  return useCallback(
    (entries, keys) => {
      if (!context) return;
      void run(planProjectOverridesClear(context.environments, entries, keys));
    },
    [context, run],
  );
}
