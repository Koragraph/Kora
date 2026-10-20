import { AgentId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { PromptCommandItem } from "./PromptCommandMenu";
import {
  searchSlashCommandItems,
  slashCommandItemsForPromptPosition,
} from "./promptSlashCommandSearch";

type SlashItem = Extract<
  PromptCommandItem,
  { type: "slash-command" | "provider-slash-command" | "skill" }
>;

const CLAUDE = AgentId.make("claude");

const builtIn = (command: "model" | "default", description: string): SlashItem => ({
  description,
  label: `/${command}`,
  command,
  type: "slash-command",
  id: `builtin:${command}`,
});

const agentCommand = (name: string, description: string): SlashItem => ({
  description,
  label: `/${name}`,
  command: { name },
  provider: CLAUDE,
  type: "provider-slash-command",
  id: `agent:${name}`,
});

const skill = (
  name: string,
  description: string,
  extra: { displayName?: string; shortDescription?: string } = {},
): SlashItem => ({
  description,
  label: `/skill:${name}`,
  skill: { name, enabled: true, path: `/skills/${name}/SKILL.md`, ...extra },
  provider: CLAUDE,
  type: "skill",
  id: `skill:${name}`,
});

const found = (items: SlashItem[], query: string) =>
  searchSlashCommandItems(items, query).map(({ id }) => id);

describe("searchSlashCommandItems", () => {
  it("returns everything, in order, for an empty query or a bare slash", () => {
    const items = [builtIn("model", "Pick a model"), skill("tidy", "Tidy prose")];
    expect(found(items, "")).toEqual(["builtin:model", "skill:tidy"]);
    expect(found(items, "/")).toEqual(["builtin:model", "skill:tidy"]);
  });

  it("ranks an exact command name above a description that merely mentions the word", () => {
    const items = [
      builtIn("default", "Go back to plain build mode"),
      agentCommand("design-system", "Work on the design system"),
      agentCommand("build", "Run the build"),
    ];
    expect(found(items, "build")).toEqual(["agent:build", "builtin:default"]);
  });

  it("matches command names fuzzily", () => {
    const items = [
      agentCommand("pr-review-fix", "Fix review comments"),
      agentCommand("print", "Print a file"),
    ];
    expect(found(items, "prf")).toEqual(["agent:pr-review-fix"]);
  });

  it("finds skills by name, description and display name", () => {
    const writer = skill("ghost-writer", "Draft text in your voice", {
      displayName: "Ghost Writer",
      shortDescription: "Draft text in your voice",
    });
    expect(found([writer], "ghost")).toEqual(["skill:ghost-writer"]);
    expect(found([writer], "voice")).toEqual(["skill:ghost-writer"]);
    expect(found([writer], "ghost writer")).toEqual(["skill:ghost-writer"]);
  });

  it("accepts the skill: prefix as typed in the menu", () => {
    const items = [skill("screens", "Capture screens")];
    expect(found(items, "/skill:ghost")).toEqual([]);
    expect(found(items, "/skill:scr")).toEqual(["skill:screens"]);
    expect(found(items, "/skill")).toEqual(["skill:screens"]);
    // A partial "skill" lists every skill; other fragments of the word do not.
    expect(found(items, "/ski")).toEqual(["skill:screens"]);
    expect(found(items, "/kil")).toEqual([]);
  });
});

describe("slashCommandItemsForPromptPosition", () => {
  const items = [
    builtIn("model", "Pick a model"),
    agentCommand("compact", "Shrink the context"),
    skill("tidy", "Tidy prose"),
  ];

  it("offers agent commands only at the start of the message", () => {
    expect(slashCommandItemsForPromptPosition(items, true).map(({ id }) => id)).toEqual([
      "builtin:model",
      "agent:compact",
      "skill:tidy",
    ]);
    expect(slashCommandItemsForPromptPosition(items, false).map(({ id }) => id)).toEqual([
      "builtin:model",
      "skill:tidy",
    ]);
  });

  it("returns a fresh array either way", () => {
    expect(slashCommandItemsForPromptPosition(items, true)).not.toBe(items);
  });
});
