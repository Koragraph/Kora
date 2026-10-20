import {
  type ModelPick,
  type DaemonPrefs,
  type AgentStatus,
  type AgentState,
  type AgentModel,
  type AgentId,
  AgentProfileId,
  resolveAgentProfileEnabled,
  defaultProfileIdForDriver,
  DEFAULT_MODEL_BY_AGENT,
} from "@kora/contracts";
import {
  shouldShowInstanceBadge,
  resolveAgentProfileDisplayName,
  normalizeAgentAccentColor,
} from "@kora/client-runtime/store/agent-profile-display";

export { shouldShowInstanceBadge };

/** Placeholder pick for "no provider": never stored or dispatched; the composer blocks send. */
export const NO_AGENT_MODEL_PICK: ModelPick = {
  instanceId: AgentProfileId.make("kora_no_provider"),
  model: "",
};

export interface AgentProfileEntry {
  readonly driverKind: AgentId;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly continuationGroupKey?: string | undefined;
  readonly status: AgentState;
  readonly isDefault: boolean;
  readonly isAvailable: boolean;
  readonly snapshot: AgentStatus;
  readonly models: ReadonlyArray<AgentModel>;
  readonly instanceId: AgentProfileId;
}

const has = (obj: object, keyName: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, keyName);

export const isAgentProfilePickerReady = (ev: AgentProfileEntry): boolean =>
  ev.enabled && ev.isAvailable && ev.status === "ready";

export const isAgentProfilePickerVisible = (ev: AgentProfileEntry): boolean => ev.enabled;

function toEntry(frameSnap: AgentStatus): AgentProfileEntry {
  return {
    instanceId: frameSnap.instanceId,
    driverKind: frameSnap.driver,
    displayName: resolveAgentProfileDisplayName(frameSnap),
    accentColor: normalizeAgentAccentColor(frameSnap.accentColor),
    continuationGroupKey: frameSnap.continuation?.groupKey,
    enabled: frameSnap.enabled,
    installed: frameSnap.installed,
    status: frameSnap.status,
    isDefault: frameSnap.instanceId === defaultProfileIdForDriver(frameSnap.driver),
    isAvailable: frameSnap.availability !== "unavailable",
    snapshot: frameSnap,
    models: frameSnap.models,
  };
}

export function deriveAgentProfileEntries(
  provs: ReadonlyArray<AgentStatus>,
): ReadonlyArray<AgentProfileEntry> {
  return provs.map(toEntry);
}

/** Settings beat the streamed probe, which keeps its old `enabled` for a moment after a write. */
export function applyAgentProfilePrefs(
  records: ReadonlyArray<AgentProfileEntry>,
  conf: Pick<DaemonPrefs, "providerInstances" | "providers">,
): ReadonlyArray<AgentProfileEntry> {
  return records.map((rec) => {
    const instanceKey = rec.instanceId as string;
    let on: boolean;
    if (has(conf.providerInstances, instanceKey)) {
      on = resolveAgentProfileEnabled(conf.providerInstances[rec.instanceId]!);
    } else if (rec.isDefault && has(conf.providers, rec.driverKind)) {
      on =
        (conf.providers as Record<string, { enabled?: boolean } | undefined>)[rec.driverKind]
          ?.enabled ?? rec.enabled;
    } else {
      on = false;
    }
    return on === rec.enabled ? rec : { ...rec, enabled: on };
  });
}

export function sortAgentProfileEntries(
  records: ReadonlyArray<AgentProfileEntry>,
): ReadonlyArray<AgentProfileEntry> {
  const buckets = new Map<AgentId, AgentProfileEntry[]>();
  for (const ev of records) {
    const arr = buckets.get(ev.driverKind);
    if (arr) arr.push(ev);
    else buckets.set(ev.driverKind, [ev]);
  }
  return [...buckets.values()].flatMap((arr) => [
    ...arr.filter((ev) => ev.isDefault),
    ...arr.filter((ev) => !ev.isDefault),
  ]);
}

const NEWEST_SONNET = /^(claude-)?sonnet/i;

function defaultModelOf(rec: AgentProfileEntry): string | undefined {
  const models = rec.models;
  if (rec.driverKind === ("claude" as AgentId)) {
    // The catalog lists newest first: start new threads on the newest Sonnet, not the account's Opus.
    const sonnet = models.find(
      (model) => !model.isCustom && NEWEST_SONNET.test(model.slug) && !model.slug.includes("["),
    );
    if (sonnet) return sonnet.slug;
  }
  return (
    models.find((entry) => entry.isDefault && !entry.isCustom)?.slug ??
    models.find((entry) => !entry.isCustom)?.slug ??
    models[0]?.slug ??
    DEFAULT_MODEL_BY_AGENT[rec.driverKind]
  );
}

export function getDefaultAgentProfileModel(
  provs: ReadonlyArray<AgentStatus>,
  instKey: AgentProfileId,
): string | undefined {
  const phase = provs.find((candidate) => candidate.instanceId === instKey);
  return phase ? defaultModelOf(toEntry(phase)) : undefined;
}

export function resolveSelectableAgentProfileEntry(
  records: ReadonlyArray<AgentProfileEntry>,
  instKey: AgentProfileId | undefined,
): AgentProfileEntry | undefined {
  const selectable = (ev: AgentProfileEntry) => ev.enabled && ev.isAvailable;
  const requested =
    instKey === undefined ? undefined : records.find((ev) => ev.instanceId === instKey);
  if (requested && selectable(requested)) return requested;
  return (
    records.find(isAgentProfilePickerReady) ??
    records.find((ev) => selectable(ev) && ev.status !== "error")
  );
}

export function resolveSelectableAgentProfile(
  provs: ReadonlyArray<AgentStatus>,
  instKey: AgentProfileId | undefined,
): AgentProfileId | undefined {
  return resolveSelectableAgentProfileEntry(deriveAgentProfileEntries(provs), instKey)?.instanceId;
}

export function resolveDefaultAgentModelPick(
  provs: ReadonlyArray<AgentStatus>,
  picked: ModelPick | null | undefined,
): ModelPick | null {
  const settled = resolveSelectableAgentProfile(provs, picked?.instanceId);
  if (!settled) return null;
  if (picked && settled === picked.instanceId) return picked;
  const model = getDefaultAgentProfileModel(provs, settled);
  return model ? { instanceId: settled, model } : null;
}
