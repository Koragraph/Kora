"use client";

import { cn } from "~/util/utils";
import { ScrollArea } from "./scroll-area";
import { Input } from "./input";
import type * as React from "react";
import { ChevronsUpDownIcon, XIcon } from "lucide-react";
import { Autocomplete as Primitive } from "@base-ui/react/autocomplete";

const Autocomplete = Primitive.Root;
const AutocompleteCollection = Primitive.Collection;
const useAutocompleteFilter = Primitive.useFilter;

function AutocompleteInput(
  incoming: Omit<Primitive.Input.Props, "size"> & {
    ref?: React.Ref<HTMLInputElement> | undefined;
    size?: "sm" | "default" | "lg" | number;
    startAddon?: React.ReactNode;
    showTrigger?: boolean;
    showClear?: boolean;
  },
) {
  const {
    showTrigger = false,
    showClear = false,
    startAddon,
    className,
    size,
    ref,
    ...props
  } = incoming;
  const small = size === "sm";
  const autocompleteTriggerBlock = showTrigger && (
    <AutocompleteTrigger
      className={cn(
        "-translate-y-1/2 absolute top-1/2 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 outline-none transition-opacity pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 [&:has(~[data-slot=autocomplete-clear])]:hidden sm:size-7 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
        small ? "end-0" : "end-0.5",
      )}
    >
      <ChevronsUpDownIcon />
    </AutocompleteTrigger>
  );

  const autocompleteClearBlock = showClear && (
    <AutocompleteClear
      className={cn(
        "-translate-y-1/2 absolute top-1/2 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 outline-none transition-opacity pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 sm:size-7 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
        small ? "end-0" : "end-0.5",
      )}
    >
      <XIcon />
    </AutocompleteClear>
  );

  return (
    <div
      className={cn(
        "relative not-has-[>*.w-full]:w-fit w-full text-foreground has-disabled:opacity-64",
      )}
    >
      {startAddon && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 start-px z-10 flex items-center ps-[calc(--spacing(3)-1px)] opacity-80 [&_svg]:-mx-0.5 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
            small && "ps-[calc(--spacing(2.5)-1px)]",
          )}
          data-slot="autocomplete-start-addon"
        >
          {startAddon}
        </div>
      )}
      <Primitive.Input
        className={cn(
          startAddon &&
            (small
              ? "*:data-[slot=input]:ps-[calc(--spacing(7.5)-1px)] sm:*:data-[slot=input]:ps-[calc(--spacing(7)-1px)]"
              : "*:data-[slot=input]:ps-[calc(--spacing(8.5)-1px)] sm:*:data-[slot=input]:ps-[calc(--spacing(8)-1px)]"),
          (showTrigger || showClear) &&
            (small
              ? "has-[+button]:*:data-[slot=input]:pe-6.5"
              : "has-[+button]:*:data-[slot=input]:pe-7"),
          className,
        )}
        data-slot="autocomplete-input"
        render={<Input nativeInput {...(size !== undefined ? { size } : {})} />}
        {...(ref ? { ref } : {})}
        {...props}
      />
      {autocompleteTriggerBlock}
      {autocompleteClearBlock}
    </div>
  );
}

