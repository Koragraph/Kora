import { Toolbar } from "@base-ui/react/toolbar";
import type { AgentProfileId } from "@kora/contracts";
import { BookmarkIcon } from "lucide-react";
import { memo, useEffect, useRef, type WheelEvent } from "react";

import { cn } from "~/util/utils";
import {
  isAgentProfilePickerReady,
  shouldShowInstanceBadge,
  type AgentProfileEntry,
} from "../../agentProfiles";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentProfileIcon } from "./AgentProfileIcon";

type Selection = AgentProfileId | "favorites";

type Props = {
  selectedInstanceId: Selection;
  onSelectInstance: (instanceId: Selection) => void;
  instanceEntries: ReadonlyArray<AgentProfileEntry>;
  showFavorites?: boolean;
  disabledInstanceIds?: ReadonlySet<AgentProfileId>;
  selectableUnavailableInstanceIds?: ReadonlySet<AgentProfileId>;
  getDisabledInstanceTooltip?: (entry: AgentProfileEntry) => string;
};

function describeUnavailableInstance(entry: AgentProfileEntry): string {
  const name = entry.displayName;
  if (!entry.enabled || entry.status === "disabled") return `${name} — Disabled in settings.`;
  if (isAgentProfilePickerReady(entry)) return name;
  const kind =
    entry.status === "error" ? "Unavailable" : entry.status === "warning" ? "Limited" : "Not ready";
  const message = entry.snapshot.message?.trim();
  return message ? `${name} — ${kind}. ${message}` : `${name} — ${kind}.`;
}

const PILL_BASE =
  "flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-dashed px-2.5 py-1 font-medium text-[11px] transition-colors";
const PILL_SELECTED = "border-solid border-foreground/70 bg-foreground/[0.06] text-foreground";
const PILL_IDLE =
  "border-foreground/15 text-muted-foreground hover:border-foreground/35 hover:text-foreground";
const PILL_DISABLED =
  "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground";

export const ModelPickerAgentTabs = memo(function ModelPickerAgentTabs({
  selectedInstanceId,
  onSelectInstance,
  instanceEntries,
  showFavorites = true,
  disabledInstanceIds,
  selectableUnavailableInstanceIds,
  getDisabledInstanceTooltip,
}: Props) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  // Keep the pressed pill visible when the selection changes.
  useEffect(() => {
    rowRef.current
      ?.querySelector<HTMLElement>('[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedInstanceId]);

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.currentTarget.scrollLeft += event.deltaY;
  };

  return (
    <Toolbar.Root
      aria-label="Providers"
      className="flex items-center gap-1 overflow-x-auto p-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-model-picker-nav="true"
      onWheel={onWheel}
      orientation="horizontal"
      ref={rowRef}
    >
      {showFavorites ? (
        <Toolbar.Button
          aria-label="Saved models"
          aria-pressed={selectedInstanceId === "favorites"}
          className={cn(PILL_BASE, selectedInstanceId === "favorites" ? PILL_SELECTED : PILL_IDLE)}
          data-model-picker-agent="favorites"
          onClick={() => onSelectInstance("favorites")}
        >
          <BookmarkIcon className="size-3.5 fill-current" />
          Saved
        </Toolbar.Button>
      ) : null}
      {instanceEntries.map((entry) => {
        const unavailable = !isAgentProfilePickerReady(entry);
        const contextDisabled = disabledInstanceIds?.has(entry.instanceId) ?? false;
        const disabled =
          (unavailable && !selectableUnavailableInstanceIds?.has(entry.instanceId)) ||
          contextDisabled;
        const selected = selectedInstanceId === entry.instanceId;
        const label = unavailable
          ? describeUnavailableInstance(entry)
          : contextDisabled
            ? (getDisabledInstanceTooltip?.(entry) ?? entry.displayName)
            : entry.displayName;

        return (
          <Tooltip key={entry.instanceId}>
            <TooltipTrigger
              render={
                <Toolbar.Button
                  aria-label={label}
                  aria-pressed={selected}
                  className={cn(
                    PILL_BASE,
                    selected ? PILL_SELECTED : PILL_IDLE,
                    disabled && PILL_DISABLED,
                  )}
                  data-agent-accent-color={entry.accentColor}
                  data-model-picker-agent={entry.instanceId}
                  // Stays focusable while disabled so the tooltip still shows.
                  focusableWhenDisabled
                  onClick={() => {
                    if (!disabled) onSelectInstance(entry.instanceId);
                  }}
                />
              }
            >
              <AgentProfileIcon
                {...(entry.accentColor
                  ? {
                      accentColor: entry.accentColor,
                      badgeClassName: "h-3.5 min-w-3.5 text-[10px] -right-1 -bottom-1",
                    }
                  : {})}
                className="size-3.5"
                displayName={entry.displayName}
                driverKind={entry.driverKind}
                iconClassName="size-3.5"
                indicatorBackground={selected ? "var(--foreground)" : "var(--popover)"}
                showBadge={shouldShowInstanceBadge(entry, instanceEntries)}
              />
              <span className="max-w-24 truncate">{entry.displayName}</span>
            </TooltipTrigger>
            <TooltipPopup className="max-w-64 text-balance" side="bottom" sideOffset={6}>
              {label}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </Toolbar.Root>
  );
});
