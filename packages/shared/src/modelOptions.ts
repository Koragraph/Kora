import {
  MODEL_SLUG_ALIASES_BY_AGENT,
  ModelCapabilities,
  type AgentId,
  type AgentOptionDescriptor,
  type AgentOptionSelection,
  type AgentProfileId,
  type CustomModelSpec,
  type ModelPick,
} from "@kora/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface SelectableModelOption {
  readonly slug: string;
  readonly name: string;
  readonly aliases?: ReadonlyArray<string> | undefined;
}

export interface CustomModelDefinition {
  readonly capabilities: ModelCapabilities | null;
  readonly name: string;
  readonly slug: string;
}

const decodeCapabilities = Schema.decodeUnknownOption(ModelCapabilities);

// ---------------------------------------------------------------------------
// Option descriptors
// ---------------------------------------------------------------------------

const cloneDescriptor = (descriptor: AgentOptionDescriptor): AgentOptionDescriptor =>
  descriptor.type === "select"
    ? {
        ...descriptor,
        options: descriptor.options.map((option) => ({ ...option })),
        ...(descriptor.promptInjectedValues !== undefined
          ? { promptInjectedValues: [...descriptor.promptInjectedValues] }
          : {}),
      }
    : { ...descriptor };

export function createModelCapabilities(input: {
  readonly optionDescriptors: ReadonlyArray<AgentOptionDescriptor>;
}): ModelCapabilities {
  return { optionDescriptors: input.optionDescriptors.map(cloneDescriptor) };
}

type SelectDescriptor = Extract<AgentOptionDescriptor, { readonly type: "select" }>;

const defaultChoice = (descriptor: SelectDescriptor): string | undefined =>
  descriptor.options.find((option) => option.isDefault === true)?.id;

/** Turn a raw selection into the value that should actually be stored for this select. */
const resolveChoice = (descriptor: SelectDescriptor, raw: string): string | undefined => {
  const value = raw.trim();
  if (value.length === 0) return descriptor.currentValue ?? defaultChoice(descriptor);
  if (descriptor.options.length === 0) return value;
  const known = descriptor.options.some((option) => option.id === value);
  // Prompt-injected values (ultrathink) are words in the prompt, never a real setting.
  if (known && descriptor.promptInjectedValues?.includes(value) === true) {
    return defaultChoice(descriptor);
  }
  if (known) return value;
  return descriptor.currentValue ?? defaultChoice(descriptor);
};

export function getAgentOptionDescriptors(input: {
  readonly caps: ModelCapabilities;
  readonly selections?: ReadonlyArray<AgentOptionSelection> | null | undefined;
}): ReadonlyArray<AgentOptionDescriptor> {
  const selections = input.selections ?? [];
  return (input.caps.optionDescriptors ?? []).map((source) => {
    const descriptor = cloneDescriptor(source);
    const chosen = selections.find((selection) => selection.id === descriptor.id)?.value;
    const raw = chosen ?? descriptor.currentValue;

    let resolved: string | boolean | undefined;
    if (descriptor.type === "boolean") {
      resolved = typeof raw === "boolean" ? raw : descriptor.currentValue;
    } else {
      // A non-string selection (a boolean aimed at a select) falls back to the current value.
      resolved = resolveChoice(
        descriptor,
        typeof raw === "string" ? raw : (descriptor.currentValue ?? ""),
      );
    }

    const { currentValue: _dropped, ...rest } = descriptor;
    return (
      resolved === undefined || resolved === "" ? rest : { ...rest, currentValue: resolved }
    ) as AgentOptionDescriptor;
  });
}

export function getAgentOptionCurrentValue(
  descriptor: AgentOptionDescriptor | null | undefined,
): string | boolean | undefined {
  if (!descriptor) return undefined;
  return descriptor.type === "boolean"
    ? descriptor.currentValue
    : (descriptor.currentValue ?? defaultChoice(descriptor));
}

export function getAgentOptionCurrentLabel(
  descriptor: AgentOptionDescriptor | null | undefined,
): string | undefined {
  if (!descriptor) return undefined;
  if (descriptor.type === "boolean") {
    return descriptor.currentValue === undefined
      ? undefined
      : descriptor.currentValue
        ? "On"
        : "Off";
  }
  const current = getAgentOptionCurrentValue(descriptor);
  return descriptor.options.find((option) => option.id === current)?.label;
}

const selectionsFrom = (
  descriptors: ReadonlyArray<AgentOptionDescriptor>,
  keep: (id: string) => boolean,
): AgentOptionSelection[] | undefined => {
  const out: AgentOptionSelection[] = [];
  for (const descriptor of descriptors) {
    if (!keep(descriptor.id)) continue;
    const value = getAgentOptionCurrentValue(descriptor);
    if (value !== undefined) out.push({ id: descriptor.id, value } as AgentOptionSelection);
  }
  return out.length > 0 ? out : undefined;
};

export function buildAgentOptionSelectionsFromDescriptors(
  descriptors: ReadonlyArray<AgentOptionDescriptor> | null | undefined,
): AgentOptionSelection[] | undefined {
  return descriptors ? selectionsFrom(descriptors, () => true) : undefined;
}

