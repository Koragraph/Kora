import { cn } from "~/util/utils";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

const TooltipCreateHandle = TooltipPrimitive.createHandle;

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

const tooltipPopupCls1 =
  "pointer-events-none z-[140] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none";
const tooltipPopupCls2 =
  "relative size-full overflow-clip px-(--viewport-inline-padding) py-1 [--viewport-inline-padding:--spacing(2)] data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:truncate **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity";

function TooltipPopup(
  incoming: TooltipPrimitive.Popup.Props & {
    sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
    anchor?: TooltipPrimitive.Positioner.Props["anchor"];
    align?: TooltipPrimitive.Positioner.Props["align"];
    side?: TooltipPrimitive.Positioner.Props["side"];
    variant?: "default" | "glass";
  },
) {
  const {
    anchor,
    children,
    className,
    side = "top",
    sideOffset = 4,
    align = "center",
    variant = "default",
    ...props
  } = incoming;

  const tooltipPrimitiveViewportPart = (
    <TooltipPrimitive.Viewport className={tooltipPopupCls2} data-slot="tooltip-viewport">
      {children}
    </TooltipPrimitive.Viewport>
  );

  const tooltipPrimitivePopupPart = (
    <TooltipPrimitive.Popup
      className={cn(
        "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance rounded-lg text-popover-foreground text-xs font-medium transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
        variant === "glass"
          ? "dropdown-glass shadow-xl shadow-black/25 before:hidden"
          : "bg-foreground text-background shadow-lg/20 before:hidden",
        className,
      )}
      data-slot="tooltip-popup"
      {...props}
    >
      {tooltipPrimitiveViewportPart}
    </TooltipPrimitive.Popup>
  );

  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        className={tooltipPopupCls1}
        data-slot="tooltip-positioner"
        sideOffset={sideOffset}
        anchor={anchor}
        align={align}
        side={side}
      >
        {tooltipPrimitivePopupPart}
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { TooltipCreateHandle, TooltipProvider, Tooltip, TooltipTrigger, TooltipPopup };
