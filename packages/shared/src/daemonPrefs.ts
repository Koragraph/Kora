import {
  DaemonPrefs,
  isAgentId,
  resolveAgentProfileEnabled,
  type BackgroundActivityPrefs,
  type DaemonPrefsPatch,
  type ModelPick,
  type ProjectPrefsOverrides,
} from "@kora/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  normalizeBackgroundActivityPrefs,
  normalizeDaemonBackgroundActivityPrefs,
  resolveBackgroundActivityPrefs,
} from "./backgroundActivityPrefs.ts";
import { createModelPick } from "./modelOptions.ts";
import { parseLenientJson } from "./lenientJson.ts";
import { deepMerge } from "./deepMerge.ts";

type Entries = Record<string, unknown>;

/** Whether the model pick's agent is switched on. Instances decide for themselves; bare agent ids use the legacy flag. */
export function isModelPickAgentEnabled(settings: DaemonPrefs, selection: ModelPick): boolean {
  const instance = settings.providerInstances[selection.instanceId];
  if (instance !== undefined) return resolveAgentProfileEnabled(instance);
  if (!isAgentId(selection.instanceId)) return false;
  const legacy = (settings.providers as Record<string, { enabled?: boolean } | undefined>)[
    selection.instanceId
  ];
  return legacy?.enabled === true;
}

