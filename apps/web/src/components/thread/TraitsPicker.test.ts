import { AgentId, type AgentOptionDescriptor } from "@kora/contracts";
import { describe, expect, test } from "vite-plus/test";

import { buildTraitsTriggerDisplay, buildUnavailableModelOptionDescriptors } from "./TraitsPicker";

type Select = Extract<AgentOptionDescriptor, { type: "select" }>;
type Toggle = Extract<AgentOptionDescriptor, { type: "boolean" }>;

const select = (
  id: string,
  current: string | undefined,
  options: Array<{ id: string; label: string; isDefault?: boolean }>,
  label = id,
): Select => ({
  id,
  label,
  type: "select",
  options,
  ...(current ? { currentValue: current } : {}),
});
const toggle = (id: string, label: string, on: boolean): Toggle => ({
  id,
  label,
  type: "boolean",
  currentValue: on,
});

const effort = select("reasoningEffort", "high", [
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
]);
const context1m = select("contextWindow", "1m", [
  { id: "200k", label: "200k" },
  { id: "1m", label: "1M" },
]);
const fast = (on: boolean) => toggle("fastMode", "Fast Mode", on);
const tier = (current: "default" | "priority" | "flex") =>
  select(
    "serviceTier",
    current,
    [
      { id: "flex", label: "Flex" },
      { id: "priority", label: "Fast" },
      { id: "default", label: "Standard", isDefault: true },
    ],
    "Service Tier",
  );

const trigger = (descriptors: AgentOptionDescriptor[], ultrathink = false) =>
  buildTraitsTriggerDisplay({
    descriptors,
    provider: AgentId.make("codex"),
    primarySelectDescriptorId: "reasoningEffort",
    ultrathinkPromptControlled: ultrathink,
  });

describe("buildTraitsTriggerDisplay", () => {
  test("prompt-controlled ultrathink is labelled as such and still shows the bolt", () => {
    expect(trigger([effort, fast(true)], true)).toEqual({
      label: "Ultrathink",
      showFastModeIcon: true,
    });
  });

  test("selects join with ' · '; fast mode on swaps its text for the bolt, off just disappears", () => {
    expect(trigger([effort, fast(true), context1m])).toEqual({
      label: "High · 1M",
      showFastModeIcon: true,
    });
    expect(trigger([effort, fast(false), context1m])).toEqual({
      label: "High · 1M",
      showFastModeIcon: false,
    });
  });

  test("fast mode as the only trait is spelled out", () => {
    expect(trigger([fast(true)])).toEqual({ label: "Fast", showFastModeIcon: false });
    expect(trigger([fast(false)])).toEqual({ label: "Normal", showFastModeIcon: false });
  });

  test("other booleans stay as text", () => {
    expect(trigger([effort, toggle("thinking", "Thinking", true)])).toEqual({
      label: "High · Thinking On",
      showFastModeIcon: false,
    });
  });

  test("an unresolved select yields a blank label rather than a made-up 'Normal'", () => {
    const unresolved = select("effort", undefined, [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ]);
    expect(trigger([unresolved])).toEqual({ label: "", showFastModeIcon: false });
  });

  test.each([
    ["default", "Standard"],
    ["priority", "Fast"],
  ] as const)("the Codex service tier %s alone reads %s", (current, label) => {
    expect(trigger([tier(current)])).toEqual({ label, showFastModeIcon: false });
  });

  test("with other traits, standard hides, fast becomes the bolt, and flex stays in the text", () => {
    expect(trigger([effort, tier("default")])).toEqual({ label: "High", showFastModeIcon: false });
    expect(trigger([effort, tier("priority")])).toEqual({ label: "High", showFastModeIcon: true });
    expect(trigger([effort, tier("flex")])).toEqual({
      label: "High · Flex",
      showFastModeIcon: false,
    });
  });
});

describe("buildUnavailableModelOptionDescriptors", () => {
  test("rebuilds only the saved values, with no alternatives to pick from", () => {
    expect(
      buildUnavailableModelOptionDescriptors([
        { id: "fastMode", value: true },
        { id: "agent", value: "build" },
        { id: "variant", value: "max" },
      ]),
    ).toEqual([
      { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue: true },
      {
        id: "agent",
        label: "Agent",
        type: "select",
        currentValue: "build",
        options: [{ id: "build", label: "build" }],
      },
      {
        id: "variant",
        label: "Reasoning",
        type: "select",
        currentValue: "max",
        options: [{ id: "max", label: "max" }],
      },
    ]);
  });
});
