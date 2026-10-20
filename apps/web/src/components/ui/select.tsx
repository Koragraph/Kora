"use client";

import { cn } from "~/util/utils";
import type * as React from "react";
import { ChevronsUpDownIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { type VariantProps, cva } from "class-variance-authority";
import { useRender } from "@base-ui/react/use-render";
import { Select as Primitive } from "@base-ui/react/select";
import { mergeProps } from "@base-ui/react/merge-props";

const Select = Primitive.Root;

const selectTriggerVariants = cva(
  "relative inline-flex cursor-pointer select-none items-center justify-between gap-2 rounded-full border text-left text-base outline-none transition-[color,box-shadow,background-color] disabled:pointer-events-none disabled:opacity-64 sm:text-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "w-full min-w-36 border-input bg-background not-dark:bg-clip-padding text-foreground shadow-xs/5 ring-ring/24 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-full)-1px)] not-data-disabled:not-focus-visible:not-aria-invalid:not-data-popup-open:before:shadow-[0_1px_--theme(--color-black/4%)] focus-visible:border-ring focus-visible:ring-[3px] aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:ring-destructive/16 data-disabled:shadow-none focus-visible:shadow-none aria-invalid:shadow-none data-popup-open:shadow-none dark:bg-(--lift-inset-bg) dark:shadow-(--lift-inset-shadow) dark:aria-invalid:ring-destructive/24 dark:not-data-disabled:not-focus-visible:not-aria-invalid:not-data-popup-open:before:shadow-[0_-1px_--theme(--color-white/6%)] [&_svg]:opacity-80 [&_svg:not([class*='text-'])]:text-icon-muted",
        ghost:
          "border-transparent text-secondary-label focus-visible:ring-2 focus-visible:ring-ring hover:bg-accent hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground",
      },
      size: {
        xs: "h-7 gap-1 rounded-md px-[calc(--spacing(2)-1px)] text-sm sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
        compact:
          "h-7 gap-1 rounded-md px-[calc(--spacing(2)-1px)] text-xs [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3.5",
        sm: "min-h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:min-h-7",
        default: "min-h-9 px-[calc(--spacing(3)-1px)] sm:min-h-8",
        lg: "min-h-10 px-[calc(--spacing(3)-1px)] sm:min-h-9",
      },
    },
    defaultVariants: { size: "default", variant: "default" },
  },
);

type TriggerVariantProps = VariantProps<typeof selectTriggerVariants>;

function SelectTrigger({
  variant = "default",
  size = "default",
  className,
  children,
  icon,
  ...props
}: Primitive.Trigger.Props &
  TriggerVariantProps & {
    icon?: React.ReactNode;
  }) {
  return (
    <Primitive.Trigger
      className={cn(selectTriggerVariants({ size, variant }), className)}
      data-slot="select-trigger"
      {...props}
    >
      {children}
      <Primitive.Icon data-slot="select-icon">
        {icon ?? <ChevronDownIcon className="-me-1 size-3 opacity-50" />}
      </Primitive.Icon>
    </Primitive.Trigger>
  );
}

function SelectButton({
  className,
  size = "default",
  variant = "default",
  render,
  children,
  ...props
}: useRender.ComponentProps<"button"> & TriggerVariantProps) {
  const ghost = variant === "ghost";
  const defaultProps = {
    className: cn(selectTriggerVariants({ size, variant }), "min-w-none", className),
    "data-slot": "select-button",
    type: render ? undefined : ("button" as const),
    children: (
      <>
        <span className="flex-1 truncate in-data-placeholder:text-placeholder">{children}</span>
        {ghost ? (
          <ChevronDownIcon className="-me-1 size-3 opacity-50" />
        ) : (
          <ChevronsUpDownIcon className="-me-1 opacity-80" />
        )}
      </>
    ),
  };
  const merged = mergeProps<"button">(defaultProps, props);
  return useRender({ render, props: merged, defaultTagName: "button" });
}

function SelectValue({ className, ...props }: Primitive.Value.Props) {
  return (
    <Primitive.Value
      className={cn("flex-1 truncate data-placeholder:text-placeholder", className)}
      data-slot="select-value"
      {...props}
    />
  );
}

