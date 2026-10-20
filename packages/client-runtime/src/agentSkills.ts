import type { AgentSkill, AgentStatus } from "@kora/contracts";

export type AgentSkillSourceKind = "app" | "repo" | "project" | "personal" | "system" | "other";

const normalizedName = (name: string): string => name.trim().toLowerCase();

/** The provider's display name, else the skill name read as words (`my-skill:run` becomes `My Skill Run`). */
export function formatAgentSkillDisplayName(
  skill: Pick<AgentSkill, "name" | "displayName">,
): string {
  const explicit = skill.displayName?.trim();
  if (explicit) return explicit;
  return skill.name
    .split(/[\s:_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** First one wins; names compare trimmed and case-insensitively. */
export function dedupeAgentSkillsByName(skills: ReadonlyArray<AgentSkill>): AgentSkill[] {
  const seen = new Set<string>();
  const unique: AgentSkill[] = [];
  for (const skill of skills) {
    const key = normalizedName(skill.name);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(skill);
  }
  return unique;
}

/**
 * Switched off, it cannot run. One the provider reserves for the agent rejects user
 * invocation. A skill the agent may not start on its own is still fair game.
 */
export function isAgentSkillUserInvocable(
  skill: Pick<AgentSkill, "enabled" | "userInvocable">,
): boolean {
  return skill.enabled && skill.userInvocable !== false;
}

const SCOPE_KINDS: Readonly<Record<string, AgentSkillSourceKind>> = {
  repo: "repo",
  repository: "repo",
  project: "project",
  workspace: "project",
  local: "project",
  user: "personal",
  personal: "personal",
  system: "system",
};

export function resolveAgentSkillSourceKind(
  skill: Pick<AgentSkill, "path" | "scope">,
): AgentSkillSourceKind {
  const path = skill.path.replaceAll("\\", "/");
  if (path.includes("/.codex/plugins/") || path.includes("/.agents/plugins/")) return "app";
  return SCOPE_KINDS[skill.scope?.trim().toLowerCase() ?? ""] ?? "other";
}

const snapshotFor = (provider: AgentStatus, cwd: string | null | undefined) =>
  cwd ? provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd) : undefined;

export function resolveAgentSkillsForCwd(
  provider: AgentStatus,
  cwd: string | null | undefined,
): AgentStatus["skills"] {
  return snapshotFor(provider, cwd)?.skills ?? provider.skills;
}

export function resolveAgentSlashCommandsForCwd(
  provider: AgentStatus,
  cwd: string | null | undefined,
): AgentStatus["slashCommands"] {
  return snapshotFor(provider, cwd)?.slashCommands ?? provider.slashCommands;
}
