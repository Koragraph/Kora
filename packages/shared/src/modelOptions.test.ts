import { describe, expect, it } from "vite-plus/test";
import { AgentProfileId, type ModelCapabilities } from "@kora/contracts";

import * as Model from "./modelOptions.ts";

const choice = (id: string, label: string, isDefault?: true) =>
  isDefault ? { id, label, isDefault } : { id, label };

const selectOption = (
  id: string,
  label: string,
  options: ReturnType<typeof choice>[],
  extra: { promptInjectedValues?: string[] } = {},
) => {
  const fallback = options.find((option) => "isDefault" in option) ?? options[0]!;
  return { id, label, type: "select" as const, options, currentValue: fallback.id, ...extra };
};

const effortSelect = selectOption(
  "effort",
  "Reasoning",
  [choice("low", "Low"), choice("max", "Max", true), choice("ultrathink", "Ultrathink")],
  { promptInjectedValues: ["ultrathink"] },
);
const windowSelect = selectOption("contextWindow", "Context Window", [
  choice("200k", "200k"),
  choice("1m", "1M", true),
]);
const claudeLike = Model.createModelCapabilities({
  optionDescriptors: [effortSelect, windowSelect],
});

const codexLike = Model.createModelCapabilities({
  optionDescriptors: [
    selectOption("reasoningEffort", "Reasoning", [
      choice("xhigh", "Extra High"),
      choice("medium", "Medium", true),
    ]),
    { id: "fastMode", label: "Fast Mode", type: "boolean" },
  ],
});

describe("option descriptors", () => {
  it("overlays the chosen values onto the model's descriptors", () => {
    const resolved = Model.getAgentOptionDescriptors({
      caps: claudeLike,
      selections: [
        { id: "contextWindow", value: "200k" },
        { id: "effort", value: "low" },
      ],
    });
    expect(resolved).toEqual([
      { ...effortSelect, currentValue: "low" },
      { ...windowSelect, currentValue: "200k" },
    ]);
  });

  it("turns resolved descriptors back into wire selections", () => {
    const resolved = Model.getAgentOptionDescriptors({
      caps: codexLike,
      selections: [
        { id: "fastMode", value: true },
        { id: "reasoningEffort", value: "xhigh" },
      ],
    });
    expect(Model.buildAgentOptionSelectionsFromDescriptors(resolved)).toEqual([
      { id: "reasoningEffort", value: "xhigh" },
      { id: "fastMode", value: true },
    ]);
  });

  it("keeps only what the user explicitly chose for dispatch", () => {
    const resolved = Model.getAgentOptionDescriptors({
      caps: codexLike,
      selections: [{ id: "fastMode", value: true }],
    });
    const explicit = Model.buildExplicitAgentOptionSelectionsFromDescriptors;
    expect(explicit(resolved, undefined)).toBeUndefined();
    expect(explicit(resolved, [{ id: "fastMode", value: true }])).toEqual([
      { id: "fastMode", value: true },
    ]);
  });

  it("puts the options array on a model pick", () => {
    const options = [
      { id: "fastMode", value: false },
      { id: "reasoningEffort", value: "xhigh" },
    ];
    expect(Model.createModelPick(AgentProfileId.make("codex"), "gpt-5.5", options)).toEqual({
      instanceId: "codex",
      model: "gpt-5.5",
      options,
    });
  });
});

describe("Claude ultrathink prefix", () => {
  const prefixed = (prompt: string) => Model.prefixClaudeEffort(prompt, "ultrathink");

  it.each([
    ["/clear", "/clear"],
    ["  /compact only the plan  ", "/compact only the plan"],
    ["\t/review lib/index.ts ", "/review lib/index.ts"],
    ["/code-review", "/code-review"],
    ["/my-plugin:task go", "/my-plugin:task go"],
    ["/ship.fast now", "/ship.fast now"],
  ])("leaves the slash command %j alone", (prompt, expected) => {
    expect(prefixed(prompt)).toBe(expected);
  });

  it.each(["Why does the build hang?", "/Users/sam/project/main.ts throws on start"])(
    "prefixes the ordinary prompt %j",
    (prompt) => {
      expect(prefixed(prompt)).toBe(`Ultrathink:\n${prompt}`);
    },
  );
});

describe("custom model entries", () => {
  const caps: ModelCapabilities = {
    optionDescriptors: [selectOption("effort", "Reasoning", [choice("max", "Max", true)])],
  };

  it("accepts slugs and objects, trims them and keeps the first of each slug", () => {
    const stored = [
      "  plain  ",
      { slug: "fancy", name: "  Fancy  ", capabilities: caps },
      "plain",
      { slug: "fancy", name: "Duplicate" },
      "",
      { name: "missing slug" },
      7,
      null,
    ];
    expect(Model.readCustomModelEntries(stored)).toEqual([
      { slug: "plain", name: "plain", capabilities: null },
      { slug: "fancy", name: "Fancy", capabilities: caps },
    ]);
  });

  it("keeps an entry whose capabilities do not parse, without them", () => {
    expect(
      Model.readCustomModelEntries([{ slug: "m", capabilities: { optionDescriptors: 1 } }]),
    ).toEqual([{ slug: "m", name: "m", capabilities: null }]);
  });

  it("reads a non-array as no entries", () => {
    expect(Model.readCustomModelEntries({ slug: "m" })).toEqual([]);
  });

  it("stores a bare slug unless a name or options make the object form necessary", () => {
    expect(Model.toCustomModelSetting({ slug: "m", name: "m", capabilities: null })).toBe("m");
    expect(
      Model.toCustomModelSetting({ slug: "m", name: "m", capabilities: { optionDescriptors: [] } }),
    ).toBe("m");
    const full = { slug: "m", name: "Mine", capabilities: caps };
    expect(Model.toCustomModelSetting(full)).toEqual(full);
  });
});
