import type {
  FleetSwarmActivity,
  FleetWorker,
  FleetSwarmPhase,
  SwarmLocalServerId,
  SwarmProviderId,
  SwarmStatus,
  SwarmSupplyMode,
  SwarmSupplyState,
} from "@kora/contracts";
import { thisComputer } from "./utils";

/**
 * Pure Swarm-mode helpers for the web client (no React, no atoms). Copy here follows runtime truth:
 * nothing says Zen needs "no key" (the probe decides, PLAN D-h), Cerebras is labelled a trial
 * (D-f), and activity text is measured counts only — no dollars, no "saved" (X5).
 */

/** How the composer's Swarm segment behaves. `tooltip` is null only when hidden. */
export type SwarmToggleAvailability =
  | { readonly kind: "hidden"; readonly tooltip: null }
  | { readonly kind: "disabled"; readonly tooltip: string }
  | { readonly kind: "needs-setup"; readonly tooltip: string; readonly noGit?: boolean }
  | { readonly kind: "ready"; readonly tooltip: string; readonly noGit?: boolean };

/** What Swarm means in a folder that is not a git repo (the composer's popover offers "Set up git here"). */
export const SWARM_NO_GIT_DETAIL =
  "This folder isn't a git repo, so workers can't each get their own copy: they work in this folder together and can overwrite each other's files. Fine for research and writing; for code, set up git first.";

/** Drivers that can lead a swarm: the ones the daemon gives the fleet bridge. */
export const SWARM_LEADER_PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex", "opencode"]);

export function resolveSwarmToggleAvailability(input: {
  /** The host capability `swarm` (absent/false on older daemons). */
  readonly capability: boolean;
  /** The selected leader's driver (`claude`, `codex`, …), or null when unknown. */
  readonly selectedProvider: string | null;
  /** The host's swarm status; null while loading (treated as not ready). */
  readonly status: SwarmStatus | null;
  /** Whether the chat's folder is a git repository; null/omitted = unknown (Swarm stays offered). */
  readonly isGitRepo?: boolean | null;
}): SwarmToggleAvailability {
  if (!input.capability) return { kind: "hidden", tooltip: null };
  if (input.selectedProvider === null || !SWARM_LEADER_PROVIDERS.has(input.selectedProvider)) {
    return {
      kind: "disabled",
      tooltip: "Stretch needs a Claude, Codex or OpenCode model as the leader.",
    };
  }
  // A plain folder still gets Swarm — workers then share the folder (no worktrees); the toggle says so first.
  const noGit = input.isGitRepo === false ? { noGit: true } : {};
  if (input.status === null || !input.status.ready) {
    return {
      kind: "needs-setup",
      tooltip:
        "Stretch: your agent does small work itself and hands the rest to free AI models, then cheap Haiku or GPT Luna workers, so your usage lasts longer. Click to set it up (one step).",
      ...noGit,
    };
  }
  return {
    kind: "ready",
    tooltip:
      input.isGitRepo === false
        ? `Stretch (no git here): workers share this folder instead of getting their own copy. Click to set up git or go without.`
        : "Stretch: your agent does small work itself and hands the rest to free AI models, then cheap Haiku or GPT Luna workers, so your usage lasts longer.",
    ...noGit,
  };
}

export interface SwarmProviderMeta {
  readonly label: string;
  readonly keyUrl: string;
  readonly unlocksCopy: string;
  /** True when the provider can work without a key (the key field starts collapsed). */
  readonly keyOptional: boolean;
}

export const SWARM_PROVIDER_META: Readonly<Record<SwarmProviderId, SwarmProviderMeta>> = {
  zen: {
    label: "OpenCode Zen",
    keyUrl: "https://opencode.ai/auth",
    unlocksCopy:
      "Free models curated by OpenCode. Kora tests whether they work without a key on this machine.",
    keyOptional: true,
  },
  openrouter: {
    label: "OpenRouter",
    keyUrl: "https://openrouter.ai/settings/keys",
    unlocksCopy:
      "Free models (ids ending in :free): 20 requests/min, 50/day. Buying $10 of credit (one time) raises this to 1000/day; free models still cost nothing.",
    keyOptional: false,
  },
  cerebras: {
    label: "Cerebras (trial)",
    keyUrl: "https://cloud.cerebras.ai",
    unlocksCopy:
      "Very fast. Trial: $5 credit for 30 days, 5 requests/min; needs a payment method on file. Off by default.",
    keyOptional: false,
  },
  ollama: {
    label: "Ollama (local)",
    keyUrl: "https://ollama.com/download",
    unlocksCopy:
      "Models on this machine. Nothing leaves your computer. Needs a tool-calling model.",
    keyOptional: true,
  },
  lmstudio: {
    label: "LM Studio (local)",
    keyUrl: "https://lmstudio.ai",
    unlocksCopy: "Models on this machine via LM Studio's server. Nothing leaves your computer.",
    keyOptional: true,
  },
};

/**
 * How a swarm phase shows on the worker tile. `state: null` = use the worker's own state word
 * (running / done / starting); otherwise the tile chrome state to force, with its label.
 */
