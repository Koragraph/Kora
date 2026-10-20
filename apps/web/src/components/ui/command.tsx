"use client";

import { cn } from "~/util/utils";
import { DIALOG_BACKDROP_CLASS, DIALOG_POPUP_CLASS } from "./dialog-classes";
import { Button } from "./button";
import {
  AutocompleteEmpty,
  AutocompleteGroup,
  AutocompleteItem,
  AutocompleteGroupLabel,
  AutocompleteSeparator,
  AutocompleteCollection,
  Autocomplete,
  AutocompleteList,
  AutocompleteInput,
} from "./autocomplete";
import type * as React from "react";
import { SearchIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

const CommandCreateHandle = DialogPrimitive.createHandle;
const CommandDialog = DialogPrimitive.Root;
const CommandCollection = AutocompleteCollection;

function CommandDialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="command-dialog-trigger" {...props} />;
}

function CommandDialogPopup({
  className,
  children,
  onBackdropPointerDown,
  ...props
}: DialogPrimitive.Popup.Props & {
  onBackdropPointerDown?: React.PointerEventHandler<HTMLDivElement>;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        className={DIALOG_BACKDROP_CLASS}
        data-slot="command-dialog-backdrop"
        forceRender
        onPointerDown={onBackdropPointerDown}
      />
      <DialogPrimitive.Viewport
        className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center px-4 py-[max(--spacing(4),4vh)] sm:py-[10vh]"
        data-slot="command-dialog-viewport"
      >
        <DialogPrimitive.Popup
          className={cn(
            DIALOG_POPUP_CLASS,
            "pointer-events-auto max-h-[420px] max-w-xl text-foreground",
            className,
          )}
          data-slot="command-dialog-popup"
          {...props}
        >
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}

function Command(incoming: React.ComponentProps<typeof Autocomplete>) {
  const { autoHighlight = "always", keepHighlight = true, ...props } = incoming;
  return <Autocomplete autoHighlight={autoHighlight} inline keepHighlight open {...props} />;
}

function CommandInput({
  className,
  wrapperClassName,
  ...props
}: React.ComponentProps<typeof AutocompleteInput> & { wrapperClassName?: string }) {
  return (
    <div
      className={cn(
        "px-(--command-shell-inset) py-1.5 [&_[data-slot=autocomplete-start-addon]]:ps-[calc(var(--command-shell-inset)+0.0625rem)]",
        wrapperClassName,
      )}
    >
      <AutocompleteInput
        className={cn(
          "border-transparent! bg-transparent! shadow-none! before:hidden has-focus-visible:ring-0! *:data-[slot=input]:ps-9 *:data-[slot=input]:placeholder:text-placeholder sm:*:data-[slot=input]:ps-[calc(var(--command-shell-inset)+1.5rem)]",
          className,
        )}
        startAddon={<SearchIcon className="translate-x-0.5 text-icon-muted" />}
        size="lg"
        autoFocus
        {...props}
      />
    </div>
  );
}

function CommandList(incoming2: React.ComponentProps<typeof AutocompleteList>) {
  const { className, ...props } = incoming2;
  return (
    <AutocompleteList
      data-slot="command-list"
      className={cn("not-empty:scroll-py-2 not-empty:p-2", className)}
      {...props}
    />
  );
}

function CommandEmpty({ className, ...props }: React.ComponentProps<typeof AutocompleteEmpty>) {
  return (
    <AutocompleteEmpty
      className={cn("not-empty:py-6", className)}
      data-slot="command-empty"
      {...props}
    />
  );
}

function CommandPanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative min-h-0 touch-pan-y overflow-hidden rounded-t-xl rounded-b-2xl bg-transparent [&:has(+[data-slot=command-footer])]:rounded-b-none [&_[data-slot=scroll-area-scrollbar]]:mt-2",
        className,
      )}
      {...props}
    />
  );
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof AutocompleteGroup>) {
  return <AutocompleteGroup data-slot="command-group" className={className} {...props} />;
}

function CommandGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteGroupLabel>) {
  return (
    <AutocompleteGroupLabel data-slot="command-group-label" className={className} {...props} />
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof AutocompleteItem>) {
  return (
    <AutocompleteItem
      className={cn(
        "py-1.5 data-selected:bg-foreground/6 data-highlighted:bg-foreground/9 data-highlighted:text-foreground data-highlighted:data-selected:bg-foreground/9 data-highlighted:data-selected:text-foreground",
        className,
      )}
      data-slot="command-item"
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteSeparator>) {
  return (
    <AutocompleteSeparator
      className={cn("my-2", className)}
      data-slot="command-separator"
      {...props}
    />
  );
}

function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative flex items-center justify-between gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] bg-foreground/2.5 px-(--command-content-inset) py-2.5 font-medium text-muted-foreground text-sm",
        className,
      )}
      data-slot="command-footer"
      {...props}
    />
  );
}

function CommandFooterAction({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button
      className={cn("h-auto px-2 text-xs hover:bg-transparent", className)}
      size="xs"
      variant="ghost-muted"
      {...props}
    />
  );
}

export {
  CommandDialogTrigger,
  CommandFooterAction,
  CommandCreateHandle,
  CommandDialogPopup,
  CommandGroupLabel,
  CommandCollection,
  CommandSeparator,
  CommandFooter,
  CommandDialog,
  CommandPanel,
  CommandInput,
  CommandGroup,
  CommandEmpty,
  CommandList,
  CommandItem,
  Command,
};
