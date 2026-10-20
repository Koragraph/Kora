import { createModelCapabilities, type CustomModelDefinition } from "@kora/shared/modelOptions";
import type { AgentOptionDescriptor, ModelCapabilities, AgentId } from "@kora/contracts";

export interface EditorChoice {
  readonly key: string;
  id: string;
  label: string;
  isDefault: boolean;
  description?: string;
}

export interface EditorDescriptor {
  readonly key: string;
  type: "select" | "boolean";
  id: string;
  label: string;
  choices: ReadonlyArray<EditorChoice>;
  currentBooleanValue?: boolean | undefined;
  description?: string | undefined;
}

export interface CustomModelDraft {
  slug: string;
  name: string;
  descriptors: ReadonlyArray<EditorDescriptor>;
}

export interface DescriptorPreset {
  id: string;
  label: string;
  type: "select" | "boolean";
  choices?: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>;
}

// Keys only exist so React can tell rows apart while they are edited.
let keySeed = 0;
const nextKey = () => `k${++keySeed}`;

type PresetChoice = { id: string; label: string; isDefault?: boolean };

const presetChoice = (id: string, label: string, isDefault = false): PresetChoice =>
  isDefault ? { id, label, isDefault } : { id, label };
const selectPreset = (
  id: string,
  label: string,
  choices: ReadonlyArray<PresetChoice>,
): DescriptorPreset => ({ id, label, type: "select", choices });
const togglePreset = (id: string, label: string): DescriptorPreset => ({
  id,
  label,
  type: "boolean",
});

const EFFORT_CHOICES: ReadonlyArray<PresetChoice> = [
  presetChoice("low", "Low"),
  presetChoice("medium", "Medium", true),
  presetChoice("high", "High"),
  presetChoice("xhigh", "Extra High"),
];

// The ids below are the ones the drivers actually read; anything else a user types is stored but ignored.
export const DESCRIPTOR_PRESETS_BY_KIND: Partial<Record<AgentId, ReadonlyArray<DescriptorPreset>>> =
  {
    opencode: [
      selectPreset("variant", "Reasoning", EFFORT_CHOICES),
      selectPreset("agent", "Agent", [
        presetChoice("build", "Build", true),
        presetChoice("plan", "Plan"),
      ]),
    ],
    grok: [selectPreset("reasoningEffort", "Reasoning", EFFORT_CHOICES)],
    cursor: [
      selectPreset("reasoning", "Reasoning", EFFORT_CHOICES),
      togglePreset("fastMode", "Fast Mode"),
      togglePreset("thinking", "Thinking"),
    ],
    claude: [
      selectPreset("effort", "Reasoning", [
        presetChoice("low", "Low"),
        presetChoice("medium", "Medium"),
        presetChoice("high", "High", true),
        presetChoice("xhigh", "Extra High"),
        presetChoice("max", "Max"),
      ]),
      togglePreset("fastMode", "Fast Mode"),
      togglePreset("thinking", "Thinking"),
    ],
    codex: [
      selectPreset("reasoningEffort", "Reasoning", EFFORT_CHOICES),
      selectPreset("serviceTier", "Speed", [
        presetChoice("default", "Standard", true),
        presetChoice("fast", "Fast"),
      ]),
    ],
  } as Partial<Record<AgentId, ReadonlyArray<DescriptorPreset>>>;

function choiceFromPreset(choice: {
  isDefault?: boolean;
  label: string;
  id: string;
}): EditorChoice {
  return { key: nextKey(), id: choice.id, label: choice.label, isDefault: !!choice.isDefault };
}

export function descriptorFromPreset(preset: DescriptorPreset): EditorDescriptor {
  return {
    key: nextKey(),
    choices: (preset.choices ?? []).map(choiceFromPreset),
    label: preset.label,
    id: preset.id,
    type: preset.type,
  };
}

export const emptyEditorDescriptor = (): EditorDescriptor => ({
  key: nextKey(),
  type: "select",
  id: "",
  label: "",
  choices: [],
});

export const emptyEditorChoice = (): EditorChoice => ({
  key: nextKey(),
  id: "",
  label: "",
  isDefault: false,
});

