import { cn } from "~/util/utils";
import { Hint } from "~/components/ui/hint";
import { usePromptMenuState } from "./usePromptMenuState";
import { usePromptMenuProps } from "./promptEventScope";
import {
  PromptControlChevron,
  PromptControlIcon,
  type PromptControlSize,
  PromptControl,
} from "./PromptControl";
import {
  MenuPopup,
  Menu,
  MenuTrigger,
  MenuSeparator,
  MenuRadioItem,
  MenuRadioGroup,
} from "../ui/menu";
import type { buttonVariants } from "../ui/button";
import { Badge } from "../ui/badge";
import { usePromptDraftStore, type DraftId } from "../../stores/promptDraftStore";
import { getAgentModelCapabilities } from "../../agentModels";
import {
  buildAgentOptionSelectionsFromDescriptors,
  prefixClaudeEffort,
  getAgentOptionCurrentLabel,
  getAgentOptionCurrentValue,
  getAgentOptionDescriptors,
  isClaudeUltrathinkPrompt,
  canonicalModelSlug,
} from "@kora/shared/modelOptions";
import type { HostThreadRef } from "@kora/contracts";
import type {
  AgentOptionDescriptor,
  AgentOptionSelection,
  AgentProfileId,
  AgentModel,
  AgentId,
} from "@kora/contracts";
import { useCallback, useMemo, memo } from "react";
import { EffortSlosh } from "./EffortSlosh";
import { ZapIcon } from "lucide-react";

type AgentOptions = ReadonlyArray<AgentOptionSelection>;
type SelectDescriptor = Extract<AgentOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<AgentOptionDescriptor, { type: "boolean" }>;
type ButtonVariant = NonNullable<Parameters<typeof buttonVariants>[0]>["variant"];

// ---------------------------------------------------------------------------
// Saved selections of a model that is no longer listed

const SAVED_LABELS: Record<string, string> = {
  variant: "Reasoning",
  reasoningEffort: "Reasoning effort",
  effort: "Effort",
  agent: "Agent",
};

