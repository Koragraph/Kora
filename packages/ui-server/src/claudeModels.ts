// @effect-diagnostics globalConsole:off nodeBuiltinImport:off -- plain boot-time boundary code (a call into the host kora daemon + a
// couple of log lines), not an Effect fiber; mirrors codexModels.ts.
//
// Auto-detect the Claude model catalog at daemon boot instead of hardcoding it.
//
// kora drives Claude through the Claude Agent SDK, whose `query(...).supportedModels()` returns the exact
// catalog `/model` shows in the CLI — the latest models this Claude Code version offers, each with the effort
// levels it supports. kora exposes that as `listClaudeModels()` (src/session/list-models.ts), handed to us on
// the host (host.ts); we call it once here, map each row to a `AgentModel`, and patch them into the Claude provider in daemonConfig.
// Best-effort + bounded: on any failure we keep the static fallback list in config.ts and never block boot.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { AgentModel } from "@kora/contracts";
import * as Schema from "effect/Schema";
import { claudeCapabilities, daemonConfig } from "./config.ts";
import { type ClaudeModelInfo, host } from "./host.ts";

const CLAUDE_INSTANCE_ID = "claude";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/**
 * The SDK doesn't report a per-model default effort, so pick a sensible one: medium, then high, then middle. High on every
 * Sonnet/Opus turn is the expensive setting; a task that needs more picks it (or says "ultrathink") itself.
 */
function pickDefaultEffort(levels: ReadonlyArray<string>): string {
  if (levels.includes("medium")) return "medium";
  if (levels.includes("high")) return "high";
  return levels[Math.floor(levels.length / 2)] ?? levels[0]!;
}

