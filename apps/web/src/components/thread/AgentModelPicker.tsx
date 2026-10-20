import { cn } from "~/util/utils";
import { usePromptMenuProps } from "./promptEventScope";
import { renderAgentTraitsInlineControls, type TraitsRenderInput } from "./promptAgentState";
import {
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
  type ModelEsque,
} from "./agentIconUtils";
import { PromptControlChevron, type PromptControlSize, PromptControl } from "./PromptControl";
import { resolveModelPickerSelectedModel, ModelPickerContent } from "./ModelPickerContent";
import { AgentProfileIcon } from "./AgentProfileIcon";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { PopoverTrigger, PopoverPopup, Popover } from "../ui/popover";
import type { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { shouldShowInstanceBadge, type AgentProfileEntry } from "../../agentProfiles";
import { ANTIGRAVITY_DEFAULT_MODEL, type AgentProfileId, type AgentId } from "@kora/contracts";
import { type ComponentProps, useCallback, useEffect, useState, useMemo, memo } from "react";

type ButtonVariant = NonNullable<ComponentProps<typeof Button>["variant"]>;

type Props = {
  whyModelDisabled?: (instanceId: AgentProfileId, model: string) => string | null;
  modelOptionsByInstance: ReadonlyMap<AgentProfileId, ReadonlyArray<ModelEsque>>;
  onInstanceModelChange: (instanceId: AgentProfileId, model: string) => void;
  onOpenProviderSetup?: (instanceId: AgentProfileId) => void;
  instanceEntries: ReadonlyArray<AgentProfileEntry>;
  lockedContinuationGroupKey?: string | null;
  onOpenChange?: (open: boolean) => void;
  instanceIndicatorBackground?: string;
  activeProviderIconClassName?: string;
  activeInstanceId: AgentProfileId;
  triggerVariant?: ButtonVariant;
  lockedProvider: AgentId | null;
  traits?: TraitsRenderInput;
  triggerClassName?: string;
  triggerAriaLabel?: string;
  isComposerOwned?: boolean;
  size?: PromptControlSize;
  triggerLabel?: string;
  disabled?: boolean;
  open?: boolean;
  model: string;
};

/** While the popover is open the page behind it must not scroll, only the model list may. */
function useBackgroundScrollLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const root = document.documentElement;
    const body = document.body;
    const previous = {
      overscroll: root.style.overscrollBehavior,
      overflow: body.style.overflow,
      paddingRight: body.style.paddingRight,
    };
    const scrollbarWidth = window.innerWidth - root.clientWidth;
    root.style.overscrollBehavior = "contain";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      const current = Number.parseFloat(getComputedStyle(body).paddingRight) || 0;
      body.style.paddingRight = `${current + scrollbarWidth}px`;
    }
    const swallow = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-model-picker-content]")) return;
      event.preventDefault();
    };
    const options = { capture: true, passive: false } as const;
    document.addEventListener("wheel", swallow, options);
    document.addEventListener("touchmove", swallow, options);
    return () => {
      document.removeEventListener("wheel", swallow, options);
      document.removeEventListener("touchmove", swallow, options);
      root.style.overscrollBehavior = previous.overscroll;
      body.style.overflow = previous.overflow;
      body.style.paddingRight = previous.paddingRight;
    };
  }, [active]);
}