function savedLabel(id: string): string {
  const known = SAVED_LABELS[id];
  if (known) return known;
  const spaced = id.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function buildUnavailableModelOptionDescriptors(
  selections: AgentOptions | null | undefined,
): ReadonlyArray<AgentOptionDescriptor> {
  return (selections ?? []).map((selection): AgentOptionDescriptor => {
    const label = savedLabel(selection.id);
    if (typeof selection.value === "boolean") {
      return { id: selection.id, label, type: "boolean", currentValue: selection.value };
    }
    return {
      id: selection.id,
      label,
      type: "select",
      options: [{ id: selection.value, label: selection.value }],
      currentValue: selection.value,
    };
  });
}

// ---------------------------------------------------------------------------
// Trait derivation

export type TraitsPersistence =
  | { threadRef?: HostThreadRef; draftId?: DraftId; onModelOptionsChange?: never }
  | { threadRef?: undefined; onModelOptionsChange: (next: AgentOptions | undefined) => void };

type TraitsInput = {
  provider: AgentId;
  models: ReadonlyArray<AgentModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: AgentOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  planModeEnabled: boolean;
};

const ULTRATHINK_PREFIX = /^Ultrathink:\s*/;

function deriveTraits(input: TraitsInput) {
  const { provider, models, model, prompt, modelOptions, planModeEnabled } = input;
  const caps = getAgentModelCapabilities(models, model, provider, planModeEnabled);

  const slug = canonicalModelSlug(model, provider);
  const unavailable = provider === "opencode" && !models.some((entry) => entry.slug === slug);

  let descriptors: ReadonlyArray<AgentOptionDescriptor>;
  if (unavailable) {
    const saved = (modelOptions ?? []).filter(
      (selection) => planModeEnabled || !(selection.id === "agent" && selection.value === "plan"),
    );
    descriptors = buildUnavailableModelOptionDescriptors(saved);
  } else {
    descriptors = getAgentOptionDescriptors({ caps, selections: modelOptions ?? null });
  }

  const selects = descriptors.filter((d): d is SelectDescriptor => d.type === "select");
  const booleans = descriptors.filter((d): d is BooleanDescriptor => d.type === "boolean");
  const primary = selects[0];
  const contextWindow = selects.find((d) => d.id === "contextWindow");
  const agent = selects.find((d) => d.id === "agent");
  const fastMode = booleans.find((d) => d.id === "fastMode");
  const thinking = booleans.find((d) => d.id === "thinking");

  const allowInjected = input.allowPromptInjectedEffort ?? true;
  const promptControlled =
    allowInjected &&
    !!primary &&
    (primary.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);
  const inBodyText =
    promptControlled && isClaudeUltrathinkPrompt(prompt.replace(ULTRATHINK_PREFIX, ""));

  const hasAnyControls =
    !!primary ||
    !!thinking ||
    !!fastMode ||
    !!contextWindow ||
    !!agent ||
    (unavailable && descriptors.length > 0);

  return {
    unavailable,
    descriptors,
    selects,
    booleans,
    primary,
    promptControlled,
    inBodyText,
    hasAnyControls,
  };
}

export function shouldRenderTraitsControls(input: TraitsInput): boolean {
  return deriveTraits(input).hasAnyControls;
}

// ---------------------------------------------------------------------------
// Trigger label

export function buildTraitsTriggerDisplay(input: {
  provider: AgentId;
  descriptors: ReadonlyArray<AgentOptionDescriptor>;
  primarySelectDescriptorId: string | null;
  ultrathinkPromptControlled: boolean;
}): { label: string; showFastModeIcon: boolean } {
  const labels: string[] = [];
  let fast: { enabled: boolean; fallback: string } | null = null;

  for (const descriptor of input.descriptors) {
    if (descriptor.type === "boolean" && descriptor.id === "fastMode") {
      const enabled = descriptor.currentValue === true;
      fast = { enabled, fallback: enabled ? "Fast" : "Normal" };
      continue;
    }
    if (
      input.provider === "codex" &&
      descriptor.type === "select" &&
      descriptor.id === "serviceTier"
    ) {
      const fastOption = descriptor.options.find((option) => option.label === "Fast");
      const current = getAgentOptionCurrentValue(descriptor);
      if (fastOption && (current === "default" || current === fastOption.id)) {
        const enabled = current === fastOption.id;
        fast = {
          enabled,
          fallback: getAgentOptionCurrentLabel(descriptor) ?? (enabled ? "Fast" : "Normal"),
        };
        continue;
      }
    }

    let label: string | undefined;
    if (input.ultrathinkPromptControlled && descriptor.id === input.primarySelectDescriptorId) {
      label = "Ultrathink";
    } else if (descriptor.type === "boolean") {
      label =
        descriptor.currentValue === undefined
          ? undefined
          : `${descriptor.label} ${descriptor.currentValue ? "On" : "Off"}`;
    } else {
      label = getAgentOptionCurrentLabel(descriptor);
    }
    if (label) labels.push(label);
  }

  if (labels.length === 0 && fast) return { label: fast.fallback, showFastModeIcon: false };
  return { label: labels.join(" · "), showFastModeIcon: fast?.enabled === true };
}

// ---------------------------------------------------------------------------
// Editing

export interface TraitsMenuContentProps {
  modelOptions?: AgentOptions | null | undefined;
  onPromptChange: (prompt: string) => void;
  allowPromptInjectedEffort?: boolean;
  models: ReadonlyArray<AgentModel>;
  model: string | null | undefined;
  triggerVariant?: ButtonVariant;
  instanceId?: AgentProfileId;
  triggerClassName?: string;
  isComposerOwned?: boolean;
  planModeEnabled: boolean;
  provider: AgentId;
  prompt: string;
}

export interface TraitsInlineControlsProps {
  modelOptions?: AgentOptions | null | undefined;
  onPromptChange: (prompt: string) => void;
  allowPromptInjectedEffort?: boolean;
  models: ReadonlyArray<AgentModel>;
  model: string | null | undefined;
  instanceId?: AgentProfileId;
  planModeEnabled: boolean;
  className?: string;
  provider: AgentId;
  prompt: string;
}

function useTraitsEditing(props: TraitsMenuContentProps & TraitsPersistence) {
  const { provider, instanceId, model, prompt, onPromptChange } = props;
  const traits = useMemo(
    () =>
      deriveTraits({
        provider,
        models: props.models,
        model,
        prompt,
        modelOptions: props.modelOptions,
        planModeEnabled: props.planModeEnabled,
        ...(props.allowPromptInjectedEffort === undefined
          ? {}
          : { allowPromptInjectedEffort: props.allowPromptInjectedEffort }),
      }),
    [
      provider,
      props.models,
      model,
      prompt,
      props.modelOptions,
      props.planModeEnabled,
      props.allowPromptInjectedEffort,
    ],
  );

  const setProviderModelOptions = usePromptDraftStore((store) => store.setProviderModelOptions);
  const target = props.threadRef ?? ("draftId" in props ? props.draftId : undefined);
  const onModelOptionsChange = props.onModelOptionsChange;

  const persist = useCallback(
    (next: AgentOptions | undefined) => {
      if (onModelOptionsChange) {
        onModelOptionsChange(next);
        return;
      }
      if (!target) return;
      setProviderModelOptions(target, provider, next, {
        ...(instanceId ? { instanceId } : {}),
        ...(model ? { model } : {}),
        persistSticky: true,
      });
    },
    [onModelOptionsChange, target, setProviderModelOptions, provider, instanceId, model],
  );

  const changeSelect = useCallback(
    (descriptor: SelectDescriptor, value: string) => {
      if (!value) return;
      if (descriptor.promptInjectedValues?.includes(value)) {
        onPromptChange(
          prompt.trim().length === 0 ? "Ultrathink:\n" : prefixClaudeEffort(prompt, "ultrathink"),
        );
        return;
      }
      const isPrimary = descriptor.id === traits.primary?.id;
      if (traits.inBodyText && isPrimary) return;
      if (traits.promptControlled && isPrimary) {
        onPromptChange(prompt.replace(ULTRATHINK_PREFIX, ""));
      }
      const next = traits.descriptors.map((entry) =>
        entry.id === descriptor.id ? { ...entry, currentValue: value } : entry,
      ) as AgentOptionDescriptor[];
      persist(buildAgentOptionSelectionsFromDescriptors(next));
    },
    [onPromptChange, prompt, traits, persist],
  );

  const changeBoolean = useCallback(
    (descriptor: BooleanDescriptor, value: boolean) => {
      const next = traits.descriptors.map((entry) =>
        entry.id === descriptor.id ? { ...entry, currentValue: value } : entry,
      ) as AgentOptionDescriptor[];
      persist(buildAgentOptionSelectionsFromDescriptors(next));
    },
    [traits, persist],
  );

  return { traits, changeSelect, changeBoolean };
}

// ---------------------------------------------------------------------------
// Menu

const GROUP_LABEL = "px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs";

function DefaultBadge() {
  return (
    <Badge
      className="h-4 border-border/70 bg-muted/60 px-1.5 font-semibold text-[10px] text-muted-foreground"
      variant="outline"
    >
      Default
    </Badge>
  );
}

const menuBodyCls1 = "max-w-56 text-pretty text-muted-foreground/80 text-xs";

function MenuBody(props: TraitsMenuContentProps & TraitsPersistence) {
  const { traits, changeSelect, changeBoolean } = useTraitsEditing(props);
  if (!traits.hasAnyControls) return null;

  if (traits.unavailable) {
    return (
      <>
        {traits.descriptors.map((descriptor, index) => {
          const value = getAgentOptionCurrentLabel(descriptor);
          if (!value) return null;
          return (
            <div key={descriptor.id}>
              {index > 0 ? <MenuSeparator /> : null}
              <div className={GROUP_LABEL}>{descriptor.label}</div>
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">{value}</div>
            </div>
          );
        })}
      </>
    );
  }

  let rendered = 0;
  const groups: React.ReactNode[] = [];

  for (const descriptor of traits.selects) {
    const isPrimary = descriptor.id === traits.primary?.id;
    const locked = traits.inBodyText && isPrimary;
    const value =
      traits.promptControlled && isPrimary
        ? "ultrathink"
        : String(getAgentOptionCurrentValue(descriptor) ?? "");
    groups.push(
      <div key={descriptor.id}>
        {rendered++ > 0 ? <MenuSeparator /> : null}
        <div className={GROUP_LABEL}>{descriptor.label}</div>
        {locked ? (
          <p className="px-2 pb-1 text-muted-foreground/80 text-xs">
            Your prompt contains "ultrathink" in the text. Remove it to change this option.
          </p>
        ) : null}
        <MenuRadioGroup
          onValueChange={(next) => changeSelect(descriptor, String(next))}
          value={value}
        >
          {descriptor.options.map((option) => (
            <MenuRadioItem
              closeOnClick
              disabled={locked}
              hideIndicator
              key={option.id}
              value={option.id}
            >
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-2">
                  <span className="truncate">{option.label}</span>
                  {option.isDefault ? <DefaultBadge /> : null}
                </span>
                {option.description ? (
                  <span className={menuBodyCls1}>{option.description}</span>
                ) : null}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </div>,
    );
  }

  for (const descriptor of traits.booleans) {
    groups.push(
      <div key={descriptor.id}>
        {rendered++ > 0 ? <MenuSeparator /> : null}
        <div className={GROUP_LABEL}>{descriptor.label}</div>
        <MenuRadioGroup
          onValueChange={(next) => changeBoolean(descriptor, next === "on")}
          value={descriptor.currentValue === true ? "on" : "off"}
        >
          <MenuRadioItem closeOnClick hideIndicator value="on">
            On
          </MenuRadioItem>
          <MenuRadioItem closeOnClick hideIndicator value="off">
            Off
          </MenuRadioItem>
        </MenuRadioGroup>
      </div>,
    );
  }
  return <>{groups}</>;
}

// ---------------------------------------------------------------------------
// Inline (inside popovers, where there is no Menu context)

const SEGMENT_BASE =
  "whitespace-nowrap rounded-[calc(var(--control-radius)-2px)] px-2 py-1 font-medium text-xs transition-colors";

function Segmented({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2 py-1">
      <span className="shrink-0 font-medium text-muted-foreground text-xs">{label}</span>
      <div
        aria-label={label}
        className="flex flex-wrap justify-end gap-0.5 rounded-[var(--control-radius)] border border-border/60 bg-muted/30 p-0.5"
        role="radiogroup"
      >
        {children}
      </div>
    </div>
  );
}

function Segment({
  checked,
  disabled,
  onSelect,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-checked={checked}
      className={cn(
        SEGMENT_BASE,
        checked
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        disabled && "pointer-events-none opacity-60",
      )}
      disabled={disabled}
      onClick={onSelect}
      role="radio"
      type="button"
    >
      {children}
    </button>
  );
}

const isEffortDescriptor = (descriptor: AgentOptionDescriptor) =>
  descriptor.type === "select" &&
  (descriptor.id === "effort" || descriptor.id === "reasoningEffort");

export const TraitsInlineControls = memo(function TraitsInlineControls(
  props: TraitsInlineControlsProps & TraitsPersistence,
) {
  const { traits, changeSelect, changeBoolean } = useTraitsEditing(props);
  if (!traits.hasAnyControls) return null;

  if (traits.unavailable) {
    return (
      <div className={cn("flex flex-col gap-1", props.className)}>
        {traits.descriptors.map((descriptor) => {
          const value = getAgentOptionCurrentLabel(descriptor);
          if (!value) return null;
          return (
            <div className="flex items-center justify-between gap-3 px-2 py-1" key={descriptor.id}>
              <span className="font-medium text-muted-foreground text-xs">{descriptor.label}</span>
              <span className="text-muted-foreground/80 text-xs">{value}</span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1", props.className)}>
      {traits.selects.map((descriptor) => {
        const isPrimary = descriptor.id === traits.primary?.id;
        const locked = traits.inBodyText && isPrimary;
        const value =
          traits.promptControlled && isPrimary
            ? "ultrathink"
            : String(getAgentOptionCurrentValue(descriptor) ?? "");
        if (isEffortDescriptor(descriptor)) {
          // Claude's "ultrathink" is a prompt prefix, not a level: it stays off the slider and is said above it.
          const injected = new Set(descriptor.promptInjectedValues ?? []);
          const levels = descriptor.options.filter((option) => !injected.has(option.id));
          if (levels.length >= 2) {
            return (
              <EffortSlosh
                disabled={locked}
                key={descriptor.id}
                levels={levels}
                note={
                  injected.has(value)
                    ? "Ultrathink is on from the prompt"
                    : locked
                      ? "set in the prompt text"
                      : undefined
                }
                onChange={(id) => changeSelect(descriptor, id)}
                value={injected.has(value) ? null : value}
              />
            );
          }
        }
        return (
          <Segmented key={descriptor.id} label={descriptor.label}>
            {descriptor.options.map((option) => (
              <Hint
                key={option.id}
                label={option.isDefault ? `${option.label} (Default)` : option.label}
              >
                <Segment
                  checked={value === option.id}
                  disabled={locked}
                  onSelect={() => changeSelect(descriptor, option.id)}
                >
                  {option.label}
                  {option.isDefault ? (
                    <span
                      aria-hidden="true"
                      className="ms-1 inline-block size-1 rounded-full bg-current opacity-60"
                    />
                  ) : null}
                </Segment>
              </Hint>
            ))}
          </Segmented>
        );
      })}
      {traits.booleans.map((descriptor) => (
        <Segmented key={descriptor.id} label={descriptor.label}>
          <Segment
            checked={descriptor.currentValue === true}
            onSelect={() => changeBoolean(descriptor, true)}
          >
            On
          </Segment>
          <Segment
            checked={descriptor.currentValue !== true}
            onSelect={() => changeBoolean(descriptor, false)}
          >
            Off
          </Segment>
        </Segmented>
      ))}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Trigger

export const TraitsPicker = memo(function TraitsPicker(
  props: TraitsMenuContentProps &
    TraitsPersistence & { size?: PromptControlSize; hidden?: boolean },
) {
  const { size = "sm", hidden = false, provider } = props;
  const { traits } = useTraitsEditing(props);
  const [open, setOpen] = usePromptMenuState(hidden);
  const menuProps = usePromptMenuProps();
  const display = buildTraitsTriggerDisplay({
    provider,
    descriptors: traits.descriptors,
    primarySelectDescriptorId: traits.primary?.id ?? null,
    ultrathinkPromptControlled: traits.promptControlled,
  });

  if (!traits.hasAnyControls) return null;

  const codex = provider === "codex";
  const boltColor = size === "xs" ? "text-current" : "text-foreground";

  const content = (
    <>
      {display.showFastModeIcon ? (
        <>
          <PromptControlIcon
            className={cn("fill-current opacity-80", boltColor)}
            icon={ZapIcon}
            size={size}
          />
          <span className="sr-only">Fast mode on</span>
        </>
      ) : null}
      <span className={cn(codex && "truncate")}>{display.label}</span>
      <PromptControlChevron size={size} />
    </>
  );

  return (
    <Menu onOpenChange={setOpen} open={open}>
      <MenuTrigger
        render={
          <PromptControl
            className={cn(
              codex
                ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap sm:max-w-48"
                : "shrink-0 whitespace-nowrap",
              props.triggerClassName,
            )}
            size={size}
            variant={props.triggerVariant ?? "ghost"}
          />
        }
      >
        {codex ? (
          <span className={cn("flex min-w-0 items-center", size === "xs" ? "gap-1" : "gap-1.5")}>
            {content}
          </span>
        ) : (
          content
        )}
      </MenuTrigger>
      <MenuPopup align="start" {...(props.isComposerOwned ? menuProps : {})}>
        <MenuBody {...props} />
      </MenuPopup>
    </Menu>
  );
});
