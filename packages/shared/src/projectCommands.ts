import type { ProjectId, ProjectAction, DaemonPrefs } from "@kora/contracts";

type ProjectCommandPrefs = Pick<
  DaemonPrefs,
  | "projectSettingsFolded"
  | "projectSettingsOverrides"
  | "projectScriptOverrides"
  | "defaultProjectScripts"
>;

/**
 * The project's override wins, then environment defaults. Until the legacy
 * fields have been folded into `projectSettingsOverrides`, the old map (null
 * there meant "reset to machine defaults") and the aggregate's own scripts
 * still count, so a server that has not run the fold yet behaves as before.
 */
export function resolveProjectCommands(
  settings: ProjectCommandPrefs,
  project: { id: ProjectId; scripts: readonly ProjectAction[] },
): readonly ProjectAction[] {
  const machineDefaults = settings.defaultProjectScripts;
  const own = settings.projectSettingsOverrides[project.id]?.defaultProjectScripts;
  if (own !== undefined) return own;
  if (settings.projectSettingsFolded) return machineDefaults;
  const legacy = settings.projectScriptOverrides[project.id];
  if (legacy === null) return machineDefaults;
  if (legacy !== undefined) return legacy;
  return project.scripts.length ? project.scripts : machineDefaults;
}

type ProjectDir = { project: { cwd: string }; worktreePath?: string | null };

interface ProjectCommandRuntimeEnvInput extends ProjectDir {
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: ProjectDir): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectCommandEnv(input: ProjectCommandRuntimeEnvInput): Record<string, string> {
  return {
    KORA_PROJECT_ROOT: input.project.cwd,
    ...(input.worktreePath ? { KORA_WORKTREE_PATH: input.worktreePath } : {}),
    ...input.extraEnv,
  };
}
