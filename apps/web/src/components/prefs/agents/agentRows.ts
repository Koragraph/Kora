/** One agent the page lists: a driver's built-in slot or an extra instance of it. */

import { getAgentSummary } from "../agentStatus";
import { DEFAULT_UNIFIED_PREFS } from "@kora/contracts/clientPrefs";
import {
  resolveAgentProfileEnabled,
  defaultProfileIdForDriver,
  type AgentProfileConfig,
  type AgentProfileId,
  type UnifiedPrefs,
  type AgentStatus,
  type AgentId,
} from "@kora/contracts";
import * as Equal from "effect/Equal";

export interface AgentRow {
  readonly instanceId: AgentProfileId;
  readonly instance: AgentProfileConfig;
  readonly driver: AgentId;
  /** The driver's built-in slot: can be reset to defaults, never deleted. */
  readonly isDefault: boolean;
  /** A built-in slot whose settings differ from the shipped defaults. */
  readonly isDirty?: boolean;
}

type LegacyAgentPrefs = UnifiedPrefs["providers"][keyof UnifiedPrefs["providers"]];

/**
 * The agents to show, in driver order: each visible driver's built-in slot (from an explicit
 * instance, else synthesized from the legacy per-driver settings), then its extra instances, then
 * instances of drivers this build does not list (kept so their config round-trips).
 */
export function buildAgentRows(
  settings: UnifiedPrefs,
  visibleDrivers: ReadonlyArray<AgentId>,
): AgentRow[] {
  const instancesByDriver = new Map<AgentId, Array<[AgentProfileId, AgentProfileConfig]>>();
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    const list = instancesByDriver.get(instance.driver) ?? [];
    list.push([rawId as AgentProfileId, instance]);
    instancesByDriver.set(instance.driver, list);
  }
  const defaultSlotIds = new Set<string>(
    visibleDrivers.map((driver) => String(defaultProfileIdForDriver(driver))),
  );
  const legacyAgents = settings.providers as Record<string, LegacyAgentPrefs>;
  const defaultLegacyAgents = DEFAULT_UNIFIED_PREFS.providers as Record<string, LegacyAgentPrefs>;

  const rows: AgentRow[] = [];
  for (const driver of visibleDrivers) {
    const defaultInstanceId = defaultProfileIdForDriver(driver);
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    const legacyConfig = legacyAgents[driver];
    // The envelope is the single enabled flag: keep the legacy in-config flag out of the
    // synthesized blob, or an explicit `enabled: false` would keep winning over the envelope.
    const synthesized = (): AgentProfileConfig | undefined => {
      if (legacyConfig === undefined) return undefined;
      const { enabled, ...config } = legacyConfig;
      return { driver, enabled, config } satisfies AgentProfileConfig;
    };
    const instance = explicitInstance ?? synthesized();
    if (instance !== undefined) {
      rows.push({
        instanceId: defaultInstanceId,
        instance,
        driver,
        isDefault: true,
        isDirty:
          explicitInstance !== undefined ||
          !Equal.equals(legacyConfig, defaultLegacyAgents[driver]),
      });
    }
    for (const [id, extra] of instancesByDriver.get(driver) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance: extra, driver: extra.driver, isDefault: false });
    }
  }
  const visible = new Set<AgentId>(visibleDrivers);
  for (const [driver, list] of instancesByDriver) {
    if (visible.has(driver)) continue;
    for (const [id, instance] of list) {
      rows.push({
        driver: instance.driver,
        instance,
        instanceId: id,
        isDefault: defaultSlotIds.has(String(id)),
      });
    }
  }
  return rows;
}

export type AgentReadinessState = "ready" | "attention" | "error" | "checking" | "off";

export interface AgentReadiness {
  readonly state: AgentReadinessState;
  readonly headline: string;
  readonly detail: string | null;
}

/**
 * One status for an agent, in the same vocabulary as Swarm's readiness list. A turned-off agent
 * reads "Off" whatever its last probe said; otherwise the daemon's probe decides.
 */
export function agentReadiness(
  instance: AgentProfileConfig,
  live: AgentStatus | undefined,
): AgentReadiness {
  if (!resolveAgentProfileEnabled(instance)) {
    return { state: "off", headline: "Off", detail: null };
  }
  const summary = getAgentSummary(live);
  if (!live) return { state: "checking", headline: "Checking…", detail: summary.detail };
  if (!live.installed) {
    return { state: "error", headline: "Not installed", detail: summary.detail };
  }
  if (live.status === "error") return { state: "error", ...summary };
  if (live.status === "warning" || live.auth.status === "unauthenticated") {
    return { state: "attention", ...summary };
  }
  return {
    state: "ready",
    headline: live.auth.status === "authenticated" ? "Ready · signed in" : "Ready",
    detail: live.message ?? null,
  };
}

/** Splits agents into the ones turned on and the ones turned off, keeping driver order. */
export function partitionAgentRows<T extends { readonly instance: AgentProfileConfig }>(
  rows: ReadonlyArray<T>,
): { readonly on: T[]; readonly off: T[] } {
  const on: T[] = [];
  const off: T[] = [];
  for (const row of rows) (resolveAgentProfileEnabled(row.instance) ? on : off).push(row);
  return { on, off };
}
