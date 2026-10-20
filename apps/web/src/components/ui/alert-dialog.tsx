"use client";

import { cn } from "~/util/utils";
import {
  DIALOG_MOBILE_SHEET_CLASS,
  DIALOG_BACKDROP_CLASS,
  DIALOG_POPUP_CLASS,
} from "./dialog-classes";
import type * as React from "react";
import { AlertDialog as Primitive } from "@base-ui/react/alert-dialog";

const AlertDialogCreateHandle = Primitive.createHandle;
const AlertDialog = Primitive.Root;
const AlertDialogPortal = Primitive.Portal;

function AlertDialogTrigger(props: Primitive.Trigger.Props) {
  return <Primitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogBackdrop({ className, ...props }: Primitive.Backdrop.Props) {
  return (
    <Primitive.Backdrop
      className={cn(DIALOG_BACKDROP_CLASS, className)}
      data-slot="alert-dialog-backdrop"
      {...props}
    />
  );
}

const alertDialogViewportCls1 =
  "fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4";

function AlertDialogViewport({ className, ...props }: Primitive.Viewport.Props) {
  return (
    <Primitive.Viewport
      className={cn(alertDialogViewportCls1, className)}
      data-slot="alert-dialog-viewport"
      {...props}
    />
  );
}

const alertDialogPopupCls1 = "row-start-2 max-h-full max-w-lg text-popover-foreground";

function AlertDialogPopup(
  incoming: Primitive.Popup.Props & {
    bottomStickOnMobile?: boolean;
    portalContainer?: Primitive.Portal.Props["container"];
  },
) {
  const { bottomStickOnMobile = true, portalContainer, className, ...props } = incoming;
  const mobileViewportClass = "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12";
  return (
    <Primitive.Portal container={portalContainer}>
      <AlertDialogBackdrop />
      <AlertDialogViewport className={cn(bottomStickOnMobile && mobileViewportClass)}>
        <Primitive.Popup
          data-slot="alert-dialog-popup"
          className={cn(
            DIALOG_POPUP_CLASS,
            alertDialogPopupCls1,
            bottomStickOnMobile && DIALOG_MOBILE_SHEET_CLASS,
            className,
          )}
          {...props}
        />
      </AlertDialogViewport>
    </Primitive.Portal>
  );
}

const alertDialogHeaderCls1 = "flex flex-col gap-2 p-6 text-center max-sm:pb-4 sm:text-left";

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(alertDialogHeaderCls1, className)}
      data-slot="alert-dialog-header"
      {...props}
    />
  );
}

function AlertDialogFooter(
  incoming2: React.ComponentProps<"div"> & { variant?: "default" | "bare" },
) {
  const { variant = "default", className, ...props } = incoming2;
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]",
        variant === "default" ? "border-t bg-muted/72 py-4" : "pb-6",
        className,
      )}
      data-slot="alert-dialog-footer"
      {...props}
    />
  );
}

function AlertDialogTitle({ className, ...props }: Primitive.Title.Props) {
  return (
    <Primitive.Title
      className={cn("font-heading font-semibold text-xl leading-none", className)}
      data-slot="alert-dialog-title"
      {...props}
    />
  );
}

function AlertDialogDescription({ className, ...props }: Primitive.Description.Props) {
  return (
    <Primitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="alert-dialog-description"
      {...props}
    />
  );
}

function AlertDialogClose(props: Primitive.Close.Props) {
  return <Primitive.Close data-slot="alert-dialog-close" {...props} />;
}

export {
  AlertDialog,
  AlertDialogClose,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPortal,
  AlertDialogTrigger,
  AlertDialogBackdrop,
  AlertDialogViewport,
  AlertDialogDescription,
  AlertDialogCreateHandle,
  AlertDialogPopup as AlertDialogContent,
  AlertDialogBackdrop as AlertDialogOverlay,
};
