import { AgentId, AgentProfileId, type AgentStatus } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  dedupeAgentSkillsByName,
  formatAgentSkillDisplayName,
  resolveAgentSkillsForCwd,
  resolveAgentSlashCommandsForCwd,
  resolveAgentSkillSourceKind,
} from "./agentSkills.ts";

const REPO = "/src/alpha";
const skill = (name: string, path: string) => ({ enabled: true, path, name });

const provider = {
  workspaceSnapshots: [
    {
      skills: [skill("local", `${REPO}/SKILL.md`)],
      slashCommands: [{ name: "local" }],
      checkedAt: "2026-02-02T08:30:00.000Z",
      cwd: REPO,
    },
  ],
  skills: [skill("everywhere", "/shared/SKILL.md")],
  slashCommands: [{ name: "everywhere" }],
  models: [],
  checkedAt: "2026-02-02T08:00:00.000Z",
  auth: { status: "authenticated" },
  status: "ready",
  version: "2.3.4",
  installed: true,
  enabled: true,
  driver: AgentId.make("codex"),
  instanceId: AgentProfileId.make("codex"),
} satisfies AgentStatus;

describe("formatAgentSkillDisplayName", () => {
  it("uses the display name when the provider sent one", () => {
    const named = { displayName: "Tidy Imports!", name: "tidy-imports" };
    expect(formatAgentSkillDisplayName(named)).toBe("Tidy Imports!");
  });

  it("title-cases the slug otherwise", () => {
    expect(formatAgentSkillDisplayName({ name: "tidy-up-imports" })).toBe("Tidy Up Imports");
  });
});

describe("dedupeAgentSkillsByName", () => {
  it("drops later skills whose name differs only in case, keeping order", () => {
    const kept = skill("lint-fix", "/home/dev/.codex/skills/lint-fix/SKILL.md");
    const other = skill("screenshots", "/home/dev/.agents/skills/screenshots/SKILL.md");
    const shadowed = skill("Lint-Fix", "/home/dev/.agents/skills/lint-fix/SKILL.md");
    expect(dedupeAgentSkillsByName([kept, other, shadowed])).toEqual([kept, other]);
  });
});

describe("resolveAgentSkillSourceKind", () => {
  const kindOf = (path: string, scope?: string) =>
    resolveAgentSkillSourceKind(scope === undefined ? { path } : { path, scope });

  it("treats a skill shipped inside a plugin as an app skill", () => {
    const pluginSkill = "/home/dev/.codex/plugins/cache/vendor/tooling/skills/ci-repair/SKILL.md";
    expect(kindOf(pluginSkill, "user")).toBe("app");
  });

  it.each([
    ["repo", "repo"],
    ["project", "project"],
    ["user", "personal"],
    ["system", "system"],
    // Anything unrecognised, or no scope at all, still shows up.
    ["shared_by_team", "other"],
    [undefined, "other"],
  ])("scope %s is listed as %s", (scope, kind) => {
    expect(kindOf("/somewhere/skills/thing/SKILL.md", scope)).toBe(kind);
  });
});

describe("workspace provider snapshots", () => {
  it("prefers the snapshot taken in this folder once one exists", () => {
    const snapshot = provider.workspaceSnapshots[0]!;
    expect(resolveAgentSkillsForCwd(provider, REPO)).toEqual(snapshot.skills);
    expect(resolveAgentSlashCommandsForCwd(provider, REPO)).toEqual(snapshot.slashCommands);
  });

  it("falls back to the machine-wide lists elsewhere", () => {
    expect(resolveAgentSlashCommandsForCwd(provider, null)).toEqual(provider.slashCommands);
    expect(resolveAgentSkillsForCwd(provider, "/src/beta")).toEqual(provider.skills);
  });
});
