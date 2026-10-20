import { AgentId } from "@kora/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PromptCommandMenu, type PromptCommandItem } from "./PromptCommandMenu";

const CODEX = AgentId.make("codex");

/** Renders the open menu with `item` highlighted. */
const menuWith = (
  item: PromptCommandItem,
  triggerKind: "slash-command" | "skill" = "slash-command",
) =>
  renderToStaticMarkup(
    <PromptCommandMenu
      items={[item]}
      activeItemId={item.id}
      triggerKind={triggerKind}
      isLoading={false}
      resolvedTheme="dark"
      onSelect={() => {}}
      onHighlightedItemChange={() => {}}
    />,
  );

const modelCommand: PromptCommandItem = {
  description: "Choose the model this thread answers with",
  id: "builtin:model",
  label: "/model",
  command: "model",
  type: "slash-command",
};

describe("PromptCommandMenu", () => {
  it("lists a built-in command with its description on the solid composer surface", () => {
    const markup = menuWith(modelCommand);
    expect(markup).toContain("/model");
    expect(markup).toContain("Choose the model this thread answers with");
    expect(markup).toContain("data-prompt-command-drawer");
    // Solid, not glass: a see-through menu let the transcript show through.
    expect(markup).toContain("before:bg-(--chat-composer-attached-surface)!");
  });

  it("shows a repo skill under its display name with a Repo badge", () => {
    const markup = menuWith({
      id: "skill:codex:release-notes",
      type: "skill",
      provider: CODEX,
      label: "/skill:release-notes",
      description: "Draft release notes from merged work",
      skill: {
        name: "release-notes",
        displayName: "Release Notes",
        scope: "repo",
        enabled: true,
        path: "/repo/.codex/skills/release-notes/SKILL.md",
      },
    });
    expect(markup).toContain('<span class="text-secondary-label">/skill:</span>Release Notes');
    expect(markup).toContain(">Repo</span>");
    expect(markup).toContain("lucide-folder");
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain("Draft release notes from merged work");
  });

  it("marks a skill shipped by a plugin as an App Skill", () => {
    const markup = menuWith(
      {
        id: "skill:codex:screens",
        type: "skill",
        provider: CODEX,
        label: "Screens",
        description: "Capture and compare screens",
        skill: {
          name: "screens",
          scope: "user",
          enabled: true,
          path: "/home/dev/.codex/plugins/capture/skills/screens/SKILL.md",
        },
      },
      "skill",
    );
    expect(markup).toContain("Screens");
    expect(markup).toContain(">App Skill</span>");
    expect(markup).toContain("<svg");
    expect(markup).toContain("Capture and compare screens");
  });
});
