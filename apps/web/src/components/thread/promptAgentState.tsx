import {
  shouldRenderTraitsControls,
  type TraitsMenuContentProps,
  TraitsInlineControls,
} from "./TraitsPicker";
import type { PromptControlSize } from "./PromptControl";
import type { DraftId } from "../../stores/promptDraftStore";
import { getAgentModelCapabilities } from "../../agentModels";
import {
  buildExplicitAgentOptionSelectionsFromDescriptors,
  getAgentOptionDescriptors,
  isClaudeUltrathinkPrompt,
  canonicalModelSlug,
} from "@kora/shared/modelOptions";
import type {
  AgentOptionSelection,
  ModelCapabilities,
  HostThreadRef,
  AgentProfileId,
  AgentModel,
  AgentId,
} from "@kora/contracts";
import type { ReactNode } from "react";

export type PromptInjectionState = "none" | "ultrathink";

export type PromptAgentStateInput = {
  provider: AgentId;
  model: string;
  models: ReadonlyArray<AgentModel>;
  promptInjectionState?: PromptInjectionState;
  modelOptions: ReadonlyArray<AgentOptionSelection> | null | undefined;
  planModeEnabled: boolean;
};

export type PromptAgentState = {
  modelOptionsForDispatch: ReadonlyArray<AgentOptionSelection> | undefined;
  modelPickerIconClassName?: string;
  composerSurfaceClassName?: string;
  composerFrameClassName?: string;
  promptEffort: string | null;
  provider: AgentId;
};

export type TraitsRenderInput = {
  modelOptions: ReadonlyArray<AgentOptionSelection> | undefined;
  triggerVariant?: TraitsMenuContentProps["triggerVariant"];
  onPromptChange: (prompt: string) => void;
  models: ReadonlyArray<AgentModel>;
  threadRef?: HostThreadRef;
  instanceId?: AgentProfileId;
  triggerClassName?: string;
  isComposerOwned?: boolean;
  size?: PromptControlSize;
  planModeEnabled: boolean;
  provider: AgentId;
  draftId?: DraftId;
  hidden?: boolean;
  prompt: string;
  model: string;
};

export function getPromptInjectionState(prompt: string): PromptInjectionState {
  if (isClaudeUltrathinkPrompt(prompt)) {
    return "ultrathink";
  }
  return "none";
}

/**
 * Providers may report Fast as on by default. Kora treats it as selected only when the user chose it, so an
 * explicit `false` goes out for models that offer it; that also overrides a previous Fast session.
 */
export function withImplicitFastModeDefault(
  capabilities: ModelCapabilities,
  modelOptions: ReadonlyArray<AgentOptionSelection> | null | undefined,
): ReadonlyArray<AgentOptionSelection> | undefined {
  const chosen = modelOptions ?? undefined;
  if (chosen?.some((selection) => selection.id === "fastMode")) return chosen;
  const fastOffered = (capabilities.optionDescriptors ?? []).some(
    (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
  );
  return fastOffered ? [...(chosen ?? []), { id: "fastMode", value: false }] : chosen;
}

/**
 * OpenCode models missing from the catalog have no descriptors to validate against, so the saved
 * options go out as they are, minus a plan agent when plan mode is off.
 */
function uncataloguedOpenCodeOptions(
  modelOptions: ReadonlyArray<AgentOptionSelection> | null | undefined,
  planModeEnabled: boolean,
): ReadonlyArray<AgentOptionSelection> | undefined {
  const isPlanAgent = (selection: AgentOptionSelection) =>
    selection.id === "agent" && selection.value === "plan";
  const kept = (modelOptions ?? []).filter(
    (selection) => planModeEnabled || !isPlanAgent(selection),
  );
  return kept.length === 0 ? undefined : kept;
}

export function getPromptAgentState(input: PromptAgentStateInput): PromptAgentState {
  const { provider, model, models, modelOptions, planModeEnabled } = input;
  const uncatalogued =
    provider === "opencode" &&
    !models.some((entry) => entry.slug === canonicalModelSlug(model, provider));
  if (uncatalogued) {
    return {
      modelOptionsForDispatch: uncataloguedOpenCodeOptions(modelOptions, planModeEnabled),
      promptEffort: null,
      provider,
    };
  }

  const caps = getAgentModelCapabilities(models, model, provider, planModeEnabled);
  const selections = withImplicitFastModeDefault(caps, modelOptions);
  const descriptors = getAgentOptionDescriptors({ caps, selections: selections ?? null });
  const primarySelect = descriptors.find((descriptor) => descriptor.type === "select");
  const current = primarySelect?.currentValue;

  const state: PromptAgentState = {
    provider,
    promptEffort: typeof current === "string" ? current : null,
    modelOptionsForDispatch: buildExplicitAgentOptionSelectionsFromDescriptors(
      descriptors,
      selections ?? null,
    ),
  };

  const promptInjected =
    primarySelect?.type === "select" && (primarySelect.promptInjectedValues?.length ?? 0) > 0;
  if (promptInjected && (input.promptInjectionState ?? "none") === "ultrathink") {
    state.composerFrameClassName = "deep-think-frame";
    state.composerSurfaceClassName = "shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]";
    state.modelPickerIconClassName = "deep-think-chroma";
  }
  return state;
}

export function renderAgentTraitsInlineControls(
  input: TraitsRenderInput & { className?: string },
): ReactNode {
  if (!input.threadRef && !input.draftId) return null;
  const implicitOptions = withImplicitFastModeDefault(
    getAgentModelCapabilities(input.models, input.model, input.provider, input.planModeEnabled),
    input.modelOptions,
  );
  if (
    !shouldRenderTraitsControls({
      provider: input.provider,
      models: input.models,
      model: input.model,
      prompt: input.prompt,
      modelOptions: implicitOptions,
      planModeEnabled: input.planModeEnabled,
    })
  ) {
    return null;
  }
  return (
    <TraitsInlineControls
      {...(input.className ? { className: input.className } : {})}
      {...(input.draftId ? { draftId: input.draftId } : {})}
      {...(input.instanceId ? { instanceId: input.instanceId } : {})}
      {...(input.threadRef ? { threadRef: input.threadRef } : {})}
      model={input.model}
      modelOptions={implicitOptions}
      models={input.models}
      onPromptChange={input.onPromptChange}
      planModeEnabled={input.planModeEnabled}
      prompt={input.prompt}
      provider={input.provider}
    />
  );
}