export const AgentModelPicker = memo(function AgentModelPicker(props: Props) {
  const {
    activeInstanceId,
    model,
    lockedProvider,
    lockedContinuationGroupKey = null,
    instanceEntries,
    modelOptionsByInstance,
    size = "sm",
    isComposerOwned = false,
    disabled = false,
    triggerVariant = "ghost",
    onInstanceModelChange,
  } = props;

  const [internalOpen, setInternalOpen] = useState(false);
  const open = (props.open ?? internalOpen) && !disabled;
  const { onOpenChange } = props;
  const setOpen = useCallback(
    (next: boolean) => {
      const resolved = next && !disabled;
      setInternalOpen(resolved);
      onOpenChange?.(resolved);
    },
    [disabled, onOpenChange],
  );
  useBackgroundScrollLock(open);
  const menuProps = usePromptMenuProps();

  const activeEntry = useMemo(
    () => instanceEntries.find((entry) => entry.instanceId === activeInstanceId),
    [activeInstanceId, instanceEntries],
  );
  const options = modelOptionsByInstance.get(activeInstanceId) ?? [];
  const driverKind = activeEntry?.driverKind;
  const selected =
    resolveModelPickerSelectedModel({ driverKind, model, options }) ??
    (driverKind === "opencode" || driverKind === "antigravity" ? undefined : options[0]);

  const title = selected
    ? getTriggerDisplayModelName(selected)
    : model === ANTIGRAVITY_DEFAULT_MODEL
      ? "Choose model"
      : model || "Choose model";
  const unavailable = selected?.isUnavailable === true;
  const baseLabel = selected
    ? `${getTriggerDisplayModelLabel(selected)}${unavailable ? " (Unavailable)" : ""}`
    : title;

  const visibleText = props.triggerLabel ?? title;
  const tooltipText = props.triggerLabel ?? baseLabel;

  const handleSelect = useCallback(
    (instanceId: AgentProfileId, nextModel: string) => {
      if (disabled) return;
      onInstanceModelChange(instanceId, nextModel);
      setOpen(false);
    },
    [disabled, onInstanceModelChange, setOpen],
  );

  const showIcon = props.triggerLabel === undefined && activeEntry !== undefined;
  const traitsFooter = props.traits
    ? renderAgentTraitsInlineControls({
        ...props.traits,
        className: "min-w-0",
      })
    : null;

  const trigger = (
    <PromptControl
      {...(props.triggerAriaLabel ? { "aria-label": props.triggerAriaLabel } : {})}
      className={cn(
        "min-w-0 shrink justify-between whitespace-nowrap",
        size === "xs" ? "gap-1" : "gap-1.5",
        !isComposerOwned && "max-w-48 sm:max-w-56",
        props.triggerClassName,
      )}
      data-agent-model-picker="true"
      disabled={disabled}
      size={size}
      variant={triggerVariant}
    >
      {showIcon && activeEntry ? (
        <AgentProfileIcon
          accentColor={activeEntry.accentColor}
          badgeClassName="h-3.5 min-w-3.5 text-[10px] -right-1 -bottom-1"
          className="size-4"
          displayName={activeEntry.displayName}
          driverKind={activeEntry.driverKind}
          iconClassName={cn("size-4", props.activeProviderIconClassName)}
          showBadge={shouldShowInstanceBadge(activeEntry, instanceEntries)}
          {...(props.instanceIndicatorBackground
            ? { indicatorBackground: props.instanceIndicatorBackground }
            : {})}
        />
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="min-w-0 flex-1 truncate text-left"
              data-agent-model-picker-label="true"
            />
          }
        >
          {visibleText}
        </TooltipTrigger>
        <TooltipPopup side="top">{tooltipText}</TooltipPopup>
      </Tooltip>
      {unavailable && props.triggerLabel === undefined ? (
        <Badge size="sm" variant="outline">
          Unavailable
        </Badge>
      ) : null}
      <PromptControlChevron size={size} />
    </PromptControl>
  );

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger render={trigger} />
      <PopoverPopup
        align="start"
        className="rounded-[calc(var(--radius-lg)-1px)] [clip-path:inset(0_round_calc(var(--radius-lg)-1px))]"
        viewportClassName="overflow-hidden [--viewport-inline-padding:0px] p-0 w-[min(calc(100vw-16px),23rem)]"
        {...(isComposerOwned ? menuProps : {})}
      >
        <div
          className="flex max-h-[min(var(--available-height),30rem)] min-h-0 w-full flex-col"
          data-model-picker-content
        >
          <div className="min-h-0 flex-1">
            <ModelPickerContent
              activeInstanceId={activeInstanceId}
              {...(props.whyModelDisabled ? { whyModelDisabled: props.whyModelDisabled } : {})}
              instanceEntries={instanceEntries}
              lockedContinuationGroupKey={lockedContinuationGroupKey}
              lockedProvider={lockedProvider}
              model={model}
              modelOptionsByInstance={modelOptionsByInstance}
              onInstanceModelChange={handleSelect}
              {...(props.onOpenProviderSetup
                ? { onOpenProviderSetup: props.onOpenProviderSetup }
                : {})}
              onRequestClose={() => setOpen(false)}
            />
          </div>
          {props.traits ? (
            traitsFooter ? (
              <div className="shrink-0 border-t border-border/60 px-1 py-1.5">{traitsFooter}</div>
            ) : (
              <div
                className="shrink-0 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground"
                data-testid="model-picker-no-effort"
              >
                This model has no effort setting.
              </div>
            )
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
