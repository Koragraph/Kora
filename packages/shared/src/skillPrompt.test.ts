import { expect, it } from "vite-plus/test";

import { rewriteSkillMentions } from "./skillPrompt.ts";

const known = [{ name: "research" }, { name: "plugin:thing" }];

it("claude: a leading $skill becomes the slash command", () => {
  expect(rewriteSkillMentions("$research the auth flow", "claude", known)).toBe(
    "/research the auth flow",
  );
  expect(rewriteSkillMentions("$plugin:thing now", "claude", known)).toBe("/plugin:thing now");
});

it("claude: a later $skill becomes words, not a dead slash", () => {
  expect(rewriteSkillMentions("please use $research for this", "claude", known)).toBe(
    "please use the research skill for this",
  );
});

it("unknown names and shell variables are left alone", () => {
  expect(rewriteSkillMentions("echo $HOME and $nope ok", "claude", known)).toBe(
    "echo $HOME and $nope ok",
  );
});

it("codex and other drivers keep $name as typed", () => {
  expect(rewriteSkillMentions("$research it", "codex", known)).toBe("$research it");
  expect(rewriteSkillMentions("$research it", "koragent", known)).toBe("$research it");
});

it("a mention with nothing after it (a trimmed send) still rewrites", () => {
  expect(rewriteSkillMentions("$research", "claude", known)).toBe("/research");
  expect(rewriteSkillMentions("see $research", "claude", known)).toBe("see the research skill");
});
