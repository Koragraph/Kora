import {
  type ModelCapabilities,
  type AgentStatus,
  type AgentProfileId,
  type AgentModel,
  AgentId,
  defaultProfileIdForDriver,
  DEFAULT_MODEL_BY_AGENT,
  DEFAULT_MODEL,
} from "@kora/contracts";
import { createModelCapabilities, resolveSelectableModel } from "@kora/shared/modelOptions";

const FALLBACK_AGENT = AgentId.make("codex");

/** "claudeCode" / "claude_code" -> "Claude Code". */
export function formatAgentIdLabel(vendor: AgentId): string {
  return String(vendor)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** Models of the built-in (default) instance for a driver; custom instances are never consulted. */
export function getAgentModels(
  provs: ReadonlyArray<AgentStatus>,
  vendor: AgentId,
): ReadonlyArray<AgentModel> {
  const wanted = defaultProfileIdForDriver(vendor);
  return provs.find((agent) => agent.instanceId === wanted)?.models ?? [];
}

export function resolveSelectableAgent(
  provs: ReadonlyArray<AgentStatus>,
  vendor: AgentId | AgentProfileId | null | undefined,
): AgentId {
  const requested = provs.find((agent) => agent.instanceId === vendor);
  if (requested?.enabled) return requested.driver;
  return provs.find((agent) => agent.enabled)?.driver ?? FALLBACK_AGENT;
}

const EMPTY_OPTIONS = (): ModelCapabilities => createModelCapabilities({ optionDescriptors: [] });

/** Drops the opencode "plan" agent option, repairing currentValue so it cannot name it. */
function withoutPlanOption(caps: ModelCapabilities): ModelCapabilities {
  const descriptors = (caps.optionDescriptors ?? []).flatMap((descriptor) => {
    if (descriptor.type !== "select" || descriptor.id !== "agent") return [descriptor];
    const opts = descriptor.options.filter((obj) => obj.id !== "plan");
    if (opts.length === 0) return [];
    const { currentValue: _stale, ...rest } = descriptor;
    const live =
      descriptor.currentValue !== undefined &&
      opts.some((obj) => obj.id === descriptor.currentValue)
        ? descriptor.currentValue
        : (opts.find((obj) => obj.isDefault)?.id ?? opts[0]?.id);
    return [
      live === undefined
        ? { ...rest, options: opts }
        : { ...rest, options: opts, currentValue: live },
    ];
  });
  return { ...caps, optionDescriptors: descriptors };
}

export function getAgentModelCapabilities(
  models: ReadonlyArray<AgentModel>,
  model: string | null | undefined,
  vendor: AgentId,
  planModeEnabled = true,
): ModelCapabilities {
  const idSlug = resolveSelectableModel(vendor, model, models);
  const caps = models.find((entry) => entry.slug === idSlug)?.capabilities ?? EMPTY_OPTIONS();
  return planModeEnabled ? caps : withoutPlanOption(caps);
}

export function getDefaultDaemonModel(provs: ReadonlyArray<AgentStatus>, vendor: AgentId): string {
  const models = getAgentModels(provs, vendor);
  const choice =
    models.find((entry) => entry.isDefault && !entry.isCustom) ??
    models.find((entry) => !entry.isCustom) ??
    models[0];
  return choice?.slug ?? DEFAULT_MODEL_BY_AGENT[vendor] ?? DEFAULT_MODEL;
}
