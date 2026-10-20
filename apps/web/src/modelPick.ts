import {
  resolveSelectableModel,
  readCustomModelEntries,
  createModelPick,
  canonicalModelSlug,
} from "@kora/shared/modelOptions";
import type { UnifiedPrefs } from "@kora/contracts/clientPrefs";
import {
  type ModelPick,
  type DaemonPrefsPatch,
  type AgentStatus,
  type AgentProfileId,
  type AgentId,
  defaultProfileIdForDriver,
  ANTIGRAVITY_DEFAULT_MODEL,
} from "@kora/contracts";

import { sortModelsForAgentProfile } from "./modelSort";
import type { ModelEsque } from "./components/thread/agentIconUtils";
import { deriveAgentProfileEntries, type AgentProfileEntry } from "./agentProfiles";
import { getAgentModels, getDefaultDaemonModel, resolveSelectableAgent } from "./agentModels";

export const MAX_CUSTOM_MODEL_LENGTH = 256;
const MAX_CUSTOM_MODELS = 32;

export interface AppModelOption {
  isUnavailable?: boolean;
  isLegacy?: boolean;
  isDefault?: boolean;
  isCustom: boolean;
  badge?: "new";
  aliases?: ReadonlyArray<string>;
  subProvider?: string;
  shortName?: string;
  name: string;
  slug: string;
}

type CatalogModel = AgentStatus["models"][number];

/** Drivers whose catalogs are fetched live and can briefly lose the model a thread uses. */
const isDynamicCatalogDriver = (driver: AgentId) =>
  (driver as string) === "opencode" || (driver as string) === "antigravity";

function toBuiltInOption(model: CatalogModel): AppModelOption {
  return {
    name: model.name,
    slug: model.slug,
    ...(model.subProvider ? { subProvider: model.subProvider } : {}),
    ...(model.shortName ? { shortName: model.shortName } : {}),
    ...(model.aliases ? { aliases: model.aliases } : {}),
    ...(model.badge ? { badge: model.badge } : {}),
    isCustom: false,
    ...(model.isDefault ? { isDefault: true } : {}),
    ...(model.isLegacy ? { isLegacy: true } : {}),
  };
}

/** Settings are the source of truth for custom models; a legacy bucket only serves the default instance. */
function customModelSource(
  conf: UnifiedPrefs,
  driver: AgentId,
  instKey: AgentProfileId,
  isDefaultInstance: boolean,
): unknown {
  if ((driver as string) === "antigravity") return undefined;
  const own = (conf.providerInstances?.[instKey]?.config as { customModels?: unknown } | undefined)
    ?.customModels;
  if (Array.isArray(own)) return own;
  if (!isDefaultInstance) return undefined;
  return (conf.providers as Record<string, { customModels?: unknown } | undefined>)?.[driver]
    ?.customModels;
}

function buildOptions(args: {
  settings: UnifiedPrefs;
  driver: AgentId;
  instanceId: AgentProfileId;
  isDefaultInstance: boolean;
  rawModels: ReadonlyArray<CatalogModel>;
  selectedModel?: string | null | undefined;
}): AppModelOption[] {
  const { settings, driver, instanceId, rawModels } = args;
  const builtIns = rawModels.filter((model) => !model.isCustom).map(toBuiltInOption);
  const taken = new Set(builtIns.map((option) => option.slug));

  const custom: AppModelOption[] = [];
  for (const rec of readCustomModelEntries(
    customModelSource(settings, driver, instanceId, args.isDefaultInstance),
  )) {
    if (custom.length >= MAX_CUSTOM_MODELS) break;
    if (rec.slug.length > MAX_CUSTOM_MODEL_LENGTH || taken.has(rec.slug)) continue;
    taken.add(rec.slug);
    custom.push({ slug: rec.slug, name: rec.name, isCustom: true });
  }

  const prefsObj = settings.providerModelPreferences?.[instanceId];
  const hidden = new Set(prefsObj?.hiddenModels ?? []);
  const shown = [...builtIns, ...custom].filter((obj) => obj.isCustom || !hidden.has(obj.slug));
  const opts = sortModelsForAgentProfile(shown, { modelOrder: prefsObj?.modelOrder ?? [] });

  // A selected model the catalog no longer lists stays visible (unless the user hid it).
  if (isDynamicCatalogDriver(driver) && args.selectedModel) {
    const idSlug = canonicalModelSlug(args.selectedModel, driver);
    if (
      idSlug &&
      idSlug !== ANTIGRAVITY_DEFAULT_MODEL &&
      resolveSelectableModel(driver, idSlug, rawModels) === null &&
      !hidden.has(idSlug) &&
      !opts.some((obj) => obj.slug === idSlug)
    ) {
      opts.push({ slug: idSlug, name: idSlug, isCustom: false, isUnavailable: true });
    }
  }
  return opts;
}

