import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { NonblankString } from "./primitives.ts";
import { AgentId } from "./agentProfile.ts";

export const AgentOptionDescriptorType = Schema.Literals(["select", "boolean"]);
export type AgentOptionDescriptorType = Schema.Schema.Type<typeof AgentOptionDescriptorType>;

export const AgentOptionChoice = Schema.Struct({
  id: NonblankString,
  label: NonblankString,
  description: Schema.optionalKey(NonblankString),
  isDefault: Schema.optionalKey(Schema.Boolean),
});
export type AgentOptionChoice = Schema.Schema.Type<typeof AgentOptionChoice>;

export const SelectAgentOptionDescriptor = Schema.Struct({
  id: NonblankString,
  label: NonblankString,
  description: Schema.optionalKey(NonblankString),
  type: Schema.Literal("select"),
  options: Schema.Array(AgentOptionChoice),
  currentValue: Schema.optionalKey(NonblankString),
  promptInjectedValues: Schema.optionalKey(Schema.Array(NonblankString)),
});
export type SelectAgentOptionDescriptor = Schema.Schema.Type<typeof SelectAgentOptionDescriptor>;

export const BooleanAgentOptionDescriptor = Schema.Struct({
  id: NonblankString,
  label: NonblankString,
  description: Schema.optionalKey(NonblankString),
  type: Schema.Literal("boolean"),
  currentValue: Schema.optionalKey(Schema.Boolean),
});
export type BooleanAgentOptionDescriptor = Schema.Schema.Type<typeof BooleanAgentOptionDescriptor>;

export const AgentOptionDescriptor = Schema.Union([
  SelectAgentOptionDescriptor,
  BooleanAgentOptionDescriptor,
]);
export type AgentOptionDescriptor = Schema.Schema.Type<typeof AgentOptionDescriptor>;

export const AgentOptionSelectionValue = Schema.Union([NonblankString, Schema.Boolean]);
export type AgentOptionSelectionValue = Schema.Schema.Type<typeof AgentOptionSelectionValue>;

export const AgentOptionSelection = Schema.Struct({
  id: NonblankString,
  value: AgentOptionSelectionValue,
});
export type AgentOptionSelection = Schema.Schema.Type<typeof AgentOptionSelection>;

/** `{effort: "max", fastMode: true}` -> `[{id, value}, ...]`; blanks and non-scalar values are dropped. */
const selectionsFromLegacyRecord = (
  record: Readonly<Record<string, unknown>>,
): ReadonlyArray<AgentOptionSelection> => {
  const selections: Array<AgentOptionSelection> = [];
  for (const [rawKey, raw] of Object.entries(record)) {
    const id = rawKey.trim();
    if (id.length === 0) continue;
    if (typeof raw === "boolean") {
      selections.push({ id, value: raw });
    } else if (typeof raw === "string") {
      const value = raw.trim();
      if (value.length > 0) selections.push({ id, value });
    }
  }
  return selections;
};

const selectionsToLegacyRecord = (
  selections: ReadonlyArray<AgentOptionSelection>,
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(selections.map(({ id, value }) => [id, value]));

const LegacySelectionRecord = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Array(AgentOptionSelection),
    SchemaTransformation.transform({
      decode: selectionsFromLegacyRecord,
      encode: selectionsToLegacyRecord,
    }),
  ),
);

/**
 * Selections as an array. The legacy object form still decodes (old settings
 * files, un-migrated rows) but always re-encodes as the array, so storage heals
 * on the next write.
 */
export const AgentOptionSelections = Schema.Union([
  Schema.Array(AgentOptionSelection),
  LegacySelectionRecord,
]);
export type AgentOptionSelections = Schema.Schema.Type<typeof AgentOptionSelections>;

export const ModelCapabilities = Schema.Struct({
  optionDescriptors: Schema.optionalKey(Schema.Array(AgentOptionDescriptor)),
});
export type ModelCapabilities = Schema.Schema.Type<typeof ModelCapabilities>;

export const CustomModelEntry = Schema.Struct({
  slug: NonblankString,
  name: Schema.optionalKey(NonblankString),
  capabilities: Schema.optionalKey(ModelCapabilities),
});
export type CustomModelEntry = Schema.Schema.Type<typeof CustomModelEntry>;

/** A bare slug (legacy) or a full entry. */
export const CustomModelSpec = Schema.Union([NonblankString, CustomModelEntry]);
export type CustomModelSpec = Schema.Schema.Type<typeof CustomModelSpec>;

/** The Codex model new threads start on. */
const CODEX_FLAGSHIP = "gpt-6-astra";
export const DEFAULT_MODEL = CODEX_FLAGSHIP;
/** Keep the official Antigravity session's current model; never sent to ACP. */
export const ANTIGRAVITY_DEFAULT_MODEL = "antigravity-default";

// Side calls (titles, commit messages) run on the cheap model at low effort.
export const DEFAULT_TEXT_GENERATION_REASONING_EFFORT = "low";
export const DEFAULT_TEXT_GENERATION_MODEL = "gpt-5.6-luna";

const defaultModelPairs: ReadonlyArray<readonly [agent: string, model: string]> = [
  ["codex", CODEX_FLAGSHIP],
  // The fallback when the model catalog is empty or the pick is unselectable: the newest Sonnet that is not a 1M variant,
  // the same family the picker prefers for a new thread (apps/web agentProfiles.ts). Never the account's most expensive model.
  ["claude", "claude-sonnet-5-5"],
  ["cursor", "auto"],
  // A product slug rather than an ACP model id; the adapter reads it as "the session's current model".
  ["grok", "grok-build"],
  ["opencode", "openai/gpt-5"],
  ["antigravity", ANTIGRAVITY_DEFAULT_MODEL],
];

export const DEFAULT_MODEL_BY_AGENT: Partial<Record<AgentId, string>> = Object.fromEntries(
  defaultModelPairs.map(([agent, model]) => [AgentId.make(agent), model]),
);

export const MODEL_SLUG_ALIASES_BY_AGENT: Partial<Record<AgentId, Record<string, string>>> = {
  [AgentId.make("codex")]: {
    ...{ "5.4": "gpt-5.4", "gpt-5-codex": "gpt-5.4" },
    ...{ "gpt-5.3": "gpt-5.3-codex", "5.3": "gpt-5.3-codex" },
    ...{ "gpt-5.3-spark": "gpt-5.3-codex-spark", "5.3-spark": "gpt-5.3-codex-spark" },
  },
  [AgentId.make("claude")]: {},
  [AgentId.make("cursor")]: {
    ...{ "composer-1": "composer-1.5", "composer-1.5": "composer-1.5", composer: "composer-2" },
    ...{ "opus-4.6": "claude-opus-4-6", "opus-4.6-thinking": "claude-opus-4-6" },
    ...{ "sonnet-4.6": "claude-sonnet-4-6", "sonnet-4.6-thinking": "claude-sonnet-4-6" },
    ...{ "opus-4.5": "claude-opus-4-5", "opus-4.5-thinking": "claude-opus-4-5" },
  },
  [AgentId.make("opencode")]: {},
};

export const AGENT_DISPLAY_NAMES: Partial<Record<AgentId, string>> = {
  [AgentId.make("antigravity")]: "Antigravity",
  [AgentId.make("codex")]: "Codex",
  [AgentId.make("claude")]: "Claude",
  [AgentId.make("cursor")]: "Cursor",
  [AgentId.make("grok")]: "Grok",
  [AgentId.make("opencode")]: "OpenCode",
};
