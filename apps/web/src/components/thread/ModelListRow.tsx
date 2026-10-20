import { cn } from "~/util/utils";
import { modelPickerModelKey } from "./modelPickerKeys";
import {
  getTriggerDisplayModelLabel,
  AGENT_ICON_BY_AGENT,
  getDisplayModelName,
  type ModelEsque,
} from "./agentIconUtils";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { Badge } from "../ui/badge";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import type { AgentProfileId, AgentId } from "@kora/contracts";
import { memo } from "react";
import { BookmarkIcon } from "lucide-react";

type Props = {
  disabledReason?: string | null;
  providerAccentColor?: string;
  onToggleFavorite: () => void;
  providerDisplayName: string;
  instanceId: AgentProfileId;
  useTriggerLabel?: boolean;
  preferShortName?: boolean;
  showNewBadge?: boolean;
  unavailable?: boolean;
  showProvider: boolean;
  isSelected: boolean;
  isFavorite: boolean;
  driverKind: AgentId;
  model: ModelEsque;
  index: number;
};

const ROW_CLASS = [
  "group/model-row relative w-full min-w-0 cursor-pointer rounded-md py-1 pr-1 pl-2.5 text-foreground",
  "transition-colors",
  "data-selected:bg-transparent data-selected:outline data-selected:outline-1 data-selected:outline-dashed data-selected:-outline-offset-1 data-selected:outline-foreground/40",
  "hover:bg-foreground/6 hover:text-foreground data-highlighted:bg-foreground/6 data-highlighted:text-foreground data-highlighted:data-selected:bg-foreground/6",
].join(" ");

export const ModelListRow = memo(function ModelListRow({
  index,
  model,
  instanceId,
  driverKind,
  providerDisplayName,
  isFavorite,
  isSelected: _isSelected,
  showProvider,
  preferShortName,
  useTriggerLabel,
  showNewBadge,
  unavailable,
  disabledReason,
  onToggleFavorite,
}: Props) {
  const Glyph = AGENT_ICON_BY_AGENT[driverKind];
  const disabled = Boolean(disabledReason);
  const name = useTriggerLabel
    ? getTriggerDisplayModelLabel(model)
    : getDisplayModelName(model, preferShortName ? { preferShortName } : undefined);
  // Outside a search only a sub-provider is worth saying (OpenCode's Zen / Go / Anthropic share one tab).
  const providerLabel = showProvider
    ? model.subProvider
      ? `${providerDisplayName} · ${model.subProvider}`
      : providerDisplayName
    : (model.subProvider ?? null);
  const saveLabel = isFavorite ? "Unsave model" : "Save model";

  const row = (
    <ComboboxItem
      className={cn(
        ROW_CLASS,
        disabled && "cursor-not-allowed hover:bg-transparent data-highlighted:bg-transparent",
      )}
      contentClassName="flex items-center gap-2.5"
      disabled={disabled}
      hideIndicator
      index={index}
      value={modelPickerModelKey(instanceId, model.slug)}
      // A disabled row keeps pointer events so its tooltip can still open.
      style={disabled ? { pointerEvents: "auto" } : undefined}
    >
      {Glyph ? (
        <Glyph aria-hidden="true" className="size-3.5 shrink-0 opacity-80" />
      ) : (
        <span aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <span className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
        <span className="truncate text-[13px] leading-snug">{name}</span>
        {providerLabel ? (
          <span className="truncate text-[11px] text-muted-foreground/70">{providerLabel}</span>
        ) : null}
        {showNewBadge ? (
          <span
            aria-label="New model"
            className="self-center font-semibold text-[10px] text-update-foreground"
          >
            new
          </span>
        ) : null}
        {unavailable ? (
          <Badge className="self-center" size="sm" variant="outline">
            Unavailable
          </Badge>
        ) : null}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              onClick={(event) => {
                event.stopPropagation();
                event.preventDefault();
                onToggleFavorite();
              }}
              disabled={disabled}
              size="icon-xs"
              aria-label={saveLabel}
              className={cn(
                "shrink-0 text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-data-highlighted/model-row:opacity-100 group-hover/model-row:opacity-100",
                isFavorite && "text-foreground opacity-100",
              )}
              variant="ghost"
              onKeyDown={(event) => event.stopPropagation()}
            />
          }
        >
          <BookmarkIcon className={cn("size-3.5 sm:size-3", isFavorite && "fill-current")} />
        </TooltipTrigger>
        <TooltipPopup side="top">{isFavorite ? "Unsave" : "Save to the Saved tab"}</TooltipPopup>
      </Tooltip>
    </ComboboxItem>
  );

  if (!disabled) return row;

  return (
    <Tooltip>
      <TooltipTrigger render={<div className="w-full" />}>{row}</TooltipTrigger>
      <TooltipPopup className="max-w-64 text-balance leading-snug" side="left">
        {disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
});
