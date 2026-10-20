// @effect-diagnostics globalConsole:off globalTimers:off -- boot-time boundary code (timers + a log line), not an Effect fiber.
// The boot-time Claude/Codex catalog probes are short and best-effort, so one slow start (laptop just woke, cold
// `claude`/`codex` spawn) used to leave the picker on config.ts's 2-entry fallback until the next daemon restart.
// This retries whichever probe failed in the background, with a longer timeout, and pushes the real models to every
// open client as a `providerStatuses` frame the moment one lands.
import { daemonConfig } from "./config.ts";
import { applyClaudeModels } from "./claudeModels.ts";
import { applyCodexModels } from "./codexModels.ts";

type Listener = (providers: typeof daemonConfig.providers) => void;
const listeners = new Set<Listener>();

/** Listen for a provider catalog landing after boot; returns the unsubscribe function. */
export function onAgentsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Provider statuses changed for a reason other than the catalog (usage limits): push the frame to open clients
 * without re-running catalog listeners (the worker catalog only cares about models).
 */
const statusListeners = new Set<Listener>();
export function onAgentStatusesChanged(listener: Listener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}
export function notifyAgentStatusesChanged(): void {
  for (const listener of statusListeners) {
    try {
      listener(daemonConfig.providers);
    } catch (cause) {
      console.error("[kora-ui] provider status listener failed:", String(cause));
    }
  }
}

/** Push the current provider entries to every listener (open clients, the worker catalog). */
export function notifyAgentsChanged(): void {
  for (const listener of listeners) {
    try {
      listener(daemonConfig.providers);
    } catch (cause) {
      console.error("[kora-ui] provider listener failed:", String(cause));
    }
  }
}

export function agentStatusesFrame(providers: typeof daemonConfig.providers) {
  return { version: 1 as const, type: "providerStatuses" as const, payload: { providers } };
}

const RETRY_DELAYS_MS = [10_000, 30_000, 120_000, 300_000, 600_000, 600_000];
const RETRY_PROBE_TIMEOUT_MS = 20_000;

/** Retry the probes that failed at boot (`failed` = which ones), until they land or the delays run out. */
export function retryFailedModelProbes(failed: { claude: boolean; codex: boolean }): void {
  let pending = { ...failed };
  let attempt = 0;
  const tick = async () => {
    const [claudeOk, codexOk] = await Promise.all([
      pending.claude ? applyClaudeModels(RETRY_PROBE_TIMEOUT_MS) : Promise.resolve(true),
      pending.codex ? applyCodexModels(RETRY_PROBE_TIMEOUT_MS) : Promise.resolve(true),
    ]);
    const landed = (pending.claude && claudeOk) || (pending.codex && codexOk);
    pending = { claude: pending.claude && !claudeOk, codex: pending.codex && !codexOk };
    if (landed) notifyAgentsChanged();
    schedule();
  };
  const schedule = () => {
    if (!pending.claude && !pending.codex) return;
    const delay = RETRY_DELAYS_MS[attempt++];
    if (delay === undefined) return;
    setTimeout(() => void tick(), delay).unref?.();
  };
  schedule();
}
