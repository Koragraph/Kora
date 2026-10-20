import { useEffect } from "react";

import { useClientPrefsHydrated, usePrimaryPrefs, useUpdatePrimaryPrefs } from "../hooks/usePrefs";
import { resolvePlanAgentHealPatch } from "../modelPick";

/**
 * Heals persisted text-generation model selections that still reference the
 * opencode "plan" agent. The dropdown hides the option while legacy plan mode
 * is off, but the toggle handler only runs when the setting flips; users who
 * already have plan mode off with a stored "plan" selection need this pass
 * whenever the settings load.
 */
export function PlanAgentSelectionHeal() {
  const planModeEnabled = usePrimaryPrefs((settings) => settings.planModeEnabled);
  const textGenerationModelPick = usePrimaryPrefs(
    (settings) => settings.textGenerationModelSelection,
  );
  const sourceControlWriterModelPick = usePrimaryPrefs(
    (settings) => settings.sourceControlWriterModelSelection,
  );
  const prefsHydrated = useClientPrefsHydrated();
  const updatePrefs = useUpdatePrimaryPrefs();

  useEffect(() => {
    // planModeEnabled reads as false until client settings hydrate, so never
    // heal before then: we would strip a stored plan selection from a user
    // whose plan mode is actually on.
    if (!prefsHydrated) {
      return;
    }
    const patch = resolvePlanAgentHealPatch({
      planModeEnabled,
      textGenerationModelSelection: textGenerationModelPick,
      sourceControlWriterModelSelection: sourceControlWriterModelPick,
    });
    if (patch) {
      updatePrefs(patch);
    }
  }, [
    planModeEnabled,
    prefsHydrated,
    textGenerationModelPick,
    sourceControlWriterModelPick,
    updatePrefs,
  ]);

  return null;
}