function SelectPopup(
  incoming: Primitive.Popup.Props & {
    popupClassName?: string;
    side?: Primitive.Positioner.Props["side"];
    sideOffset?: Primitive.Positioner.Props["sideOffset"];
    align?: Primitive.Positioner.Props["align"];
    alignOffset?: Primitive.Positioner.Props["alignOffset"];
    alignItemWithTrigger?: Primitive.Positioner.Props["alignItemWithTrigger"];
    matchTriggerWidth?: boolean;
    anchor?: Primitive.Positioner.Props["anchor"];
  },
) {
  const {
    alignItemWithTrigger = true,
    matchTriggerWidth = true,
    side = "bottom",
    alignOffset = 0,
    align = "start",
    sideOffset = 4,
    popupClassName,
    className,
    children,
    anchor,
    ...props
  } = incoming;
  return (
    <Primitive.Portal>
      <Primitive.Positioner
        alignItemWithTrigger={alignItemWithTrigger}
        className="z-[130] select-none"
        data-slot="select-positioner"
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        anchor={anchor}
        align={align}
        side={side}
      >
        <Primitive.Popup
          className={cn(
            "origin-(--transform-origin) rounded-xl text-foreground outline-none",
            popupClassName,
          )}
          data-slot="select-popup"
          {...props}
        >
          <Primitive.ScrollUpArrow
            className="top-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:top-px before:h-[200%] before:rounded-t-[calc(var(--radius-xl)-1px)] before:bg-linear-to-b before:from-50% before:from-popover"
            data-slot="select-scroll-up-arrow"
          >
            <ChevronUpIcon className="relative size-4.5 sm:size-4" />
          </Primitive.ScrollUpArrow>
          <div
            className={cn(
              "dropdown-glass relative h-full rounded-xl shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
              matchTriggerWidth && "min-w-(--anchor-width)",
            )}
          >
            <Primitive.List
              className={cn("max-h-(--available-height) overflow-y-auto p-1", className)}
              data-slot="select-list"
            >
              {children}
            </Primitive.List>
          </div>
          <Primitive.ScrollDownArrow
            className="bottom-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:bottom-px before:h-[200%] before:rounded-b-[calc(var(--radius-xl)-1px)] before:bg-linear-to-t before:from-50% before:from-popover"
            data-slot="select-scroll-down-arrow"
          >
            <ChevronDownIcon className="relative size-4.5 sm:size-4" />
          </Primitive.ScrollDownArrow>
        </Primitive.Popup>
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  hideIndicator: _hideIndicator,
  ...props
}: Primitive.Item.Props & { hideIndicator?: boolean }) {
  return (
    <Primitive.Item
      className={cn(
        "flex min-h-8 cursor-pointer items-center rounded-sm px-2 py-1 text-base outline-none in-data-[side=none]:min-w-[calc(var(--anchor-width)+--spacing(5))] data-disabled:cursor-not-allowed data-disabled:opacity-64 data-highlighted:bg-accent data-selected:bg-foreground/8 data-highlighted:text-accent-foreground sm:min-h-7 sm:text-sm [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      data-slot="select-item"
      {...props}
    >
      <Primitive.ItemText
        className="min-w-0 flex-1 [&_svg:not([class*='text-'])]:text-muted-foreground"
        data-slot="select-item-text"
      >
        {children}
      </Primitive.ItemText>
    </Primitive.Item>
  );
}

function SelectSeparator({ className, ...props }: Primitive.Separator.Props) {
  return (
    <Primitive.Separator
      className={cn("mx-2 my-1 h-px bg-border", className)}
      data-slot="select-separator"
      {...props}
    />
  );
}

function SelectGroup(props: Primitive.Group.Props) {
  return <Primitive.Group data-slot="select-group" {...props} />;
}

function SelectGroupLabel({ className, ...props }: Primitive.GroupLabel.Props) {
  return (
    <Primitive.GroupLabel
      className={cn("px-2 py-1.5 font-medium text-muted-foreground text-xs", className)}
      data-slot="select-group-label"
      {...props}
    />
  );
}

export {
  Select,
  SelectItem,
  SelectGroup,
  SelectPopup,
  SelectValue,
  SelectButton,
  SelectTrigger,
  SelectSeparator,
  SelectGroupLabel,
  selectTriggerVariants,
  SelectPopup as SelectContent,
};
