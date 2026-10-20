"use client";

import { cn } from "~/util/utils";
import { ScrollArea } from "./scroll-area";
import { Input } from "./input";
import * as React from "react";
import { ChevronsUpDownIcon, SearchIcon, XIcon } from "lucide-react";
import { Combobox as Primitive } from "@base-ui/react/combobox";

type ComboboxContextValue = {
  chipsRef: React.RefObject<Element | null> | null;
  multiple: boolean;
};

const NO_COMBOBOX_CONTEXT: ComboboxContextValue = { multiple: false, chipsRef: null };
const ComboboxContext = React.createContext<ComboboxContextValue>(NO_COMBOBOX_CONTEXT);

type ComboboxRootProps<Value, Multiple extends boolean | undefined> = Primitive.Root.Props<
  Value,
  Multiple
>;

function Combobox<Value, Multiple extends boolean | undefined = false>(
  props: ComboboxRootProps<Value, Multiple>,
) {
  const chipsRef = React.useRef<Element | null>(null);
  const contextValue = React.useMemo(
    () => ({ chipsRef, multiple: !!props.multiple }),
    [props.multiple],
  );
  return (
    <ComboboxContext.Provider value={contextValue}>
      <Primitive.Root {...props} />
    </ComboboxContext.Provider>
  );
}

const useComboboxFilter = Primitive.useFilter;
const ComboboxCollection = Primitive.Collection;

const iconButtonBase =
  "-translate-y-1/2 absolute top-1/2 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 outline-none transition-opacity pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 sm:size-7 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4";

