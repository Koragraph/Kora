// @effect-diagnostics nodeBuiltinImport:off -- temp-folder fixtures for plain Node fs discovery code.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  discoverClaudeSkills,
  mapCodexSkill,
  parseSkillFrontmatter,
  resolveCodexBin,
} from "./skillDiscovery.ts";

function write(file: string, text: string): void {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, text);
}

NodeTest.test("frontmatter: plain, quoted, folded and the two invocation flags", () => {
  const fm = parseSkillFrontmatter(
    [
      "---",
      "name: grill",
      "description: >",
      "  Ask hard questions",
      "  until it holds up.",
      "disable-model-invocation: true",
      "user-invocable: false",
      "---",
      "# body",
    ].join("\n"),
  );
  NodeAssert.deepEqual(fm, {
    name: "grill",
    description: "Ask hard questions until it holds up.",
    disableModelInvocation: true,
    userInvocable: false,
  });
  NodeAssert.equal(parseSkillFrontmatter("no frontmatter"), null);
  NodeAssert.equal(parseSkillFrontmatter('---\ndescription: "quoted"\n---')?.description, "quoted");
});

NodeTest.test(
  "claude: user + project skills, project wins a clash, overrides switch one off",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-skills-"));
    const home = NodePath.join(root, "home");
    const repo = NodePath.join(root, "repo");
    const sub = NodePath.join(repo, "pkg");
    NodeFS.mkdirSync(NodePath.join(repo, ".git"), { recursive: true });
    write(
      NodePath.join(home, ".claude", "skills", "shared", "SKILL.md"),
      "---\ndescription: user one\n---\n",
    );
    write(
      NodePath.join(home, ".claude", "skills", "mine", "SKILL.md"),
      "---\ndescription: mine\n---\n",
    );
    write(
      NodePath.join(repo, ".claude", "skills", "shared", "SKILL.md"),
      "---\ndescription: project one\n---\n",
    );
    write(
      NodePath.join(sub, ".claude", "skills", "deep", "SKILL.md"),
      "---\nuser-invocable: false\n---\n",
    );
    write(
      NodePath.join(home, ".claude", "settings.json"),
      JSON.stringify({ skillOverrides: { mine: "off" } }),
    );
    NodeFS.mkdirSync(sub, { recursive: true });

    const skills = discoverClaudeSkills(sub, {}, home);
    const by = Object.fromEntries(skills.map((s) => [s.name, s]));
    NodeAssert.deepEqual(Object.keys(by).sort(), ["deep", "mine", "shared"]);
    NodeAssert.equal(by.shared?.description, "project one");
    NodeAssert.equal(by.shared?.scope, "project");
    NodeAssert.equal(by.mine?.enabled, false);
    NodeAssert.equal(by.deep?.userInvocable, false);

    const userOnly = discoverClaudeSkills(null, {}, home);
    NodeAssert.deepEqual(userOnly.map((s) => s.name).sort(), ["mine", "shared"]);
    NodeFS.rmSync(root, { recursive: true, force: true });
  },
);

NodeTest.test(
  "codex: a skills/list row maps to an AgentSkill; rows without a path are dropped",
  () => {
    NodeAssert.deepEqual(
      mapCodexSkill({
        name: "deepaudit",
        description: "Audit",
        path: "/h/.agents/skills/deepaudit/SKILL.md",
        scope: "user",
        enabled: true,
        interface: { displayName: "Deep Audit", shortDescription: "audit it" },
      }),
      {
        name: "deepaudit",
        description: "Audit",
        path: "/h/.agents/skills/deepaudit/SKILL.md",
        scope: "user",
        enabled: true,
        displayName: "Deep Audit",
        shortDescription: "audit it",
      },
    );
    NodeAssert.equal(mapCodexSkill({ name: "x" }), null);
  },
);

// Windows finds only PATHEXT names in a search (npm writes codex.cmd beside an extensionless sh shim).
const CODEX = process.platform === "win32" ? "codex.cmd" : "codex";

NodeTest.test(
  "codex binary: found under ~/.local/bin when PATH is bare; plain name when nowhere",
  () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-codex-"));
    NodeAssert.equal(resolveCodexBin(home, { PATH: "/nonexistent" }, null), "codex");
    write(NodePath.join(home, ".local", "bin", CODEX), "#!/bin/sh\n");
    NodeFS.chmodSync(NodePath.join(home, ".local", "bin", CODEX), 0o755);
    NodeAssert.equal(
      resolveCodexBin(home, { PATH: "/nonexistent" }, null),
      NodePath.join(home, ".local", "bin", CODEX),
    );
    NodeFS.rmSync(home, { recursive: true, force: true });
  },
);

NodeTest.test("codex binary: the path set in Settings > Engines wins (deep A3-10)", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-codex-"));
  const kh = NodePath.join(home, "kh");
  const mine = NodePath.join(home, "custom", "codex");
  write(mine, "#!/bin/sh\n");
  NodeFS.chmodSync(mine, 0o755);
  write(NodePath.join(home, ".local", "bin", CODEX), "#!/bin/sh\n");
  NodeFS.chmodSync(NodePath.join(home, ".local", "bin", CODEX), 0o755);
  write(NodePath.join(kh, "engines.json"), JSON.stringify({ executables: { codex: mine } }));
  NodeAssert.equal(resolveCodexBin(home, { PATH: "/nonexistent" }, kh), mine);
  // a path that is not executable is ignored, the search continues
  write(
    NodePath.join(kh, "engines.json"),
    JSON.stringify({ executables: { codex: NodePath.join(home, "gone") } }),
  );
  NodeAssert.equal(
    resolveCodexBin(home, { PATH: "/nonexistent" }, kh),
    NodePath.join(home, ".local", "bin", CODEX),
  );
  NodeFS.rmSync(home, { recursive: true, force: true });
});