/** Like the above, but only for options the user actually chose. */
export function buildExplicitAgentOptionSelectionsFromDescriptors(
  descriptors: ReadonlyArray<AgentOptionDescriptor> | null | undefined,
  selections: ReadonlyArray<AgentOptionSelection> | null | undefined,
): AgentOptionSelection[] | undefined {
  if (!descriptors || !selections || selections.length === 0) return undefined;
  const chosen = new Set(selections.map((selection) => selection.id));
  return selectionsFrom(descriptors, (id) => chosen.has(id));
}

// ---------------------------------------------------------------------------
// Slugs and custom models
// ---------------------------------------------------------------------------

const ULTRATHINK = /\bultrathink\b/i;

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && ULTRATHINK.test(text);
}

export function canonicalCustomModelSlug(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function canonicalModelSlug(
  model: string | null | undefined,
  provider: AgentId = "codex" as AgentId,
): string | null {
  const trimmed = canonicalCustomModelSlug(model);
  if (trimmed === null) return null;
  const aliases = MODEL_SLUG_ALIASES_BY_AGENT[provider];
  return aliases !== undefined && Object.hasOwn(aliases, trimmed) ? aliases[trimmed]! : trimmed;
}

/** Read the stored custom models; a bad row degrades (or is skipped), it never throws. */
export function readCustomModelEntries(value: unknown): CustomModelDefinition[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: CustomModelDefinition[] = [];
  for (const row of value as ReadonlyArray<unknown>) {
    let slug: string | null = null;
    let name: string | null = null;
    let capabilities: ModelCapabilities | null = null;
    if (typeof row === "string") {
      slug = canonicalCustomModelSlug(row);
    } else if (typeof row === "object" && row !== null) {
      const record = row as { slug?: unknown; name?: unknown; capabilities?: unknown };
      slug = canonicalCustomModelSlug(typeof record.slug === "string" ? record.slug : null);
      name = typeof record.name === "string" ? canonicalCustomModelSlug(record.name) : null;
      if (record.capabilities !== undefined && record.capabilities !== null) {
        const decoded = decodeCapabilities(record.capabilities);
        // Unusable capabilities are dropped without failing the row.
        capabilities = Option.isSome(decoded)
          ? createModelCapabilities({ optionDescriptors: decoded.value.optionDescriptors ?? [] })
          : null;
      }
    }
    if (slug === null || seen.has(slug)) continue;
    seen.add(slug);
    entries.push({ slug, name: name ?? slug, capabilities });
  }
  return entries;
}

export function toCustomModelSetting(entry: CustomModelDefinition): CustomModelSpec {
  const descriptors = entry.capabilities?.optionDescriptors ?? [];
  if (entry.name === entry.slug && descriptors.length === 0) return entry.slug as CustomModelSpec;
  return {
    slug: entry.slug,
    ...(entry.name !== entry.slug ? { name: entry.name } : {}),
    ...(descriptors.length > 0 ? { capabilities: entry.capabilities! } : {}),
  } as CustomModelSpec;
}

type OptionalText = string | null | undefined;

export function resolveSelectableModel(
  provider: AgentId,
  value: OptionalText,
  options: readonly SelectableModelOption[],
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const lowered = trimmed.toLowerCase();

  const bySlug = options.find((option) => option.slug === trimmed);
  if (bySlug) return bySlug.slug;
  const byName = options.find((option) => option.name.toLowerCase() === lowered);
  if (byName) return byName.slug;
  const byAlias = options.find((option) =>
    option.aliases?.some((alias) => alias.toLowerCase() === lowered),
  );
  if (byAlias) return byAlias.slug;

  const canonical = canonicalModelSlug(trimmed, provider);
  return options.find((option) => option.slug === canonical)?.slug ?? null;
}

export function createModelPick(
  instanceId: AgentProfileId,
  model: string,
  options?: ReadonlyArray<AgentOptionSelection> | null,
): ModelPick {
  return {
    instanceId,
    model,
    ...(options && options.length > 0 ? { options: options.map((option) => ({ ...option })) } : {}),
  } as ModelPick;
}

// ---------------------------------------------------------------------------
// Claude "ultrathink"
// ---------------------------------------------------------------------------

/** The effort word that rides in the prompt rather than as a setting, if the model has one. */
export function resolvePromptInjectedEffort(
  caps: ModelCapabilities,
  rawEffort: OptionalText,
): string | null {
  const effort = (rawEffort ?? "").trim();
  if (!effort) return null;
  for (const descriptor of caps.optionDescriptors ?? []) {
    if (descriptor.type === "select" && descriptor.promptInjectedValues?.includes(effort)) {
      return effort;
    }
  }
  return null;
}

// `/name` or `/plugin:name` followed by space or the end is a slash command; `/home/ada/app.ts` is a path.
const STARTS_WITH_SLASH_COMMAND = /^\/[^\s/]+(?:\s|$)/;

export function prefixClaudeEffort(text: string, effort: OptionalText): string {
  const body = text.trim();
  if (effort !== "ultrathink") return body;
  // A prefixed slash command would no longer run.
  const leaveAlone =
    body === "" || body.startsWith("Ultrathink:") || STARTS_WITH_SLASH_COMMAND.test(body);
  return leaveAlone ? body : "Ultrathink:\n" + body;
}
