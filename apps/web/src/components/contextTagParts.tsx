/**
 * The look of a context chip (icon and label, an optional tooltip or details popover). Each surface that shows
 * chips (composer, transcript, terminal) looks up what a chip points at and decides what clicking it does.
 */
import { CircleDashedIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/util/utils";
import { pill, tagFocusRing } from "./tagStyles";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type ChipLook = {
  /** What it points at is gone (dashed outline). */
  unresolved?: boolean;
  /** Hover styling, for a chip that does something when clicked. */
  interactive?: boolean;
  /** Shown on hover and focus; a chip with one becomes focusable. */
  tooltip?: ReactNode;
  tooltipClassName?: string;
  label: string;
  labelClassName: string;
  icon: ReactNode;
};

export function ContextTagShell(props: ComponentProps<"span"> & ChipLook) {
  const { icon, label, labelClassName, interactive, unresolved, className, ...rest } = props;
  const {
    tooltip,
    tooltipClassName = "max-w-96 whitespace-pre-wrap leading-tight",
    ...spanProps
  } = rest;
  const chip = (
    <span
      tabIndex={tooltip ? 0 : undefined}
      data-context-unresolved={unresolved ? "true" : undefined}
      {...spanProps}
      className={cn(
        className,
        unresolved && "border-dashed text-foreground",
        tooltip && tagFocusRing,
        interactive && pill.hover,
      )}
    >
      {icon}
      <span className={labelClassName}>{label}</span>
    </span>
  );
  return tooltip ? (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup className={tooltipClassName} side="top">
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  ) : (
    chip
  );
}

/** A chip that opens a details popover (the popover is titled with `accessibleLabel` for screen readers). */
export function ContextTagPopover(props: {
  chip: ReactNode;
  children: ReactNode;
  accessibleLabel: string;
  /** What a copy of the transcript writes for this chip. */
  copyMarkdown?: string;
  triggerClassName?: string;
  popupClassName?: string;
  viewportClassName?: string;
}) {
  const trigger = (
    <Button
      variant="chip"
      aria-label={`${props.accessibleLabel}. Show details`}
      data-markdown-copy={props.copyMarkdown}
      className={cn(
        "inline-flex max-w-full cursor-pointer items-center rounded-[0.5em] align-middle",
        tagFocusRing,
        props.triggerClassName,
      )}
    />
  );
  return (
    <Popover>
      <PopoverTrigger render={trigger}>{props.chip}</PopoverTrigger>
      <PopoverPopup
        side="top"
        className={cn("w-[min(36rem,calc(100vw-2rem))]", props.popupClassName)}
        viewportClassName={cn("overflow-x-auto p-2", props.viewportClassName)}
      >
        <PopoverTitle className="sr-only">{props.accessibleLabel}</PopoverTitle>
        {props.children}
      </PopoverPopup>
    </Popover>
  );
}

/** A chip whose context can no longer be found: dashed, with a tooltip saying why. */
export function UnresolvedChip({
  label,
  tooltip,
  copyMarkdown,
  ...classes
}: {
  label: string;
  tooltip: string;
  copyMarkdown?: string;
  className: string;
  labelClassName: string;
  tooltipClassName: string;
}) {
  return (
    <ContextTagShell
      {...classes}
      unresolved
      label={label}
      tooltip={tooltip}
      data-markdown-copy={copyMarkdown}
      aria-label={`Unavailable context, ${label}`}
      icon={<CircleDashedIcon className={cn(pill.icon, "size-3.5")} />}
    />
  );
}
