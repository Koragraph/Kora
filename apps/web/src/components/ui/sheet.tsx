"use client";

import { cn } from "~/util/utils";
import { ScrollArea } from "./scroll-area";
import { Button } from "./button";
import type * as React from "react";
import { XIcon } from "lucide-react";
import { Dialog as Primitive } from "@base-ui/react/dialog";

type SheetSide = "right" | "left" | "top" | "bottom";

const Sheet = Primitive.Root;
const SheetPortal = Primitive.Portal;

function SheetTrigger(props: Primitive.Trigger.Props) {
  return <Primitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose(props: Primitive.Close.Props) {
  return <Primitive.Close data-slot="sheet-close" {...props} />;
}

function SheetBackdrop({ className, ...props }: Primitive.Backdrop.Props) {
  return (
    <Primitive.Backdrop
      className={cn(
        "fixed inset-0 z-50 bg-background/60 backdrop-blur-xs transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      data-slot="sheet-backdrop"
      {...props}
    />
  );
}

function SheetViewport(
  incoming: Primitive.Viewport.Props & { side?: SheetSide; variant?: "default" | "inset" },
) {
  const { variant = "default", className, side, ...props } = incoming;
  return (
    <Primitive.Viewport
      data-slot="sheet-viewport"
      className={cn(
        "fixed inset-0 z-50 grid",
        side === "bottom" && "grid-rows-[1fr_auto] pt-12",
        side === "top" && "grid-rows-[auto_1fr] pb-12",
        variant === "inset" && "sm:p-4",
        side === "right" && "flex justify-end",
        side === "left" && "flex justify-start",
        className,
      )}
      {...props}
    />
  );
}

const SIDE_CLASS: Record<SheetSide, string> = {
  bottom: "row-start-2 border-t data-ending-style:translate-y-8 data-starting-style:translate-y-8",
  top: "border-b data-ending-style:-translate-y-8 data-starting-style:-translate-y-8",
  left: "w-[calc(100%-(--spacing(12)))] max-w-md border-e data-ending-style:-translate-x-8 data-starting-style:-translate-x-8",
  right:
    "col-start-2 w-[calc(100%-(--spacing(12)))] max-w-md border-s data-ending-style:translate-x-8 data-starting-style:translate-x-8",
};

function SheetPopup({
  showCloseButton = true,
  transitionDurationMs,
  variant = "default",
  keepMounted = false,
  viewportClassName,
  backdropClassName,
  side = "right",
  className,
  children,
  style,
  ...props
}: Primitive.Popup.Props & {
  variant?: "default" | "inset";
  transitionDurationMs?: number;
  viewportClassName?: string;
  backdropClassName?: string;
  showCloseButton?: boolean;
  keepMounted?: boolean;
  side?: SheetSide;
}) {
  const instant = transitionDurationMs === 0;
  const durationStyle: React.CSSProperties | undefined =
    transitionDurationMs === undefined
      ? undefined
      : { transitionDuration: `${transitionDurationMs}ms` };
  const popupStyle =
    typeof style === "function" ? style : { ...durationStyle, ...(style as React.CSSProperties) };

  return (
    <SheetPortal keepMounted={keepMounted}>
      <SheetBackdrop
        className={cn(instant && "transition-none", backdropClassName)}
        style={durationStyle}
      />
      <SheetViewport className={viewportClassName} side={side} variant={variant}>
        <Primitive.Popup
          className={cn(
            "relative flex max-h-full min-h-0 w-full min-w-0 flex-col bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-lg/5 transition-[opacity,translate] duration-200 ease-in-out before:pointer-events-none before:absolute before:inset-0 before:shadow-[0_1px_--theme(--color-black/4%)] max-sm:before:hidden data-ending-style:opacity-0 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            SIDE_CLASS[side],
            variant === "inset" &&
              "before:hidden sm:rounded-2xl sm:border sm:**:data-[slot=sheet-footer]:rounded-b-[calc(var(--radius-2xl)-1px)]",
            instant &&
              "transition-none data-ending-style:translate-x-0 data-ending-style:translate-y-0 data-starting-style:translate-x-0 data-starting-style:translate-y-0 data-ending-style:opacity-100 data-starting-style:opacity-100",
            className,
          )}
          data-slot="sheet-popup"
          style={popupStyle}
          {...props}
        >
          {children}
          {showCloseButton && (
            <Primitive.Close
              render={<Button size="icon" variant="ghost" />}
              className="absolute end-2 top-2"
              aria-label="Close"
            >
              <XIcon />
            </Primitive.Close>
          )}
        </Primitive.Popup>
      </SheetViewport>
    </SheetPortal>
  );
}

const sheetHeaderCls1 =
  "flex flex-col gap-2 p-6 in-[[data-slot=sheet-popup]:has([data-slot=sheet-panel])]:pb-3 max-sm:pb-4";

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn(sheetHeaderCls1, className)} data-slot="sheet-header" {...props} />;
}

function SheetFooter({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & { variant?: "default" | "bare" }) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end",
        variant === "default"
          ? "border-t bg-muted/72 pt-4 pb-5"
          : "pt-4 pb-6 in-[[data-slot=sheet-popup]:has([data-slot=sheet-panel])]:pt-3",
        className,
      )}
      data-slot="sheet-footer"
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: Primitive.Title.Props) {
  return (
    <Primitive.Title
      className={cn("font-heading font-semibold text-xl leading-none", className)}
      data-slot="sheet-title"
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: Primitive.Description.Props) {
  return (
    <Primitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="sheet-description"
      {...props}
    />
  );
}

function SheetPanel(incoming2: React.ComponentProps<"div"> & { scrollFade?: boolean }) {
  const { scrollFade = true, className, ...props } = incoming2;
  return (
    <ScrollArea scrollFade={scrollFade}>
      <div
        className={cn(
          "p-6 in-[[data-slot=sheet-popup]:has([data-slot=sheet-header])]:pt-1 in-[[data-slot=sheet-popup]:has([data-slot=sheet-footer]:not(.border-t))]:pb-1",
          className,
        )}
        data-slot="sheet-panel"
        {...props}
      />
    </ScrollArea>
  );
}

export {
  SheetBackdrop as SheetOverlay,
  SheetPopup as SheetContent,
  SheetDescription,
  SheetBackdrop,
  SheetTrigger,
  SheetPortal,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetPopup,
  SheetPanel,
  SheetClose,
  Sheet,
};