export function swarmPhaseChrome(phase: FleetSwarmPhase): {
  readonly state: "waiting" | "needs-you" | "exited" | null;
  readonly label: string | null;
} {
  switch (phase) {
    case "rate-limited":
      return { state: "waiting", label: "rate-limited" };
    case "respawning":
      return { state: "waiting", label: "switching model…" };
    case "exhausted":
      return { state: "needs-you", label: "no free models left" };
    case "failed":
      return { state: "exited", label: "opencode crashed" };
    case "starting":
      return { state: null, label: "starting…" };
    case "running":
    case "done":
      return { state: null, label: null };
  }
}

/** `zen · big-pickle` */
export function formatSwarmModel(provider: SwarmProviderId, modelLabel: string): string {
  return `${provider} · ${modelLabel}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Measured counts only, one line each (zero counts other than "delegated" are omitted). */
export function formatSwarmActivity(activity: FleetSwarmActivity): string[] {
  const lines = [`${activity.delegated} delegated`];
  if (activity.reportsReturned > 0)
    lines.push(plural(activity.reportsReturned, "report", "reports"));
  if (activity.passedFirstTry > 0) lines.push(`${activity.passedFirstTry} passed first try`);
  if (activity.bounced > 0) lines.push(`${activity.bounced} bounced`);
  if (activity.respawns > 0) lines.push(plural(activity.respawns, "failover", "failovers"));
  for (const m of activity.byModel) {
    lines.push(
      `${formatSwarmModel(m.provider, m.modelLabel)} × ${plural(m.workers, "worker", "workers")}`,
    );
  }
  if (activity.exhausted) lines.push("all free models are rate-limited");
  return lines;
}

/**
 * Where Swarm workers run — the three first-class choices of setup step 3 and Settings → Swarm.
 * `free` is OpenCode Zen (no key); `openrouter` is the user's own OpenRouter key (free `:free`
 * models, plus cheap paid ones under a per-task cap where the daemon supports it); `local` is
 * Ollama / LM Studio on this machine. Paid and local need `SwarmStatus.supplyState` (the config
 * `swarm.supply|paid|local` block), which older daemons omit: every read goes through
 * `swarmSupply()`.
 */
export type SwarmWorkerSource = "free" | "openrouter" | "local";

export const SWARM_WORKER_SOURCES: Readonly<
  Record<
    SwarmWorkerSource,
    {
      readonly title: string;
      readonly tag: string;
      readonly body: string;
      readonly privacy: string;
    }
  >
> = {
  free: {
    title: "Free models",
    tag: "No key · $0",
    body: "OpenCode Zen's free models. Nothing to sign up for; they are rate-limited, so big jobs can slow down.",
    privacy: "Free third-party endpoints may log your prompts and code and train on them.",
  },
  openrouter: {
    title: "Your OpenRouter key",
    tag: "Cheap paid models",
    body: "Bring your own OpenRouter key. Workers use its free models, and cheap paid ones (fractions of a cent per task) under a per-task cap you set.",
    privacy:
      "Prompts go to OpenRouter and the model's host under their policies; free models may log and train on them.",
  },
  local: {
    title: "Local models",
    tag: "Private",
    body: `Ollama or LM Studio on ${thisComputer()}. Workers never leave your machine; speed and quality depend on your hardware and model.`,
    privacy: "Prompts and code stay on this machine.",
  },
};

export const SWARM_SUPPLY_MODES: ReadonlyArray<{
  readonly mode: SwarmSupplyMode;
  readonly label: string;
  readonly detail: string;
}> = [
  {
    mode: "free-first",
    label: "Free first",
    detail: "Free models first; paid or local ones when they are busy.",
  },
  {
    mode: "paid-first",
    label: "Paid first",
    detail: "Cheap paid models first (faster, a little money); free ones as backup.",
  },
  {
    mode: "local-only",
    label: "Local only",
    detail: `Only models on ${thisComputer()}. Nothing leaves your machine.`,
  },
];

export const LOCAL_SERVER_LABEL: Readonly<Record<SwarmLocalServerId, string>> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

/** `SwarmStatus.supplyState` when the daemon has it (paid / local supply), else null. */
export function swarmSupply(status: SwarmStatus): SwarmSupplyState | null {
  const supply = (status as { readonly supplyState?: SwarmSupplyState }).supplyState;
  return supply !== undefined && supply !== null && typeof supply === "object" ? supply : null;
}

export interface SwarmWorkerSourceState {
  /** on = workers can use it now; off = available but not set up; unavailable = this daemon lacks it. */
  readonly state: "on" | "off" | "unavailable";
  readonly detail: string;
}

/** `$0.05`, `$0.005`, `$2` */
export function formatUsd(usd: number): string {
  if (usd >= 1) return `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`;
  return `$${usd.toFixed(usd < 0.01 ? 3 : 2)}`;
}

export function swarmWorkerSourceStates(
  status: SwarmStatus,
): Readonly<Record<SwarmWorkerSource, SwarmWorkerSourceState>> {
  const provider = (id: SwarmProviderId) => status.providers.find((p) => p.provider === id) ?? null;
  const supply = swarmSupply(status);
  const localOnly = supply?.supply === "local-only";

  const zen = provider("zen");
  const free: SwarmWorkerSourceState = localOnly
    ? { state: "off", detail: "Off · local only" }
    : zen === null || !zen.enabled
      ? { state: "off", detail: "Off" }
      : zen.lastTest === null
        ? { state: "on", detail: "On · not tested yet" }
        : zen.lastTest.ok
          ? {
              state: "on",
              detail: `On · ${plural(zen.lastTest.freeModels.length, "free model", "free models")}`,
            }
          : { state: "off", detail: "Not working right now: test it again" };

  const or = provider("openrouter");
  const paid = supply?.paid ?? null;
  const openrouter: SwarmWorkerSourceState = localOnly
    ? { state: "off", detail: "Off · local only" }
    : or === null || !or.hasKey
      ? { state: "off", detail: "No key yet" }
      : !or.enabled
        ? { state: "off", detail: "Key saved · off" }
        : paid?.enabled
          ? { state: "on", detail: `On · paid models up to ${formatUsd(paid.maxTaskUsd)} a task` }
          : { state: "on", detail: "On · free models only" };

  const servers = supply
    ? (Object.keys(LOCAL_SERVER_LABEL) as SwarmLocalServerId[]).filter(
        (id) => supply.local[id]?.enabled,
      )
    : [];
  const local: SwarmWorkerSourceState =
    supply === null
      ? { state: "unavailable", detail: "Needs a newer Kora" }
      : servers.length > 0
        ? { state: "on", detail: `On · ${servers.map((id) => LOCAL_SERVER_LABEL[id]).join(" + ")}` }
        : { state: "off", detail: "Off" };

  return { free, openrouter, local };
}

/** A typed per-task cap: dollars, > 0 and at most $5, up to 3 decimals. null for an empty field. */
export function parseTaskCap(text: string): number | null | "invalid" {
  const trimmed = text.trim().replace(/^\$/, "");
  if (trimmed === "") return null;
  if (!/^\d*(\.\d{1,3})?$/.test(trimmed) || trimmed === ".") return "invalid";
  const value = Number(trimmed);
  return value > 0 && value <= 5 ? value : "invalid";
}

/** Which program runs swarm workers on this host (`SwarmStatus.workerBackend`; absent = OpenCode). */
export function swarmWorkerBackend(status: SwarmStatus | null): "opencode" | "koragent" {
  return status?.workerBackend?.id === "koragent" ? "koragent" : "opencode";
}

/** The worker program's product name, for copy ("OpenCode workers" / "Koragent workers"). */
export function swarmWorkerBackendLabel(status: SwarmStatus | null): "OpenCode" | "Koragent" {
  return swarmWorkerBackend(status) === "koragent" ? "Koragent" : "OpenCode";
}

/** The command that installs Koragent (there is no in-app download yet: a local build or a pinned URL). */
export const KORAGENT_INSTALL_COMMAND =
  "kora swarm install --backend koragent --from <path to koragent>";

/** Koragent's readiness as one line + whether it blocks (the workers step and the checklist). */
export function koragentReadiness(status: SwarmStatus): {
  readonly ok: boolean;
  readonly label: string;
  readonly detail: string;
} {
  const wb = status.workerBackend;
  if (!wb || wb.id !== "koragent") return { ok: true, label: "OpenCode", detail: "" };
  if (!wb.installed) return { ok: false, label: "Not installed", detail: "" };
  if (wb.pinOk === false) {
    return {
      ok: false,
      label: "Changed since install",
      detail: "The binary no longer matches the sha256 Kora pinned. Reinstall it.",
    };
  }
  if (wb.versionOk === false) {
    return {
      ok: false,
      label: wb.version ? `${wb.version} is too old` : "No version answer",
      detail: `Needs ${wb.minVersion ?? "a newer version"} or newer.`,
    };
  }
  const version = wb.version === "local" ? "development build" : (wb.version ?? "installed");
  return {
    ok: true,
    label: version,
    detail: `${wb.path ?? ""}${wb.pinned ? ` · sha256 ${wb.pinned.slice(0, 12)}…` : ""}`,
  };
}

/**
 * The lead's live status line while it waits on its helpers: "Waiting for 2 helpers", or "1 helper needs you" when
 * one is blocked. null when no helper is busy (the line then says "Thinking"). Same fleet snapshot as the composer chip.
 */
export function helperWaitLabel(
  workers: ReadonlyArray<FleetWorker> | null | undefined,
): string | null {
  if (!workers) return null;
  const blocked = workers.filter((w) => w.state === "blocked").length;
  if (blocked > 0) return `${blocked} helper${blocked === 1 ? " needs" : "s need"} you`;
  const busy = workers.filter((w) => w.state === "working" || w.state === "unknown").length;
  return busy > 0 ? `Waiting for ${busy} helper${busy === 1 ? "" : "s"}` : null;
}
