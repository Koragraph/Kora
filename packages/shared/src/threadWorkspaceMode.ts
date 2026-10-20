import type { ThreadWorkspaceMode } from "@kora/contracts";

/**
 * Canonical priority order for a project's default thread env mode:
 * per-project setting > checked-in kora.json > global server setting.
 *
 * An explicit composer pick outranks all of these; callers apply it before
 * consulting the defaults. Web resolves the sources imperatively at draft
 * creation, mobile reactively — both must route through this function so the
 * platforms cannot disagree on the order.
 */
type MaybeMode = ThreadWorkspaceMode | null | undefined;

export function resolveDefaultThreadEnvMode({
  globalDefault,
  projectFile,
  projectSetting,
}: {
  readonly globalDefault: ThreadWorkspaceMode;
  readonly projectFile: MaybeMode;
  readonly projectSetting: MaybeMode;
}): ThreadWorkspaceMode {
  for (const candidate of [projectSetting, projectFile]) {
    if (candidate != null) return candidate;
  }
  return globalDefault;
}