function AutocompletePopup(
  incoming2: Primitive.Popup.Props & {
    align?: Primitive.Positioner.Props["align"];
    sideOffset?: Primitive.Positioner.Props["sideOffset"];
    alignOffset?: Primitive.Positioner.Props["alignOffset"];
    side?: Primitive.Positioner.Props["side"];
    anchor?: Primitive.Positioner.Props["anchor"];
  },
) {
  const {
    side = "bottom",
    align = "start",
    sideOffset = 4,
    alignOffset,
    className,
    children,
    anchor,
    ...props
  } = incoming2;
  return (
    <Primitive.Portal>
      <Primitive.Positioner
        data-slot="autocomplete-positioner"
        className="z-[130] select-none"
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        anchor={anchor}
        align={align}
        side={side}
      >
        <span
          className={cn(
            "relative flex max-h-full min-w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) rounded-lg border bg-popover not-dark:bg-clip-padding shadow-lg/5 transition-[scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] has-data-starting-style:scale-98 has-data-starting-style:opacity-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            className,
          )}
        >
          <Primitive.Popup
            className="flex max-h-[min(var(--available-height),23rem)] flex-1 flex-col text-foreground"
            data-slot="autocomplete-popup"
            {...props}
          >
            {children}
          </Primitive.Popup>
        </span>
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}

function AutocompleteItem({ className, children, ...props }: Primitive.Item.Props) {
  return (
    <Primitive.Item
      className={cn(
        "flex min-h-8 cursor-default select-none items-center rounded-sm px-2 py-1 text-base outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-selected:bg-accent/50 data-highlighted:text-accent-foreground data-selected:text-foreground data-highlighted:data-selected:bg-accent data-disabled:opacity-64 hover:bg-accent hover:text-accent-foreground sm:min-h-7 sm:text-sm [&_svg]:pointer-events-none [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      data-slot="autocomplete-item"
      {...props}
    >
      {children}
    </Primitive.Item>
  );
}

function AutocompleteSeparator({ className, ...props }: Primitive.Separator.Props) {
  return (
    <Primitive.Separator
      className={cn("mx-2 my-1 h-px bg-border last:hidden", className)}
      data-slot="autocomplete-separator"
      {...props}
    />
  );
}

function AutocompleteGroup({ className, ...props }: Primitive.Group.Props) {
  return (
    <Primitive.Group
      className={cn("[[role=group]+&]:mt-1.5", className)}
      data-slot="autocomplete-group"
      {...props}
    />
  );
}

function AutocompleteGroupLabel({ className, ...props }: Primitive.GroupLabel.Props) {
  return (
    <Primitive.GroupLabel
      className={cn("px-2 py-1.5 font-medium text-muted-foreground text-xs", className)}
      data-slot="autocomplete-group-label"
      {...props}
    />
  );
}

const autocompleteEmptyCls1 =
  "not-empty:p-2 text-center text-base text-muted-foreground sm:text-sm";

function AutocompleteEmpty({ className, ...props }: Primitive.Empty.Props) {
  return (
    <Primitive.Empty
      className={cn(autocompleteEmptyCls1, className)}
      data-slot="autocomplete-empty"
      {...props}
    />
  );
}

function AutocompleteRow(props: Primitive.Row.Props) {
  return <Primitive.Row data-slot="autocomplete-row" {...props} />;
}

function AutocompleteValue(props: Primitive.Value.Props) {
  return <Primitive.Value data-slot="autocomplete-value" {...props} />;
}

function AutocompleteList({ className, ...props }: Primitive.List.Props) {
  return (
    <ScrollArea scrollbarGutter scrollFade>
      <Primitive.List
        data-slot="autocomplete-list"
        className={cn("not-empty:scroll-py-1 not-empty:p-1", className)}
        {...props}
      />
    </ScrollArea>
  );
}

function AutocompleteClear({ className, ...props }: Primitive.Clear.Props) {
  return <Primitive.Clear className={className} data-slot="autocomplete-clear" {...props} />;
}

function AutocompleteTrigger({ className, ...props }: Primitive.Trigger.Props) {
  return <Primitive.Trigger className={className} data-slot="autocomplete-trigger" {...props} />;
}

function AutocompleteStatus({ className, ...props }: Primitive.Status.Props) {
  return (
    <Primitive.Status
      className={cn(
        "px-3 py-2 font-medium text-muted-foreground text-xs empty:m-0 empty:p-0",
        className,
      )}
      data-slot="autocomplete-status"
      {...props}
    />
  );
}

export {
  AutocompleteGroupLabel,
  AutocompleteCollection,
  useAutocompleteFilter,
  AutocompleteSeparator,
  AutocompleteTrigger,
  AutocompleteStatus,
  AutocompleteValue,
  AutocompletePopup,
  AutocompleteInput,
  AutocompleteGroup,
  AutocompleteEmpty,
  AutocompleteClear,
  AutocompleteList,
  AutocompleteItem,
  AutocompleteRow,
  Autocomplete,
};
