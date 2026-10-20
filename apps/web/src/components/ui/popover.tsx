"use client";

import { cn } from "~/util/utils";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

const PopoverCreateHandle = PopoverPrimitive.createHandle;

const Popover = PopoverPrimitive.Root;

function PopoverTrigger(incoming: PopoverPrimitive.Trigger.Props) {
  const { className, children, ...props } = incoming;
  return (
    <PopoverPrimitive.Trigger data-slot="popover-trigger" className={className} {...props}>
      {children}
    </PopoverPrimitive.Trigger>
  );
}

const popoverPopupCls1 =
  "w-fit text-balance rounded-md text-xs shadow-md/5 before:rounded-[calc(var(--radius-md)-1px)]";

function PopoverPopup({
  tooltipStyle = false,
  viewportClassName,
  align = "center",
  side = "bottom",
  alignOffset = 0,
  sideOffset = 4,
  className,
  children,
  anchor,
  ...props
}: PopoverPrimitive.Popup.Props & {
  alignOffset?: PopoverPrimitive.Positioner.Props["alignOffset"];
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
  anchor?: PopoverPrimitive.Positioner.Props["anchor"];
  align?: PopoverPrimitive.Positioner.Props["align"];
  side?: PopoverPrimitive.Positioner.Props["side"];
  viewportClassName?: string;
  tooltipStyle?: boolean;
}) {
  const popoverPrimitivePopupPart = (
    <PopoverPrimitive.Popup
      className={cn(
        "dropdown-glass relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-xl text-popover-foreground outline-none transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] has-data-[slot=calendar]:rounded-xl has-data-[slot=calendar]:before:rounded-[calc(var(--radius-xl)-1px)] data-starting-style:scale-98 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
        tooltipStyle && popoverPopupCls1,
        !tooltipStyle &&
          "shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
        className,
      )}
      data-slot="popover-popup"
      {...props}
    >
      <PopoverPrimitive.Viewport
        className={cn(
          "relative size-full max-h-(--available-height) overflow-clip px-(--viewport-inline-padding) py-4 [--viewport-inline-padding:--spacing(4)] has-data-[slot=calendar]:p-2 data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity",
          tooltipStyle
            ? "py-1 [--viewport-inline-padding:--spacing(2)]"
            : "not-data-transitioning:overflow-y-auto",
          viewportClassName,
        )}
        data-slot="popover-viewport"
      >
        {children}
      </PopoverPrimitive.Viewport>
    </PopoverPrimitive.Popup>
  );

  const popoverPrimitivePositionerPart = (
    <PopoverPrimitive.Positioner
      className="z-[130] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-transform data-instant:transition-none"
      data-slot="popover-positioner"
      alignOffset={alignOffset}
      sideOffset={sideOffset}
      anchor={anchor}
      align={align}
      side={side}
    >
      {popoverPrimitivePopupPart}
    </PopoverPrimitive.Positioner>
  );

  return <PopoverPrimitive.Portal>{popoverPrimitivePositionerPart}</PopoverPrimitive.Portal>;
}

function PopoverClose({ ...props }: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

function PopoverTitle(incoming2: PopoverPrimitive.Title.Props) {
  const { className, ...props } = incoming2;
  return (
    <PopoverPrimitive.Title
      className={cn("font-semibold text-lg leading-none", className)}
      data-slot="popover-title"
      {...props}
    />
  );
}

function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
  return (
    <PopoverPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="popover-description"
      {...props}
    />
  );
}

export {
  PopoverPopup as PopoverContent,
  PopoverCreateHandle,
  PopoverDescription,
  PopoverTrigger,
  PopoverTitle,
  PopoverPopup,
  PopoverClose,
  Popover,
};
