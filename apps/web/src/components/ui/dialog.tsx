"use client";

import { cn } from "~/util/utils";
import { ScrollArea } from "./scroll-area";
import {
  DIALOG_MEDIA_BACKDROP_CLASS,
  DIALOG_MOBILE_SHEET_CLASS,
  DIALOG_MEDIA_POPUP_CLASS,
  DIALOG_BACKDROP_CLASS,
  DIALOG_POPUP_CLASS,
} from "./dialog-classes";
import { Button } from "./button";
import type * as React from "react";
import { XIcon } from "lucide-react";
import { Dialog as Primitive } from "@base-ui/react/dialog";

type DialogVariant = "default" | "media";

const STICK_BOTTOM_ON_MOBILE = "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12";

const DialogCreateHandle = Primitive.createHandle;
const Dialog = Primitive.Root;
const DialogPortal = Primitive.Portal;

function DialogTrigger(props: Primitive.Trigger.Props) {
  return <Primitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: Primitive.Close.Props) {
  return <Primitive.Close data-slot="dialog-close" {...props} />;
}

function DialogBackdrop({
  className,
  variant = "default",
  ...props
}: Primitive.Backdrop.Props & { variant?: DialogVariant }) {
  return (
    <Primitive.Backdrop
      forceRender
      data-slot="dialog-backdrop"
      className={cn(
        variant === "media" ? DIALOG_MEDIA_BACKDROP_CLASS : DIALOG_BACKDROP_CLASS,
        className,
      )}
      {...props}
    />
  );
}

const dialogViewportCls1 =
  "fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4";

function DialogViewport({ className, ...props }: Primitive.Viewport.Props) {
  return (
    <Primitive.Viewport
      className={cn(dialogViewportCls1, className)}
      data-slot="dialog-viewport"
      {...props}
    />
  );
}

function DialogPopup({
  bottomStickOnMobile = true,
  showCloseButton = true,
  variant = "default",
  viewportClassName,
  backdropClassName,
  className,
  children,
  ...props
}: Primitive.Popup.Props & {
  showCloseButton?: boolean;
  bottomStickOnMobile?: boolean;
  backdropClassName?: string;
  viewportClassName?: string;
  variant?: DialogVariant;
}) {
  const media = variant === "media";
  return (
    <DialogPortal>
      <DialogBackdrop className={backdropClassName} variant={variant} />
      <DialogViewport
        className={cn(bottomStickOnMobile && STICK_BOTTOM_ON_MOBILE, viewportClassName)}
      >
        <Primitive.Popup
          className={cn(
            media ? DIALOG_MEDIA_POPUP_CLASS : DIALOG_POPUP_CLASS,
            "row-start-2 text-popover-foreground",
            !media && "max-h-full max-w-lg",
            bottomStickOnMobile && !media && DIALOG_MOBILE_SHEET_CLASS,
            className,
          )}
          data-slot="dialog-popup"
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
      </DialogViewport>
    </DialogPortal>
  );
}

function DialogHeader(incoming: React.ComponentProps<"div">) {
  const { className, ...props } = incoming;
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 px-6 pt-6 pb-4 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3 max-sm:pb-4",
        className,
      )}
      data-slot="dialog-header"
      {...props}
    />
  );
}

function DialogFooter(incoming2: React.ComponentProps<"div"> & { variant?: "default" | "bare" }) {
  const { variant = "default", className, ...props } = incoming2;
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]",
        variant === "default" ? "border-t bg-muted/72 pt-4 pb-5" : "py-4",
        className,
      )}
      data-slot="dialog-footer"
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: Primitive.Title.Props) {
  return (
    <Primitive.Title
      className={cn("font-heading font-semibold text-lg leading-tight tracking-tight", className)}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: Primitive.Description.Props) {
  return (
    <Primitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="dialog-description"
      {...props}
    />
  );
}

function DialogPanel(incoming3: React.ComponentProps<"div"> & { scrollFade?: boolean }) {
  const { scrollFade = true, className, ...props } = incoming3;
  return (
    <ScrollArea scrollFade={scrollFade}>
      <div
        className={cn(
          "p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1 in-[[data-slot=dialog-popup]:has([data-slot=dialog-footer]:not(.border-t))]:pb-1",
          className,
        )}
        data-slot="dialog-panel"
        {...props}
      />
    </ScrollArea>
  );
}

export {
  DialogBackdrop,
  Dialog,
  DialogPortal,
  DialogTrigger,
  DialogPopup,
  DialogFooter,
  DialogTitle,
  DialogHeader,
  DialogBackdrop as DialogOverlay,
  DialogPanel,
  DialogClose,
  DialogViewport,
  DialogCreateHandle,
  DialogPopup as DialogContent,
  DialogDescription,
};