function ComboboxInput(
  incoming: Omit<Primitive.Input.Props, "size"> & {
    ref?: React.Ref<HTMLInputElement> | undefined;
    size?: "sm" | "default" | "lg" | number;
    startAddon?: React.ReactNode;
    inputClassName?: string;
    showTrigger?: boolean;
    showClear?: boolean;
    unstyled?: boolean;
  },
) {
  const {
    ref,
    size,
    className,
    startAddon,
    inputClassName,
    unstyled = false,
    showClear = false,
    showTrigger = true,
    ...props
  } = incoming;
  const small = size === "sm";
  const comboboxTriggerBlock = showTrigger && (
    <ComboboxTrigger
      className={cn(
        iconButtonBase,
        small ? "end-0" : "end-0.5",
        "[&:has(~[data-slot=combobox-clear])]:hidden",
      )}
    >
      <ChevronsUpDownIcon data-slot="combobox-icon" />
    </ComboboxTrigger>
  );

  return (
    <div className="relative not-has-[>*.w-full]:w-fit w-full text-foreground has-disabled:opacity-64">
      {startAddon && (
        <div
          className={cn(
            "pointer-events-none absolute inset-y-0 start-px z-10 flex items-center ps-[calc(--spacing(3)-1px)] opacity-80 [&_svg]:-mx-0.5 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
            small && "ps-[calc(--spacing(2.5)-1px)]",
          )}
          data-slot="combobox-start-addon"
          aria-hidden="true"
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
        data-slot="combobox-input"
        {...(ref ? { ref } : {})}
        render={
          <Input
            className={cn("has-disabled:opacity-100", inputClassName)}
            nativeInput
            {...(size !== undefined ? { size } : {})}
            unstyled={unstyled}
          />
        }
        {...props}
      />
      {comboboxTriggerBlock}
      {showClear && (
        <ComboboxClear className={cn(iconButtonBase, small ? "end-0" : "end-0.5")}>
          <XIcon />
        </ComboboxClear>
      )}
    </div>
  );
}

function ComboboxTrigger({ className, children, ...props }: Primitive.Trigger.Props) {
  return (
    <Primitive.Trigger className={className} data-slot="combobox-trigger" {...props}>
      {children}
    </Primitive.Trigger>
  );
}

function ComboboxClear({ className, ...props }: Primitive.Clear.Props) {
  return <Primitive.Clear className={className} data-slot="combobox-clear" {...props} />;
}

function ComboboxSearchInput({
  className,
  ...props
}: Omit<Primitive.Input.Props, "size"> & { className?: string }) {
  return (
    <div className="shrink-0 px-3 pt-2.5">
      <div className="relative -translate-y-px border-border/70 border-b pb-1.5 transition-colors focus-within:border-ring">
        <SearchIcon
          aria-hidden="true"
          className="absolute top-1.5 left-0 size-4 text-muted-foreground/55"
        />
        <ComboboxInput
          {...(className ? { className } : {})}
          inputClassName="*:data-[slot=input]:h-[26px] *:data-[slot=input]:rounded-none *:data-[slot=input]:bg-transparent *:data-[slot=input]:ps-5 *:data-[slot=input]:font-sans *:data-[slot=input]:text-sm *:data-[slot=input]:leading-[26px] sm:*:data-[slot=input]:h-[26px] sm:*:data-[slot=input]:leading-[26px]"
          showTrigger={false}
          size="sm"
          unstyled
          {...props}
        />
      </div>
    </div>
  );
}

function ComboboxChipsInput({
  className,
  size,
  ref,
  ...props
}: Omit<Primitive.Input.Props, "size"> & {
  size?: "sm" | "default" | "lg" | number;
  ref?: React.Ref<HTMLInputElement> | undefined;
}) {
  return (
    <Primitive.Input
      className={cn(
        "min-w-12 flex-1 text-base outline-none sm:text-sm [[data-slot=combobox-chip]+&]:ps-0.5",
        size === "sm" ? "ps-1.5" : "ps-2",
        className,
      )}
      data-size={typeof size === "string" ? size : undefined}
      data-slot="combobox-chips-input"
      ref={ref}
      {...props}
    />
  );
}

function ComboboxChips({
  children,
  className,
  startAddon,
  ...props
}: Primitive.Chips.Props & { startAddon?: React.ReactNode }) {
  const { chipsRef } = React.useContext(ComboboxContext);
  return (
    <Primitive.Chips
      className={cn(
        "relative inline-flex min-h-9 w-full flex-wrap gap-1 rounded-lg border border-input bg-background not-dark:bg-clip-padding p-[3px] text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-within:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-autofill:bg-foreground/4 has-[:disabled]:pointer-events-none has-[:disabled]:opacity-64 has-[:focus-within]:border-ring has-[:focus-within]:ring-[3px] has-[[aria-invalid]]:border-destructive/36 has-[[aria-invalid]:focus-within]:border-destructive/64 has-[[aria-invalid]:focus-within]:ring-destructive/16 sm:min-h-8 sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-[[aria-invalid]:focus-within]:ring-destructive/24 dark:not-has-disabled:not-has-focus-within:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] *:min-h-7 sm:*:min-h-6",
        className,
      )}
      data-slot="combobox-chips"
      onMouseDown={(event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest("input, button, a, [data-slot=combobox-chip]")
        ) {
          return;
        }
        event.preventDefault();
        const input = (event.currentTarget as HTMLElement).querySelector("input");
        input?.focus();
      }}
      ref={chipsRef as React.Ref<HTMLDivElement> | null}
      {...props}
    >
      {startAddon && (
        <div
          aria-hidden="true"
          className="flex shrink-0 items-center ps-2 opacity-80 [&_svg]:-ms-0.5 [&_svg]:-me-1.5 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 has-[~[data-slot=combobox-chip]]:pe-2"
          data-slot="combobox-start-addon"
        >
          {startAddon}
        </div>
      )}
      {children}
    </Primitive.Chips>
  );
}

function ComboboxChip({ children, ...props }: Primitive.Chip.Props) {
  const labelId = React.useId();
  const removeId = React.useId();
  return (
    <Primitive.Chip
      className="flex items-center rounded-[calc(var(--radius-md)-1px)] bg-accent ps-2 font-medium text-accent-foreground text-sm outline-none sm:text-xs/4 [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5"
      data-slot="combobox-chip"
      {...props}
    >
      <span id={labelId}>{children}</span>
      <Primitive.ChipRemove
        aria-labelledby={`${removeId} ${labelId}`}
        className="h-full shrink-0 cursor-pointer px-1.5 opacity-80 hover:opacity-100"
        data-slot="combobox-chip-remove"
        id={removeId}
      >
        <XIcon aria-hidden="true" />
        <span className="sr-only">Remove</span>
      </Primitive.ChipRemove>
    </Primitive.Chip>
  );
}

function ComboboxPopup({
  side = "bottom",
  align = "start",
  sideOffset = 4,
  alignOffset,
  className,
  children,
  anchor,
  ...props
}: Primitive.Popup.Props & {
  align?: Primitive.Positioner.Props["align"];
  sideOffset?: Primitive.Positioner.Props["sideOffset"];
  alignOffset?: Primitive.Positioner.Props["alignOffset"];
  side?: Primitive.Positioner.Props["side"];
  anchor?: Primitive.Positioner.Props["anchor"];
}) {
  const { chipsRef, multiple } = React.useContext(ComboboxContext);
  return (
    <Primitive.Portal>
      <Primitive.Positioner
        anchor={anchor ?? (multiple ? chipsRef : undefined)}
        data-slot="combobox-positioner"
        className="z-[130] select-none"
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        align={align}
        side={side}
      >
        <span className="dropdown-glass relative flex max-h-full min-w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) rounded-lg shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] transition-[scale,opacity] has-data-starting-style:scale-98 has-data-starting-style:opacity-0 dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]">
          <Primitive.Popup
            className={cn(
              "flex max-h-[min(var(--available-height),23rem)] min-w-0 flex-1 flex-col overflow-hidden text-foreground",
              className,
            )}
            data-slot="combobox-popup"
            {...props}
          >
            {children}
          </Primitive.Popup>
        </span>
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}

function ComboboxItem({
  className,
  children,
  contentClassName,
  hideIndicator: _hideIndicator,
  ...props
}: Primitive.Item.Props & { contentClassName?: string; hideIndicator?: boolean }) {
  return (
    <Primitive.Item
      className={cn(
        "flex min-h-8 cursor-pointer items-center rounded-sm px-2 py-1 text-base outline-none in-data-[side=none]:min-w-[calc(var(--anchor-width)+--spacing(5))] data-disabled:cursor-not-allowed data-disabled:opacity-64 data-highlighted:bg-accent data-selected:bg-foreground/8 data-highlighted:text-accent-foreground data-selected:text-foreground data-highlighted:data-selected:bg-accent hover:bg-accent hover:text-accent-foreground sm:min-h-7 sm:text-sm [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      data-slot="combobox-item"
      {...props}
    >
      <div
        className={cn(
          "min-w-0 flex-1 [&_svg:not([class*='text-'])]:text-muted-foreground",
          contentClassName,
        )}
        data-slot="combobox-item-content"
      >
        {children}
      </div>
    </Primitive.Item>
  );
}

function ComboboxSeparator({ className, ...props }: Primitive.Separator.Props) {
  return (
    <Primitive.Separator
      className={cn("mx-2 my-1 h-px bg-border last:hidden", className)}
      data-slot="combobox-separator"
      {...props}
    />
  );
}

function ComboboxGroup({ className, ...props }: Primitive.Group.Props) {
  return (
    <Primitive.Group
      className={cn("[[role=group]+&]:mt-1.5", className)}
      data-slot="combobox-group"
      {...props}
    />
  );
}

function ComboboxGroupLabel({ className, ...props }: Primitive.GroupLabel.Props) {
  return (
    <Primitive.GroupLabel
      className={cn("px-2 py-1.5 font-medium text-muted-foreground text-xs", className)}
      data-slot="combobox-group-label"
      {...props}
    />
  );
}

const comboboxEmptyCls1 = "not-empty:p-2 text-center text-base text-muted-foreground sm:text-sm";

function ComboboxEmpty({ className, ...props }: Primitive.Empty.Props) {
  return (
    <Primitive.Empty
      className={cn(comboboxEmptyCls1, className)}
      data-slot="combobox-empty"
      {...props}
    />
  );
}

function ComboboxRow(props: Primitive.Row.Props) {
  return <Primitive.Row data-slot="combobox-row" {...props} />;
}

function ComboboxValue(props: Primitive.Value.Props) {
  return <Primitive.Value data-slot="combobox-value" {...props} />;
}

function ComboboxList({ className, ...props }: Primitive.List.Props) {
  return (
    <ScrollArea scrollbarGutter scrollFade>
      <Primitive.List
        data-slot="combobox-list"
        className={cn("not-empty:scroll-py-1 not-empty:px-1 not-empty:py-1", className)}
        {...props}
      />
    </ScrollArea>
  );
}

/** Same list without the ScrollArea: an external virtualiser owns scrolling. */
function ComboboxListVirtualized({ className, ...props }: Primitive.List.Props) {
  return (
    <Primitive.List
      className={cn("not-empty:px-1 not-empty:py-1", className)}
      data-slot="combobox-list"
      {...props}
    />
  );
}

const comboboxStatusCls1 =
  "px-3 py-2 font-medium text-muted-foreground text-xs empty:m-0 empty:p-0";

function ComboboxStatus({ className, ...props }: Primitive.Status.Props) {
  return (
    <Primitive.Status
      className={cn(comboboxStatusCls1, className)}
      data-slot="combobox-status"
      {...props}
    />
  );
}

export {
  ComboboxListVirtualized,
  ComboboxSearchInput,
  ComboboxGroupLabel,
  ComboboxCollection,
  ComboboxChipsInput,
  useComboboxFilter,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxStatus,
  ComboboxValue,
  ComboboxPopup,
  ComboboxInput,
  ComboboxGroup,
  ComboboxEmpty,
  ComboboxClear,
  ComboboxChips,
  ComboboxList,
  ComboboxItem,
  ComboboxChip,
  ComboboxRow,
  Combobox,
};
