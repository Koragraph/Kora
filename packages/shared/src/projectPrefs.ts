import {
  PROJECT_SCOPED_DAEMON_SETTING_KEYS,
  type DaemonPrefs,
  type ModelPick,
  type ProjectId,
  type ProjectPrefsOverrides,
  type ProjectScopedDaemonSettingKey,
  type ThreadWorkspaceMode,
} from "@kora/contracts";

import { isModelPickAgentEnabled } from "./daemonPrefs.ts";

export type ProjectSettingSource = "environment" | "project";
export type ProjectSettingSources = Readonly<
  Record<ProjectScopedDaemonSettingKey, ProjectSettingSource>
>;

export interface ResolvedProjectPrefs {
  readonly settings: DaemonPrefs;
  readonly sources: ProjectSettingSources;
  readonly overrides: ProjectPrefsOverrides;
}

/** Fields that used to live on the project aggregate, before they were folded into the overrides. */
export interface LegacyProjectPrefsFields {
  readonly defaultModelSelection?: ModelPick | null | undefined;
  readonly defaultThreadEnvMode?: ThreadWorkspaceMode | null | undefined;
}

const NO_OVERRIDES: ProjectPrefsOverrides = Object.freeze({});
const ALL_FROM_ENVIRONMENT = Object.freeze(
  Object.fromEntries(PROJECT_SCOPED_DAEMON_SETTING_KEYS.map((key) => [key, "environment"])),
) as ProjectSettingSources;

/** Model picks whose agent is switched off fall back to the environment's choice. */
const MODEL_KEYS_SKIPPED_WHEN_DISABLED: ReadonlySet<ProjectScopedDaemonSettingKey> = new Set([
  "textGenerationModelSelection",
  "defaultModelSelection",
]);

export function resolveProjectPrefs(
  settings: DaemonPrefs,
  projectId: ProjectId | null,
  project?: LegacyProjectPrefsFields | null,
): ResolvedProjectPrefs {
  const stored: ProjectPrefsOverrides =
    projectId === null ? {} : (settings.projectSettingsOverrides[projectId] ?? {});

  // Once folded, the override record alone is authoritative: a stale aggregate must not undo a reset.
  const overrides: ProjectPrefsOverrides =
    project == null || settings.projectSettingsFolded
      ? stored
      : {
          ...(project.defaultThreadEnvMode == null
            ? {}
            : { defaultThreadEnvMode: project.defaultThreadEnvMode }),
          ...(project.defaultModelSelection == null
            ? {}
            : { defaultModelSelection: project.defaultModelSelection }),
          ...stored,
        };

  if (!Object.keys(overrides).length) {
    return { settings, sources: ALL_FROM_ENVIRONMENT, overrides: NO_OVERRIDES };
  }

  const effective: Record<string, unknown> = { ...settings };
  const sources = { ...ALL_FROM_ENVIRONMENT } as Record<
    ProjectScopedDaemonSettingKey,
    ProjectSettingSource
  >;
  for (const key of PROJECT_SCOPED_DAEMON_SETTING_KEYS) {
    if (!Object.hasOwn(overrides, key)) continue;
    const value = overrides[key];
    if (
      MODEL_KEYS_SKIPPED_WHEN_DISABLED.has(key) &&
      value !== null &&
      value !== undefined &&
      !isModelPickAgentEnabled(settings, value as ModelPick)
    ) {
      continue;
    }
    effective[key] = value;
    sources[key] = "project";
  }
  return { settings: effective as unknown as DaemonPrefs, sources, overrides };
}

/** The project's overrides without `keys`; null when nothing is left (the caller deletes the entry). */
export function clearProjectPrefsOverrides(
  settings: Pick<DaemonPrefs, "projectSettingsOverrides">,
  projectId: ProjectId,
  keys: readonly ProjectScopedDaemonSettingKey[],
): ProjectPrefsOverrides | null {
  const entry = settings.projectSettingsOverrides[projectId];
  if (entry === undefined) return null;
  const remaining = Object.fromEntries(
    Object.entries(entry).filter(([key]) => !keys.includes(key as ProjectScopedDaemonSettingKey)),
  ) as ProjectPrefsOverrides;
  return Object.keys(remaining).length === 0 ? null : remaining;
}