function editorDescriptorFrom(descriptor: AgentOptionDescriptor): EditorDescriptor {
  if (descriptor.type === "boolean") {
    return {
      key: nextKey(),
      type: "boolean",
      id: descriptor.id,
      label: descriptor.label,
      choices: [],
      ...(descriptor.currentValue !== undefined
        ? { currentBooleanValue: descriptor.currentValue }
        : {}),
      ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
    };
  }
  // Values the built-in profiles deliver as prompt text are meaningless for a custom entry.
  const injected = new Set(descriptor.promptInjectedValues ?? []);
  const options = descriptor.options.filter((option) => !injected.has(option.id));
  const defaultId =
    options.find((option) => option.id === descriptor.currentValue)?.id ??
    options.find((option) => option.isDefault)?.id;
  return {
    key: nextKey(),
    type: "select",
    id: descriptor.id,
    label: descriptor.label,
    choices: options.map((option) => ({
      key: nextKey(),
      id: option.id,
      label: option.label,
      isDefault: option.id === defaultId,
      ...(option.description !== undefined ? { description: option.description } : {}),
    })),
    ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
  };
}

export function draftFromDefinition(entry: CustomModelDefinition): CustomModelDraft {
  return {
    descriptors: (entry.capabilities?.optionDescriptors ?? []).map(editorDescriptorFrom),
    slug: entry.slug,
    name: entry.name === entry.slug ? "" : entry.name,
  };
}

export function descriptorsFromCapabilities(
  capabilities: ModelCapabilities | null | undefined,
  driverKind: AgentId | null,
): EditorDescriptor[] {
  return (
    (capabilities?.optionDescriptors ?? [])
      // Context choices need runtime suffix mappings that custom entries do not have.
      .filter((descriptor) => !(driverKind === "claude" && descriptor.id === "contextWindow"))
      .map(editorDescriptorFrom)
  );
}

export function validateDraft(draft: CustomModelDraft): string | null {
  const usedIds = new Set<string>();
  let position = 0;
  for (const descriptor of draft.descriptors) {
    position += 1;
    const label = `Option ${position}`;
    const id = descriptor.id.trim();
    if (id === "") return `${label} needs an id.`;
    if (usedIds.has(id)) return `${label}: id "${id}" is used twice.`;
    usedIds.add(id);
    if (descriptor.label.trim() === "") return `${label} needs a label.`;
    if (descriptor.type !== "select") continue;
    if (descriptor.choices.length === 0) return `${label} needs at least one choice.`;
    const usedChoices = new Set<string>();
    for (const choice of descriptor.choices) {
      const choiceId = choice.id.trim();
      if (choiceId === "") return `${label} has a choice without a value.`;
      if (usedChoices.has(choiceId)) return `${label}: choice "${choiceId}" is used twice.`;
      usedChoices.add(choiceId);
    }
  }
  return null;
}

function descriptorFromEditor(descriptor: EditorDescriptor): AgentOptionDescriptor {
  const label = descriptor.label.trim();
  const id = descriptor.id.trim();
  if (descriptor.type === "boolean") {
    return {
      type: "boolean",
      label,
      id,
      ...(descriptor.description ? { description: descriptor.description } : {}),
      ...(descriptor.currentBooleanValue !== undefined
        ? { currentValue: descriptor.currentBooleanValue }
        : {}),
    } as AgentOptionDescriptor;
  }
  const options = descriptor.choices.map((choice) => {
    const choiceId = choice.id.trim();
    return {
      id: choiceId,
      label: choice.label.trim() || choiceId,
      ...(choice.description ? { description: choice.description } : {}),
      ...(choice.isDefault ? { isDefault: true as const } : {}),
    };
  });
  const defaultOption = options.find((option) => "isDefault" in option);
  return {
    id,
    label,
    type: "select",
    options,
    ...(descriptor.description ? { description: descriptor.description } : {}),
    ...(defaultOption ? { currentValue: defaultOption.id } : {}),
  } as AgentOptionDescriptor;
}

export function definitionFromDraft(draft: CustomModelDraft): CustomModelDefinition {
  const optionDescriptors = draft.descriptors.map(descriptorFromEditor);
  return {
    slug: draft.slug,
    name: draft.name.trim() || draft.slug,
    capabilities:
      optionDescriptors.length > 0 ? createModelCapabilities({ optionDescriptors }) : null,
  };
}
