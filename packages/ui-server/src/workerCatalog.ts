// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off -- boot-time boundary: writes one JSON file for the runtime.
// The worker catalog a lead agent picks its workers from (packages/runtime/src/session/worker-picker.ts reads it):
// which worker CLIs are installed and, for Claude, Codex and Antigravity, the live model ids + effort levels the boot probes
// found (claudeModels.ts / codexModels.ts). Written to <KORA_HOME>/worker-catalog.json at boot and whenever a
// late probe lands, so the in-process Claude lead and a Codex lead's `kora mcp --fleet` bridge read the same list.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { claudeResolvedModels } from "./claudeModels.ts";
import { daemonConfig } from "./config.ts";
import { defaultKoraHome } from "./localAuth.ts";

/** Worker CLIs and the binary each runs as. */
const WORKER_BINARIES: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  antigravity: "agy",
  cursor: "cursor-agent",
  opencode: "opencode",
};

function onPath(bin: string): boolean {
  // The daemon's own PATH is bare when the app starts it: also look where installers put CLIs (agy: ~/.local/bin).
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

interface CatalogModelOut {
  id: string;
  name: string;
  efforts: string[];
  isDefault?: boolean;
  /** Claude aliases: the full id the SDK resolves it to (the worker CLI is launched with this). */
  resolved?: string;
}

function modelsFor(instanceId: string): CatalogModelOut[] {
  const provider = daemonConfig.providers.find((p) => p.instanceId === instanceId);
  if (!provider) return [];
  // "Auto" is a thread setting the daemon resolves per prompt, not a model a worker CLI can launch.
  // When Auto is the thread preselection, the worker's default is the Default row again.
  const autoFirst = provider.models.some((m) => m.slug === "auto" && m.isDefault);
  return provider.models
    .filter((m) => m.slug !== "auto")
    .map((m) => {
      const isDefault = autoFirst ? m.slug === "default" : m.isDefault;
      const effortDescriptor = m.capabilities?.optionDescriptors?.find((d) => d.id === "effort");
      const efforts =
        effortDescriptor && "options" in effortDescriptor && Array.isArray(effortDescriptor.options)
          ? effortDescriptor.options
              .map((o: { id: string }) => o.id)
              .filter((id: string) => id !== "ultrathink")
          : [];
      const resolved = instanceId === "claude" ? claudeResolvedModels.get(m.slug) : undefined;
      return {
        id: m.slug,
        name: m.name,
        efforts,
        ...(isDefault ? { isDefault: true } : {}),
        ...(resolved ? { resolved } : {}),
      };
    });
}

/** Kora's own OpenCode (the Swarm setup installs it under <KORA_HOME>/tools; it is usually not on PATH). */
function managedOpencode(koraHome: string | undefined): boolean {
  if (!koraHome) return false;
  try {
    fs.accessSync(
      path.join(koraHome, "tools", "opencode", "current", "opencode"),
      fs.constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

/** Build the catalog from the live provider list + PATH (+ Kora's managed OpenCode). */
export function buildWorkerCatalog(koraHome?: string) {
  const agents: Record<string, { installed: boolean; models: CatalogModelOut[] }> = {};
  for (const [id, bin] of Object.entries(WORKER_BINARIES)) {
    // An `agent:"opencode"` worker runs the managed binary (runtime opencode-worker.ts): installed when either
    // exists. Live: the catalog said "not installed", the picker's approval was silently filtered to nothing and the
    // lead looped "approved → spawn refused" (qa/e2e/model/orchestrator.cjs).
    const installed = onPath(bin) || (id === "opencode" && managedOpencode(koraHome));
    if (!installed && id !== "claude" && id !== "codex") continue;
    // Antigravity's ids carry the effort (`gemini-3.8-flash-low`), so its rows have no effort levels. OpenCode's rows
    // are the swarm's free models (blobsEngine.ts applyOpencodeFreeModels keeps that provider entry current).
    agents[id] = {
      installed,
      models: ["claude", "codex", "antigravity", "opencode"].includes(id) ? modelsFor(id) : [],
    };
  }
  return { updatedAt: new Date().toISOString(), agents };
}

/** Best-effort write; a failure only means the lead sees no model list (spawns still work with CLI defaults). */
export function writeWorkerCatalog(koraHome: string = defaultKoraHome()): void {
  try {
    const file = path.join(koraHome, "worker-catalog.json");
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(buildWorkerCatalog(koraHome), null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (cause) {
    console.error("[kora-ui] worker catalog write failed:", String(cause));
  }
}