export interface PersistedDaemonTracingPrefs {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

const decodePersistedPrefs = Schema.decodeUnknownOption(parseLenientJson(DaemonPrefs));

const nonBlank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** The OTLP URLs from the raw settings file, for tracing that starts before the server proper. */
export function parsePersistedDaemonTracingPrefs(raw: string): PersistedDaemonTracingPrefs {
  const decoded = decodePersistedPrefs(raw);
  if (Option.isNone(decoded)) return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  return {
    otlpTracesUrl: nonBlank(decoded.value.observability.otlpTracesUrl),
    otlpMetricsUrl: nonBlank(decoded.value.observability.otlpMetricsUrl),
  };
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

// Older clients still send per-project maps; each maps onto one key of the project's override entry.
const LEGACY_PROJECT_PATCH_KEYS = [
  ["projectAgentBrowserAccessOverrides", "enableAgentBrowserAccess"],
  ["projectAutoPullOverrides", "defaultAutoPull"],
  ["projectScriptOverrides", "defaultProjectScripts"],
] as const;

// Handled by hand below instead of by the generic deep merge.
const HANDLED_PATCH_KEYS = new Set([
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "backgroundActivityProfile",
  "backgroundActivity",
  "usageLimitSources",
  "usagePriceOverrides",
  "projectSettingsOverrides",
  "textGenerationModelSelection",
  "providerInstances",
  "defaultModelSelection",
  "defaultProjectScripts",
  "sourceControlWriterModelSelection",
]);

// Replaced as a whole when present: a deep merge would keep keys the client meant to drop.
const REPLACED_WHOLE_KEYS = [
  "providerInstances",
  "defaultModelSelection",
  "defaultProjectScripts",
  "sourceControlWriterModelSelection",
] as const;

const hasOwn = (target: object, key: string): boolean => Object.hasOwn(target, key);

/** Fold the legacy per-project maps of a patch into canonical `projectSettingsOverrides` entries. */
const canonicalProjectOverrides = (
  current: DaemonPrefs,
  patch: Entries,
): Record<string, ProjectPrefsOverrides | null> => {
  const canonical = (patch.projectSettingsOverrides ?? {}) as Record<
    string,
    ProjectPrefsOverrides | null
  >;
  const merged: Record<string, ProjectPrefsOverrides | null> = { ...canonical };
  const translated = new Map<string, Entries>();

  for (const [legacyKey, overrideKey] of LEGACY_PROJECT_PATCH_KEYS) {
    const legacy = patch[legacyKey] as Record<string, unknown> | undefined;
    if (legacy === undefined) continue;
    for (const [projectId, value] of Object.entries(legacy)) {
      if (hasOwn(canonical, projectId)) continue; // the canonical entry wins
      const entry: Entries = translated.get(projectId) ?? {
        ...((current.projectSettingsOverrides as Record<string, Entries>)[projectId] ?? {}),
      };
      if (value === null) delete entry[overrideKey];
      else entry[overrideKey] = value;
      translated.set(projectId, entry);
    }
  }
  for (const [projectId, entry] of translated) {
    merged[projectId] = Object.keys(entry).length === 0 ? null : (entry as ProjectPrefsOverrides);
  }
  return merged;
};

/** Per-id upsert; `null` removes the id; ids the patch omits are untouched. */
const upsertById = <T>(
  current: Readonly<Record<string, T>>,
  patch: Readonly<Record<string, T | null>> | undefined,
): Record<string, T> => {
  const next: Record<string, T> = { ...current };
  for (const [id, value] of Object.entries(patch ?? {})) {
    if (value === null) delete next[id];
    else next[id] = value;
  }
  return next;
};

const backgroundActivityFrom = (current: DaemonPrefs, patch: Entries): BackgroundActivityPrefs => {
  const base = normalizeDaemonBackgroundActivityPrefs(current);
  const structured = patch.backgroundActivity as
    | (Partial<BackgroundActivityPrefs> & { overrides?: unknown })
    | undefined;
  if (structured !== undefined) {
    const merged = deepMerge(
      base as unknown as Record<string, unknown>,
      structured as never,
    ) as unknown as BackgroundActivityPrefs;
    // Overrides are a complete record, not a merge.
    return structured.overrides === undefined
      ? merged
      : ({ ...merged, overrides: structured.overrides } as BackgroundActivityPrefs);
  }

  const profile = patch.backgroundActivityProfile as BackgroundActivityPrefs["profile"] | undefined;
  const intervals: Entries = {};
  if (patch.automaticGitFetchInterval !== undefined) {
    intervals.automaticGitFetchInterval = patch.automaticGitFetchInterval;
  }
  if (patch.providerHealthRefreshInterval !== undefined) {
    intervals.providerHealthRefreshInterval = patch.providerHealthRefreshInterval;
  }
  const hasIntervals = Object.keys(intervals).length > 0;

  if (profile !== undefined) {
    return hasIntervals
      ? ({
          overrides: intervals,
          baseProfile: profile,
          profile: "custom",
          schemaVersion: 1,
        } as BackgroundActivityPrefs)
      : { schemaVersion: 1, profile, overrides: {} };
  }
  if (hasIntervals) {
    const baseProfile = resolveBackgroundActivityPrefs(base).profile;
    return {
      overrides: { ...(base.profile === "custom" ? base.overrides : {}), ...intervals },
      baseProfile,
      profile: "custom",
      schemaVersion: 1,
    } as BackgroundActivityPrefs;
  }
  return base;
};

const textGenerationSelectionFrom = (current: ModelPick, patch: Entries): ModelPick => {
  const instanceId =
    (patch.instanceId as ModelPick["instanceId"] | undefined) ?? current.instanceId;
  const model = (patch.model as string | undefined) ?? current.model;
  const patched = patch.options as ModelPick["options"] | undefined;

  if (patch.instanceId !== undefined || patch.model !== undefined) {
    return createModelPick(instanceId, model, patched);
  }
  if (patched === undefined) return createModelPick(instanceId, model, current.options);
  if (patched.length === 0) return createModelPick(instanceId, model, undefined);

  // Same model: merge by option id, patch values winning.
  const merged = new Map((current.options ?? []).map((option) => [option.id, option] as const));
  for (const option of patched) merged.set(option.id, option);
  return createModelPick(instanceId, model, [...merged.values()]);
};

const legacyProjectMaps = (overrides: Readonly<Record<string, ProjectPrefsOverrides>>): Entries => {
  const derived: Entries = {};
  for (const [legacyKey, overrideKey] of LEGACY_PROJECT_PATCH_KEYS) {
    const view: Entries = {};
    for (const [projectId, entry] of Object.entries(overrides)) {
      if (hasOwn(entry, overrideKey)) view[projectId] = (entry as Entries)[overrideKey];
    }
    derived[legacyKey] = view;
  }
  return derived;
};

export function applyDaemonPrefsPatch(
  current: DaemonPrefs,
  rawPatch: DaemonPrefsPatch,
): DaemonPrefs {
  const patch = rawPatch as Entries;
  const overridesPatch = canonicalProjectOverrides(current, patch);

  const rest: Entries = {};
  for (const [key, value] of Object.entries(patch)) {
    if (HANDLED_PATCH_KEYS.has(key)) continue;
    if (LEGACY_PROJECT_PATCH_KEYS.some(([legacyKey]) => legacyKey === key)) continue;
    rest[key] = value;
  }

  const next = deepMerge(current as unknown as Entries, rest as never) as Entries;

  for (const key of REPLACED_WHOLE_KEYS) {
    if (hasOwn(patch, key) && patch[key] !== undefined) next[key] = patch[key];
  }

  if (patch.textGenerationModelSelection !== undefined) {
    next.textGenerationModelSelection = textGenerationSelectionFrom(
      current.textGenerationModelSelection,
      patch.textGenerationModelSelection as Entries,
    );
  }

  // Whole entries replace; a null removes; an entry left with no keys is dropped.
  const projectOverrides = upsertById(
    current.projectSettingsOverrides as Record<string, ProjectPrefsOverrides>,
    overridesPatch,
  );
  for (const projectId of Object.keys(overridesPatch)) {
    const entry = projectOverrides[projectId];
    if (entry !== undefined && Object.keys(entry).length === 0) delete projectOverrides[projectId];
  }
  next.projectSettingsOverrides = projectOverrides;
  Object.assign(next, legacyProjectMaps(projectOverrides));

  if (patch.usageLimitSources !== undefined) {
    next.usageLimitSources = upsertById(
      current.usageLimitSources,
      patch.usageLimitSources as Record<string, never>,
    );
  }
  if (patch.usagePriceOverrides !== undefined) {
    next.usagePriceOverrides = upsertById(
      current.usagePriceOverrides,
      patch.usagePriceOverrides as Record<string, never>,
    );
  }

  const background = normalizeBackgroundActivityPrefs(backgroundActivityFrom(current, patch));
  next.backgroundActivity = background;
  const resolved = resolveBackgroundActivityPrefs(background);
  next.automaticGitFetchInterval = resolved.automaticGitFetchInterval;
  next.providerHealthRefreshInterval = resolved.providerHealthRefreshInterval;
  next.backgroundActivityProfile = resolved.profile;

  return next as unknown as DaemonPrefs;
}
