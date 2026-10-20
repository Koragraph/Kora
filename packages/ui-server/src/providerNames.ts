/**
 * Settings › Agents › "Name in the picker" (`settings.providerInstances[id].displayName`) on the advertised provider
 * entries. The picker reads the entry's `displayName`, which the daemon hard-codes ("Claude"), so the setting saved and
 * changed nothing outside the Agents card (pl9 S2-1). Each entry's own name is remembered so clearing the field
 * brings it back.
 */
import { daemonConfig } from "./config.ts";

/** The daemon's own name per entry, and the name this module last put there. */
const ownName = new Map<string, string>();
const applied = new Map<string, string>();

/** Apply the user's names to `daemonConfig.providers`; true when an entry changed (the caller pushes the list). */
export function applyProviderDisplayNames(
  settings: { providerInstances?: unknown } = daemonConfig.settings,
): boolean {
  const instances = (settings.providerInstances ?? {}) as Record<
    string,
    { displayName?: unknown } | undefined
  >;
  let changed = false;
  for (const entry of daemonConfig.providers as unknown as Array<{
    instanceId: string;
    displayName?: string;
  }>) {
    const shown = entry.displayName ?? "";
    // First sight, or something else rewrote the entry (a model probe rebuilt it): that is the daemon's name now.
    if (applied.get(entry.instanceId) !== shown) ownName.set(entry.instanceId, shown);
    const custom = instances[entry.instanceId]?.displayName;
    const want =
      typeof custom === "string" && custom.trim()
        ? custom.trim()
        : (ownName.get(entry.instanceId) ?? shown);
    applied.set(entry.instanceId, want);
    if (want !== shown) {
      entry.displayName = want;
      changed = true;
    }
  }
  return changed;
}
