import { AgentId, type ModelCapabilities } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import * as EditorLogic from "./customModelEditor.logic";

const {
  validateDraft,
  definitionFromDraft,
  draftFromDefinition,
  descriptorFromPreset,
  descriptorsFromCapabilities,
  DESCRIPTOR_PRESETS_BY_KIND,
  emptyEditorChoice,
  emptyEditorDescriptor,
} = EditorLogic;

type CustomModelDraft = EditorLogic.CustomModelDraft;

function buildTestDraft(attrs: Partial<CustomModelDraft> = {}): CustomModelDraft {
  return {
    slug: "gpt-oss-preview",
    name: "GPT OSS Preview",
    descriptors: [],
    ...attrs,
  };
}

describe("customModelEditor logic", () => {
  describe("validateDraft", () => {
    it("reports an error when an option is missing an identifier", () => {
      const draft = buildTestDraft({
        descriptors: [
          {
            key: "opt-1",
            type: "select",
            id: "   ",
            label: "Reasoning Tier",
            choices: [{ key: "c1", id: "low", label: "Low", isDefault: true }],
          },
        ],
      });

      expect(validateDraft(draft)).toBe("Option 1 needs an id.");
    });

    it("detects duplicate option identifiers across descriptors", () => {
      const draft = buildTestDraft({
        descriptors: [
          {
            key: "opt-1",
            type: "boolean",
            id: "fastMode",
            label: "Fast Mode",
            choices: [],
          },
          {
            key: "opt-2",
            type: "boolean",
            id: "fastMode",
            label: "Fast Mode Copy",
            choices: [],
          },
        ],
      });

      expect(validateDraft(draft)).toBe('Option 2: id "fastMode" is used twice.');
    });

    it("requires each option to have a non-empty label", () => {
      const draft = buildTestDraft({
        descriptors: [
          {
            key: "opt-1",
            type: "boolean",
            id: "streamOutput",
            label: "   ",
            choices: [],
          },
        ],
      });

      expect(validateDraft(draft)).toBe("Option 1 needs a label.");
    });

    it("validates select options for empty choices, missing value, and duplicate choice keys", () => {
      const emptyChoicesDraft = buildTestDraft({
        descriptors: [
          {
            key: "opt-1",
            type: "select",
            id: "sampling",
            label: "Sampling",
            choices: [],
          },
        ],
      });
      expect(validateDraft(emptyChoicesDraft)).toBe("Option 1 needs at least one choice.");

      const blankChoiceValueDraft = buildTestDraft({
        descriptors: [
          {
            key: "opt-1",
            type: "select",
            id: "sampling",
            label: "Sampling",
            choices: [{ key: "c1", id: " ", label: "Default", isDefault: true }],
          },
        ],
      });
      expect(validateDraft(blankChoiceValueDraft)).toBe("Option 1 has a choice without a value.");

      const duplicateChoicesDraft = buildTestDraft({
        descriptors: [
          {
            key: "opt-1",
            type: "select",
            id: "sampling",
            label: "Sampling",
            choices: [
              { key: "c1", id: "greedy", label: "Greedy", isDefault: true },
              { key: "c2", id: "greedy", label: "Greedy Duplicate", isDefault: false },
            ],
          },
        ],
      });
      expect(validateDraft(duplicateChoicesDraft)).toBe('Option 1: choice "greedy" is used twice.');
    });

    it("accepts well-formed select and boolean options", () => {
      const validDraft = buildTestDraft({
        descriptors: [
          {
            key: "k1",
            type: "select",
            id: "temperature",
            label: "Temperature",
            choices: [
              { key: "c1", id: "precise", label: "Precise", isDefault: true },
              { key: "c2", id: "creative", label: "Creative", isDefault: false },
            ],
          },
          {
            key: "k2",
            type: "boolean",
            id: "stream",
            label: "Enable Streaming",
            choices: [],
          },
        ],
      });

      expect(validateDraft(validDraft)).toBeNull();
    });
  });

  describe("built-in agent presets", () => {
    it("verifies that all driver presets produce valid draft structures", () => {
      for (const [agentKind, presets] of Object.entries(DESCRIPTOR_PRESETS_BY_KIND)) {
        if (!presets) continue;
        const draft = buildTestDraft({
          name: `Preset for ${agentKind}`,
          descriptors: presets.map(descriptorFromPreset),
        });
        expect(validateDraft(draft)).toBeNull();
      }
    });

    it("constructs empty defaults properly", () => {
      const emptyDesc = emptyEditorDescriptor();
      expect(emptyDesc.type).toBe("select");
      expect(emptyDesc.id).toBe("");
      expect(emptyDesc.choices).toEqual([]);

      const emptyChoice = emptyEditorChoice();
      expect(emptyChoice.id).toBe("");
      expect(emptyChoice.isDefault).toBe(false);
    });
  });

  describe("conversion between draft and definition", () => {
    it("falls back to slug when name is empty or whitespace only", () => {
      const result = definitionFromDraft(buildTestDraft({ name: "   ", slug: "custom-llama" }));
      expect(result.name).toBe("custom-llama");
      expect(result.capabilities).toBeNull();
    });

    it("resets name to empty string when opening definition where name matches slug", () => {
      const draft = draftFromDefinition({
        slug: "deepseek-coder",
        name: "deepseek-coder",
        capabilities: null,
      });
      expect(draft.name).toBe("");
      expect(draft.descriptors).toHaveLength(0);
    });

    it("retains option and choice descriptions across draft transformations", () => {
      const originalCaps: ModelCapabilities = {
        optionDescriptors: [
          {
            type: "select",
            id: "reasoning",
            label: "Reasoning Depth",
            description: "Controls the internal CoT token budget",
            options: [
              { id: "std", label: "Standard", isDefault: true, description: "Normal mode" },
              { id: "deep", label: "Deep", description: "Extended exploration" },
            ],
          },
        ],
      };

      const imported = descriptorsFromCapabilities(originalCaps, AgentId.make("codex"));
      const savedDefinition = definitionFromDraft(buildTestDraft({ descriptors: imported }));
      const roundTrippedCaps = savedDefinition.capabilities?.optionDescriptors?.[0];
      const roundTrippedOptions =
        roundTrippedCaps?.type === "select" ? roundTrippedCaps.options : [];

      expect(roundTrippedCaps).toMatchObject({
        id: "reasoning",
        label: "Reasoning Depth",
        description: "Controls the internal CoT token budget",
      });
      expect(roundTrippedOptions[0]).toMatchObject({
        id: "std",
        label: "Standard",
        description: "Normal mode",
      });
      expect(roundTrippedOptions[1]).toMatchObject({
        id: "deep",
        label: "Deep",
        description: "Extended exploration",
      });
    });

    it.each([true, false, undefined])(
      "preserves boolean currentValue setting across cycle: %s",
      (booleanVal) => {
        const capabilities: ModelCapabilities = {
          optionDescriptors: [
            {
              id: "enableCache",
              label: "Prompt Cache",
              type: "boolean",
              ...(booleanVal !== undefined ? { currentValue: booleanVal } : {}),
            },
          ],
        };

        const descriptors = descriptorsFromCapabilities(capabilities, AgentId.make("grok"));
        const definition = definitionFromDraft(buildTestDraft({ descriptors }));
        expect(definition.capabilities).toEqual(capabilities);

        const reopenedDraft = draftFromDefinition(definition);
        const secondPass = definitionFromDraft({ ...reopenedDraft, name: "Updated Cache" });
        expect(secondPass.capabilities).toEqual(capabilities);
      },
    );
  });

  describe("descriptorsFromCapabilities filtering and behavior", () => {
    it("strips claude contextWindow options but keeps them for alternative providers", () => {
      const capabilities: ModelCapabilities = {
        optionDescriptors: [
          {
            type: "select",
            id: "contextWindow",
            label: "Context Window",
            options: [{ id: "200k", label: "200K Tokens", isDefault: true }],
          },
          {
            type: "boolean",
            id: "fastMode",
            label: "Fast Mode",
            currentValue: false,
          },
        ],
      };

      const claudeDescriptors = descriptorsFromCapabilities(capabilities, AgentId.make("claude"));
      expect(claudeDescriptors.map((d) => d.id)).toEqual(["fastMode"]);

      const cursorDescriptors = descriptorsFromCapabilities(capabilities, AgentId.make("cursor"));
      expect(cursorDescriptors.map((d) => d.id)).toEqual(["contextWindow", "fastMode"]);
    });

    it("filters out choices specified in promptInjectedValues", () => {
      const capabilities: ModelCapabilities = {
        optionDescriptors: [
          {
            type: "select",
            id: "speedTier",
            label: "Speed",
            promptInjectedValues: ["turbo-hidden"],
            options: [
              { id: "normal", label: "Normal", isDefault: true },
              { id: "turbo-hidden", label: "Turbo (Hidden)" },
            ],
          },
        ],
      };

      const [descriptor] = descriptorsFromCapabilities(capabilities, AgentId.make("opencode"));
      if (!descriptor) throw new Error("expected a descriptor");
      expect(descriptor.choices.map((c) => c.id)).toEqual(["normal"]);
    });

    it("designates the descriptor currentValue as default over the original isDefault flag", () => {
      const capabilities: ModelCapabilities = {
        optionDescriptors: [
          {
            type: "select",
            id: "latencyGoal",
            label: "Latency Goal",
            currentValue: "realtime",
            options: [
              { id: "batch", label: "Batch Mode", isDefault: true },
              { id: "realtime", label: "Real Time" },
            ],
          },
        ],
      };

      const [desc] = descriptorsFromCapabilities(capabilities, AgentId.make("claude"));
      if (!desc) throw new Error("expected a descriptor");
      const defaultChoice = desc.choices.find((c) => c.isDefault);
      expect(defaultChoice?.id).toBe("realtime");

      const compiled = definitionFromDraft(buildTestDraft({ descriptors: [desc] }));
      expect(compiled.capabilities?.optionDescriptors?.[0]).toMatchObject({
        currentValue: "realtime",
      });
    });

    it("completes full round-trip of mixed select and boolean descriptors", () => {
      const draft = buildTestDraft({
        name: "  Fine-Tuned Mistral  ",
        descriptors: [
          {
            key: "k1",
            type: "select",
            id: "samplingMethod",
            label: "Sampling",
            choices: [
              { key: "c1", id: "nucleus", label: "", isDefault: false },
              { key: "c2", id: "top-k", label: "Top-K", isDefault: true },
            ],
          },
          {
            key: "k2",
            type: "boolean",
            id: "speculative",
            label: "Speculative Decoding",
            choices: [],
          },
        ],
      });

      const compiled = definitionFromDraft(draft);
      expect(compiled.name).toBe("Fine-Tuned Mistral");
      expect(compiled.capabilities?.optionDescriptors).toEqual([
        {
          id: "samplingMethod",
          label: "Sampling",
          type: "select",
          currentValue: "top-k",
          options: [
            { id: "nucleus", label: "nucleus" },
            { id: "top-k", label: "Top-K", isDefault: true },
          ],
        },
        {
          id: "speculative",
          label: "Speculative Decoding",
          type: "boolean",
        },
      ]);

      const roundTripped = draftFromDefinition(compiled);
      expect(roundTripped.name).toBe("Fine-Tuned Mistral");
      expect(roundTripped.descriptors[0]?.choices.map((c) => c.isDefault)).toEqual([false, true]);
    });
  });
});
