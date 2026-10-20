import type { AgentSkill } from "@kora/contracts";
import { describe, expect, test } from "vite-plus/test";

import { searchAgentSkills } from "./agentSkillSearch";

const skill = (name: string, extra: Partial<AgentSkill> = {}): AgentSkill => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  enabled: true,
  ...extra,
});
const names = (found: ReadonlyArray<{ name: string }>) => found.map((s) => s.name);

describe("searchAgentSkills", () => {
  test("an empty query lists enabled skills in their given order", () => {
    const all = [skill("alpha"), skill("beta"), skill("gamma", { enabled: false })];
    expect(names(searchAgentSkills(all, ""))).toEqual(["alpha", "beta"]);
  });

  test("a skill defined twice appears once, using its first definition", () => {
    const all = [
      skill("audit", { path: "/home/a/.codex/skills/audit/SKILL.md" }),
      skill("browse"),
      skill("audit", { path: "/home/a/.agents/skills/audit/SKILL.md" }),
    ];
    expect(searchAgentSkills(all, "").map((s) => s.path)).toEqual([
      "/home/a/.codex/skills/audit/SKILL.md",
      "/skills/browse/SKILL.md",
    ]);
  });

  test("disabled skills never match", () => {
    const all = [skill("ui", { displayName: "Ui", enabled: false }), skill("frontend-design")];
    expect(searchAgentSkills(all, "ui")).toEqual([]);
  });

  test("skills only the user can invoke are kept, agent-only ones are not", () => {
    const all = [
      skill("re-release-version", { userInvocationOnly: true }),
      skill("release-context", { userInvocable: false }),
      skill("release-version"),
    ];
    expect(names(searchAgentSkills(all, "release"))).toEqual([
      "release-version",
      "re-release-version",
    ]);
  });

  test("an abbreviation matches by fuzzy subsequence", () => {
    const all = [
      skill("gh-fix-ci", { displayName: "Gh Fix Ci" }),
      skill("github"),
      skill("agent-browser"),
    ];
    expect(names(searchAgentSkills(all, "gfc"))).toEqual(["gh-fix-ci"]);
  });

  test("an exact name outranks broader matches and non-matches are dropped", () => {
    const all = [
      skill("agent-browser", {
        displayName: "Agent Browser",
        shortDescription: "Browser automation CLI",
      }),
      skill("building-native-ui", {
        displayName: "Building Native Ui",
        shortDescription: "Expo Router guide",
      }),
      skill("ui", { displayName: "Ui", shortDescription: "Explore, build, and refine UI." }),
    ];
    expect(names(searchAgentSkills(all, "ui"))).toEqual(["ui", "building-native-ui"]);
  });
});