/** "claude-sonnet-5-5" → "Sonnet 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5"; null when it is not a claude id. */
export function prettyClaudeId(id: string | null): string | null {
  const m = id ? /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/.exec(id) : null;
  if (!m) return null;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/**
 * Alias → full model id from the SDK catalog (`sonnet` → `claude-sonnet-5-5`). The worker catalog carries it so a
 * Claude CLI worker launches the model the picker named: an older `claude` on PATH resolves the bare alias to the
 * model IT knows (live 2026-10-02: picker "Sonnet 5.5", CLI 2.1.283 ran `--model sonnet` as claude-sonnet-5).
 */
export const claudeResolvedModels = new Map<string, string>();

/**
 * What Kora's "Default" Claude model runs: the `model` of the user's own Claude settings, else Sonnet. The SDK's own
 * "default" row resolves to Opus 5.5 (five times a Sonnet turn), which is not what a user who set `sonnet` expects.
 * Mirrors packages/runtime/src/util/claude-default-model.ts (the daemon launches sessions with the same rule).
 */
export function effectiveClaudeDefaultAlias(
  configDir: string = process.env.CLAUDE_CONFIG_DIR || NodePath.join(NodeOS.homedir(), ".claude"),
): string {
  try {
    const m = JSON.parse(
      NodeFS.readFileSync(NodePath.join(configDir, "settings.json"), "utf8"),
    )?.model;
    if (typeof m === "string" && m.trim() && m.trim().toLowerCase() !== "default") return m.trim();
  } catch {
    /* none */
  }
  return "sonnet";
}

/** Map raw `supportedModels()` rows to validated `AgentModel`s (dropping malformed ones). */
export function mapClaudeModels(
  rows: ReadonlyArray<ClaudeModelInfo>,
  defaultAlias: string = effectiveClaudeDefaultAlias(),
): Array<typeof AgentModel.Type> {
  const out: Array<typeof AgentModel.Type> = [];
  let sawDefault = false;
  for (const row of rows) {
    const slug = str(row.value);
    if (!slug) continue;
    const resolved = str(row.resolvedModel);
    if (resolved && resolved !== slug && /^claude-/.test(resolved))
      claudeResolvedModels.set(slug, resolved);
    // Two SDK shapes. Older: displayName is just "Sonnet"/"Opus" and the version leads the description
    // ("Sonnet 5 · Efficient for routine tasks"). Newer (0.3.28x): displayName carries it ("Opus 5.5"), the description
    // is only a tagline, and the "default" row says what it runs in resolvedModel ("claude-sonnet-5-5").
    const display = str(row.displayName) ?? slug;
    const isDefaultRow = slug === "default";
    const description = str(row.description);
    const lead = description?.includes(" · ") ? description.split(" · ")[0]!.trim() : null;
    // Only a model name counts as a version: an API-key login's "default" row leads with "Use the default model
    // (currently Opus 5.5)", which has a digit and became the composer's model label (it squeezed Swarm out of a
    // narrow composer, swarm QA 2026-10-02).
    const versioned = (v: string | null) =>
      v && /\d/.test(v) && /^(claude[\s-]+)?(opus|sonnet|haiku|fable)\b/i.test(v)
        ? v.replace(" with 1M context", " (1M context)")
        : null;
    const version =
      versioned(lead) ??
      (isDefaultRow ? prettyClaudeId(str(row.resolvedModel)) : versioned(display)) ??
      null;
    const name = version ? (isDefaultRow ? `Default (${version})` : version) : display;
    // The trigger label: the real model for "Default", otherwise the same as the name.
    const shortName = version && isDefaultRow ? version : name.split(" (")[0]?.trim() || name;
    const levels =
      row.supportsEffort === true && Array.isArray(row.supportedEffortLevels)
        ? row.supportedEffortLevels.map((l) => str(l)).filter((l): l is string => l !== null)
        : [];
    // The SDK's "default" row is the recommended pick — make it the composer's preselected model.
    const isDefault = slug === "default" && !sawDefault;
    if (isDefault) sawDefault = true;
    const candidate = {
      slug,
      name,
      ...(shortName !== name ? { shortName } : {}),
      isCustom: false,
      ...(isDefault ? { isDefault: true } : {}),
      capabilities:
        levels.length > 0 ? claudeCapabilities(levels, pickDefaultEffort(levels)) : null,
    };
    try {
      out.push(Schema.decodeUnknownSync(AgentModel)(candidate));
    } catch {
      // A single malformed row must not sink the whole catalog.
    }
  }
  if (out.length > 0 && !out.some((m) => m.isDefault)) {
    out[0] = { ...out[0]!, isDefault: true };
  }
  // The Default row names (and launches) what the user's own setting says, not the SDK's Opus.
  const at = out.findIndex((m) => m.slug === "default");
  if (at >= 0) {
    const oneM = /\[1m\]$/i.test(defaultAlias);
    const base = defaultAlias.replace(/\[1m\]$/i, "");
    const fullId = /^claude-/.test(base) ? base : (claudeResolvedModels.get(base) ?? null);
    const aliasRow = out.find((m) => m.slug === base);
    const pretty =
      prettyClaudeId(fullId) ??
      (aliasRow ? (aliasRow.shortName ?? aliasRow.name) : null) ??
      (base ? base.charAt(0).toUpperCase() + base.slice(1) : null);
    if (fullId) claudeResolvedModels.set("default", `${fullId}${oneM ? "[1m]" : ""}`);
    if (pretty) {
      const shown = oneM ? `${pretty} (1M context)` : pretty;
      out[at] = { ...out[at]!, name: `Default · ${shown}`, shortName: shown };
    }
  }
  return out;
}

/**
 * Models the API serves that an older Claude Code's catalog does not list yet (the installed CLI 2.1.283 knows Haiku 4.5 but
 * not Haiku 5.5). A full id is passed to the API as it is, so these work even where `supportedModels()` is silent
 * (live check 2026-10-09: `claude -p --model claude-haiku-5-5` answers). Added only when the SDK catalog lacks the model, so
 * a newer Claude Code's own rows always win and new models appear without a release of ours.
 */
const KNOWN_CLAUDE_MODELS: ReadonlyArray<{ id: string; family: string; noEffort?: boolean }> = [
  { id: "claude-opus-5-5", family: "opus" },
  { id: "claude-sonnet-5-5", family: "sonnet" },
  { id: "claude-haiku-5-5", family: "haiku", noEffort: true },
];

/** Add the known models the catalog lacks, next to their family, with the effort levels a sibling row has. */
export function withKnownClaudeModels(
  models: ReadonlyArray<typeof AgentModel.Type>,
): Array<typeof AgentModel.Type> {
  const out = [...models];
  const have = (id: string) =>
    out.some(
      (m) =>
        m.slug === id || (m.slug !== "default" && claudeResolvedModels.get(m.slug)?.startsWith(id)),
    );
  const siblingLevels = out.find(
    (m) => m.capabilities && m.slug !== "default" && /sonnet|opus/i.test(m.slug),
  )?.capabilities;
  for (const k of KNOWN_CLAUDE_MODELS) {
    if (have(k.id)) continue;
    const name = prettyClaudeId(k.id)!;
    const candidate = {
      slug: k.id,
      name,
      isCustom: false,
      capabilities: k.noEffort || !siblingLevels ? null : siblingLevels,
    };
    let row: typeof AgentModel.Type;
    try {
      row = Schema.decodeUnknownSync(AgentModel)(candidate);
    } catch {
      continue;
    }
    // Next to its family (newest first), else at the end.
    const at = out.findIndex(
      (m) => m.slug !== "default" && (m.name ?? "").toLowerCase().startsWith(k.family),
    );
    if (at >= 0) out.splice(at, 0, row);
    else out.push(row);
  }
  return out;
}

/**
 * The composer's "Auto" row (runtime session/auto-model.ts): the daemon picks Haiku 5.5 for a thread whose first prompt is
 * light work (a question about the code, a lookup, a one-place edit, a chore) and the user's Default for everything else.
 * First in the list; its effort applies to the Default. Never a worker model (workerCatalog.ts drops it).
 */
export const AUTO_MODEL_SLUG = "auto";
/** Settings > Token savings > Auto model: while on, Auto is the preselected model for new Claude threads. */
let autoPreselected = false;
export function withAutoModel(
  models: ReadonlyArray<typeof AgentModel.Type>,
  preselect: boolean = autoPreselected,
): Array<typeof AgentModel.Type> {
  const base = models.filter((m) => m.slug !== AUTO_MODEL_SLUG);
  // Off (the default since 2026-10-19): no Auto row at all. A choice that silently runs the Default is a dead end.
  if (!preselect) return [...base];
  const dflt = base.find((m) => m.slug === "default") ?? base.find((m) => m.isDefault);
  let row: typeof AgentModel.Type;
  try {
    row = Schema.decodeUnknownSync(AgentModel)({
      slug: AUTO_MODEL_SLUG,
      name: "Auto · Haiku 5.5 for light work",
      shortName: "Auto",
      isCustom: false,
      capabilities: dflt?.capabilities ?? null,
    });
  } catch {
    return [...base];
  }
  if (!preselect) return [row, ...base];
  // the composer preselects the isDefault row: exactly one
  return [{ ...row, isDefault: true }, ...base.map((m) => (m.isDefault ? withoutDefault(m) : m))];
}
function withoutDefault(m: typeof AgentModel.Type): typeof AgentModel.Type {
  const { isDefault: _drop, ...rest } = m;
  return rest as typeof AgentModel.Type;
}
/**
 * Whether Auto is the preselected row: Settings › Auto model, overridden by the daemon's KORA_AUTO_MODEL the way the
 * runtime reads it (util/savings-settings.ts autoModelOn), so the picker never offers Auto while the runtime runs the Default.
 */
export function autoModelPreselect(
  setting: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const e = (env.KORA_AUTO_MODEL ?? "").trim().toLowerCase();
  if (e === "0" || e === "off" || e === "false") return false;
  if (e === "1" || e === "on" || e === "true") return true;
  return setting === true;
}
/** Flip the preselected Claude row to Auto (on) or back to Default (off) in the live catalog. True = it changed. */
export function setAutoPreselected(on: boolean): boolean {
  autoPreselected = on;
  const provider = daemonConfig.providers.find((p) => p.instanceId === CLAUDE_INSTANCE_ID);
  if (!provider) return false;
  const before = provider.models.find((m) => m.isDefault)?.slug;
  let next = withAutoModel(provider.models, on);
  if (!on && !next.some((m) => m.isDefault)) {
    const at = next.findIndex((m) => m.slug === "default");
    const i = at >= 0 ? at : next.findIndex((m) => m.slug !== AUTO_MODEL_SLUG);
    if (i >= 0) next = next.map((m, j) => (j === i ? { ...m, isDefault: true } : m));
  }
  (provider as { models: ReadonlyArray<typeof AgentModel.Type> }).models = next;
  return next.find((m) => m.isDefault)?.slug !== before;
}

/**
 * Detect the Claude catalog and patch it into `daemonConfig` in place. Runs once at boot, before the WS
 * server starts serving, so the connection snapshot carries the real models. No-op (keeps the fallback)
 * when the probe yields nothing.
 */
export async function applyClaudeModels(timeoutMs?: number): Promise<boolean> {
  const provider = daemonConfig.providers.find((p) => p.instanceId === CLAUDE_INSTANCE_ID);
  if (!provider) return true;
  let rows: ClaudeModelInfo[] | null = null;
  try {
    rows = await host().listClaudeModels(timeoutMs);
  } catch {
    rows = null;
  }
  if (!rows) {
    console.warn("[kora-daemon] claude model auto-detect: probe failed; keeping fallback list");
    return false;
  }
  const models = withAutoModel(withKnownClaudeModels(mapClaudeModels(rows)));
  if (models.length === 0) {
    console.warn("[kora-daemon] claude model auto-detect: no usable models; keeping fallback list");
    return false;
  }
  (provider as { models: ReadonlyArray<typeof AgentModel.Type> }).models = models;
  console.log(
    `[kora-daemon] claude model auto-detect: ${models.length} model(s) — ${models
      .map((m) => m.slug)
      .join(", ")}`,
  );
  return true;
}