export function getAppModelOptionsForInstance(
  conf: UnifiedPrefs,
  rec: AgentProfileEntry,
  chosenModel?: string | null,
): AppModelOption[] {
  return buildOptions({
    settings: conf,
    driver: rec.driverKind,
    instanceId: rec.instanceId,
    isDefaultInstance: rec.isDefault,
    rawModels: rec.models,
    selectedModel: chosenModel,
  });
}

function getAppModelOptions(
  conf: UnifiedPrefs,
  provs: ReadonlyArray<AgentStatus>,
  vendor: AgentId,
  chosenModel?: string | null,
): AppModelOption[] {
  return buildOptions({
    settings: conf,
    driver: vendor,
    instanceId: defaultProfileIdForDriver(vendor),
    isDefaultInstance: true,
    rawModels: getAgentModels(provs, vendor),
    selectedModel: chosenModel,
  });
}

export function resolveAppModelPick(
  vendor: AgentId,
  conf: UnifiedPrefs,
  provs: ReadonlyArray<AgentStatus>,
  chosenModel: string | null | undefined,
): string {
  const agent = resolveSelectableAgent(provs, vendor);
  const opts = getAppModelOptions(conf, provs, agent, chosenModel);
  return resolveSelectableModel(agent, chosenModel, opts) ?? getDefaultDaemonModel(provs, agent);
}

export function resolveAppModelPickForInstance(
  instKey: AgentProfileId,
  conf: UnifiedPrefs,
  provs: ReadonlyArray<AgentStatus>,
  chosenModel: string | null | undefined,
  resolutionOptions?: { preserveUnavailableSelection?: boolean },
): string | null {
  const rec = deriveAgentProfileEntries(provs).find((ev) => ev.instanceId === instKey);
  if (!rec) return null;
  const preserve = resolutionOptions?.preserveUnavailableSelection === true;
  const driver = rec.driverKind;

  const opts = getAppModelOptionsForInstance(conf, rec, preserve ? chosenModel : undefined);
  const settled = resolveSelectableModel(driver, chosenModel, opts);
  if (settled) return settled;

  if (preserve && isDynamicCatalogDriver(driver)) {
    const idSlug = canonicalModelSlug(chosenModel, driver);
    const hidden = conf.providerModelPreferences?.[instKey]?.hiddenModels ?? [];
    if (
      idSlug &&
      !hidden.includes(idSlug) &&
      resolveSelectableModel(driver, idSlug, rec.models) === null &&
      ((driver as string) !== "antigravity" || idSlug !== ANTIGRAVITY_DEFAULT_MODEL)
    ) {
      return chosenModel ?? idSlug;
    }
  }
  // A full Claude id ("claude-sonnet-5") names the family row the picker lists as its alias ("sonnet").
  const fam =
    driver === "claude" ? /^claude-(opus|sonnet|haiku)\b/i.exec(chosenModel ?? "")?.[1] : undefined;
  const familyRow = fam
    ? opts.find((obj) => obj.slug.toLowerCase() === fam.toLowerCase())
    : undefined;
  if (familyRow) return familyRow.slug;
  return opts.find((obj) => obj.isDefault)?.slug ?? opts[0]?.slug ?? null;
}

export function getCustomModelOptionsByInstance(
  conf: UnifiedPrefs,
  provs: ReadonlyArray<AgentStatus>,
  selectedInstanceId?: AgentProfileId | null,
  chosenModel?: string | null,
): ReadonlyMap<AgentProfileId, ReadonlyArray<ModelEsque>> {
  return new Map(
    deriveAgentProfileEntries(provs).map((rec) => [
      rec.instanceId,
      getAppModelOptionsForInstance(
        conf,
        rec,
        rec.instanceId === selectedInstanceId ? chosenModel : undefined,
      ),
    ]),
  );
}

export function withoutPlanAgentSelection(
  picked: ModelPick | null | undefined,
): ModelPick | null | undefined {
  if (!picked?.options) return picked;
  const retained = picked.options.filter((obj) => !(obj.id === "agent" && obj.value === "plan"));
  return retained.length === picked.options.length
    ? picked
    : createModelPick(picked.instanceId, picked.model, retained);
}

/** Stored selections only heal when plan mode flips; this repairs them once per settings load. */
export function resolvePlanAgentHealPatch(args: {
  planModeEnabled: boolean;
  textGenerationModelSelection: ModelPick | null | undefined;
  sourceControlWriterModelSelection: ModelPick | null | undefined;
}): DaemonPrefsPatch | null {
  if (args.planModeEnabled) return null;
  const delta: Record<string, ModelPick | null | undefined> = {};
  const str = withoutPlanAgentSelection(args.textGenerationModelSelection);
  if (str !== args.textGenerationModelSelection) delta.textGenerationModelSelection = str;
  const writer = withoutPlanAgentSelection(args.sourceControlWriterModelSelection);
  if (writer !== args.sourceControlWriterModelSelection) {
    delta.sourceControlWriterModelSelection = writer;
  }
  return Object.keys(delta).length === 0 ? null : (delta as DaemonPrefsPatch);
}
