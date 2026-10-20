// @effect-diagnostics globalDate:off globalConsole:off globalTimers:off -- plain timestamps, a log line and a debounce at the boundary to the in-process runtime.
/**
 * Phase 7: the ACP agents and API endpoints as composer providers. Each usable engine becomes a `providers[]` entry
 * (`driver` = its agent id: `gemini`, `acp-hermes`, `api-groq`, so `session.providerName === driver` holds and the
 * composer does not disable itself) AND a `settings.providerInstances[id]` entry (without it the composer forces the
 * provider disabled). An engine that cannot run right now stays listed with `status: "error"` and its reason; it is
 * never hidden and never throws. Models: what was discovered (API `/models`, an ACP agent's `session/new`), else the
 * one placeholder "Default" so the engine can be picked before its list is known.
 */
import { daemonConfig } from "./config.ts";
import { host } from "./host.ts";
import { notifyAgentsChanged, onAgentsChanged } from "./modelRefresh.ts";

type ProviderEntry = (typeof daemonConfig.providers)[number];

/** Ids this module put in the provider list (so a removed endpoint's entry goes away). */
const managed = new Set<string>();

const modelEntry = (m: { id: string; name: string }, isDefault: boolean) => ({
  slug: m.id,
  name: m.name || m.id,
  shortName: m.name || m.id,
  isCustom: false,
  ...(isDefault ? { isDefault: true } : {}),
  capabilities: { optionDescriptors: [] },
});

/** Rebuild the engine providers from the runtime's engine list. Returns whether anything changed. */
export async function syncEngineProviders(): Promise<boolean> {
  const engines = host().engines;
  if (!engines) return false;
  let list: Awaited<ReturnType<typeof engines.pickerEngines>>;
  try {
    list = await engines.pickerEngines();
  } catch (cause) {
    console.warn("[kora-ui] engines: could not list engines:", String(cause));
    return false;
  }
  const providers = daemonConfig.providers as unknown as ProviderEntry[];
  const instances = daemonConfig.settings.providerInstances as Record<string, unknown>;
  const before = JSON.stringify([providers.filter((p) => managed.has(p.instanceId)), [...managed]]);
  const next = new Set<string>();
  for (const e of list) {
    next.add(e.id);
    const models =
      e.models.length > 0
        ? e.models.map((m) => modelEntry(m, m.id === e.defaultModel))
        : [modelEntry({ id: "default", name: "Default" }, true)];
    if (models.every((m) => !("isDefault" in m)) && models[0])
      Object.assign(models[0], { isDefault: true });
    const entry = {
      instanceId: e.id,
      driver: e.id,
      displayName: e.label,
      badgeLabel: e.family === "acp" ? "ACP" : "API",
      supportsTextGeneration: true,
      reportsContextWindow: false,
      enabled: true,
      installed: e.available,
      version: null,
      status: e.available ? "ready" : "error",
      auth: e.available
        ? { status: "authenticated", type: e.family === "api" ? "api-key" : "cli", label: e.family }
        : { status: "unauthenticated", label: e.family },
      checkedAt: new Date().toISOString(),
      slashCommands: [],
      skills: [],
      models,
      ...(e.available
        ? {}
        : {
            message: e.reason ?? "Not available.",
            availability: "unavailable",
            unavailableReason: e.reason ?? "Not available.",
          }),
    } as unknown as ProviderEntry;
    const i = providers.findIndex((p) => p.instanceId === e.id);
    if (i >= 0) providers[i] = entry;
    else providers.push(entry);
    instances[e.id] = { driver: e.id, enabled: true, displayName: e.label };
  }
  // Named Claude accounts: `claude-<name>` is the Claude driver on that account's login, with Claude's own model list.
  const claude = providers.find((p) => p.instanceId === "claude");
  if (claude) {
    let accounts: Array<{ name: string; label: string }> = [];
    try {
      accounts = engines.accountList();
    } catch {
      accounts = [];
    }
    for (const a of accounts) {
      const id = `claude-${a.name}`;
      next.add(id);
      const copy = JSON.parse(JSON.stringify(claude)) as Record<string, unknown>;
      delete copy.usageLimits; // the plan windows belong to the main login
      const entry = {
        ...copy,
        instanceId: id,
        driver: "claude",
        displayName: `Claude · ${a.label}`,
        badgeLabel: a.label,
        checkedAt: new Date().toISOString(),
      } as unknown as ProviderEntry;
      const i = providers.findIndex((p) => p.instanceId === id);
      if (i >= 0) providers[i] = entry;
      else providers.push(entry);
      instances[id] = { driver: "claude", enabled: true, displayName: `Claude · ${a.label}` };
    }
  }
  for (const id of managed) {
    if (next.has(id)) continue;
    const i = providers.findIndex((p) => p.instanceId === id);
    if (i >= 0) providers.splice(i, 1);
    delete instances[id];
  }
  managed.clear();
  for (const id of next) managed.add(id);
  const after = JSON.stringify([providers.filter((p) => managed.has(p.instanceId)), [...managed]]);
  // checkedAt moves every time; compare without it
  const strip = (s: string) => s.replace(/"checkedAt":"[^"]*"/g, "");
  if (strip(before) === strip(after)) return false;
  notifyAgentsChanged();
  return true;
}

/** Start keeping the list in step: now, and whenever Settings > Engines changes something. */
export function startEngineProviderSync(): void {
  const engines = host().engines;
  if (!engines) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void syncEngineProviders();
    }, 50);
    timer.unref?.();
  };
  try {
    engines.on("changed", schedule);
  } catch {
    /* an older engines object without events: the initial sync below still runs */
  }
  // Claude's own catalog lands after boot (and per account): the account entries copy it, so follow it.
  onAgentsChanged(() => schedule());
  void syncEngineProviders();
}
