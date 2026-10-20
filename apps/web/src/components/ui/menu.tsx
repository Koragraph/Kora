"use client";

import { cn } from "~/util/utils";
import { ChevronRightIcon } from "lucide-react";
import { Menu as Primitive } from "@base-ui/react/menu";

const MenuCreateHandle = Primitive.createHandle;
const Menu = Primitive.Root;
const MenuPortal = Primitive.Portal;
const MenuGroup = Primitive.Group;
const MenuRadioGroup = Primitive.RadioGroup;
const MenuSub = Primitive.SubmenuRoot;

function MenuTrigger({ className, children, ...props }: Primitive.Trigger.Props) {
  return (
    <Primitive.Trigger className={className} data-slot="menu-trigger" {...props}>
      {children}
    </Primitive.Trigger>
  );
}

// A caller-supplied width utility (w-, min-w-, max-w-, any breakpoint prefix) replaces the default minimum.
const WIDTH_UTILITY = /(?:^|\s)(?:[\w-]+:)*(?:min-|max-)?w-/;

function MenuPopup(
  incoming: Primitive.Popup.Props & {
    align?: Primitive.Positioner.Props["align"];
    sideOffset?: Primitive.Positioner.Props["sideOffset"];
    alignOffset?: Primitive.Positioner.Props["alignOffset"];
    side?: Primitive.Positioner.Props["side"];
    anchor?: Primitive.Positioner.Props["anchor"];
  },
) {
  const {
    anchor,
    children,
    className,
    alignOffset,
    sideOffset = 4,
    side = "bottom",
    align = "center",
    ...props
  } = incoming;
  const hasWidth = typeof className === "string" && WIDTH_UTILITY.test(className);
  return (
    <Primitive.Portal>
      <Primitive.Positioner
        data-slot="menu-positioner"
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        className="z-[130]"
        anchor={anchor}
        align={align}
        side={side}
      >
        <Primitive.Popup
          className={cn(
            "dropdown-glass relative flex origin-(--transform-origin) rounded-xl shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
            !hasWidth && "min-w-32",
            className,
          )}
          data-slot="menu-popup"
          {...props}
        >
          <div className="max-h-(--available-height) w-full overflow-y-auto p-1.5">{children}</div>
        </Primitive.Popup>
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}

const ITEM_ICONS =
  "[&>svg]:pointer-events-none [&>svg]:-mx-0.5 [&>svg]:size-4.5 [&>svg]:opacity-80 sm:[&>svg]:size-4 [&>svg:not([class*='text-'])]:text-muted-foreground";

function MenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: Primitive.Item.Props & { inset?: boolean; variant?: "default" | "destructive" }) {
  return (
    <Primitive.Item
      className={cn(
        "flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1 text-base text-foreground outline-none data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-64 data-highlighted:bg-accent data-highlighted:text-accent-foreground data-[inset]:ps-8 data-[variant=destructive]:text-destructive-foreground sm:min-h-7 sm:text-sm",
        ITEM_ICONS,
        "data-[variant=destructive]:[&>svg]:text-current!",
        className,
      )}
      data-inset={inset ? "" : undefined}
      data-slot="menu-item"
      data-variant={variant}
      {...props}
    />
  );
}

function MenuCheckboxItem({
  className,
  children,
  checked,
  variant = "default",
  ...props
}: Primitive.CheckboxItem.Props & { variant?: "default" | "switch" }) {
  const isSwitch = variant === "switch";
  return (
    <Primitive.CheckboxItem
      checked={checked}
      className={cn(
        "grid min-h-8 cursor-pointer select-none items-center gap-2 rounded-sm py-1 text-base outline-none in-data-[side=none]:min-w-[calc(var(--anchor-width)+--spacing(5))] data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-64 data-highlighted:bg-accent data-highlighted:text-accent-foreground sm:min-h-7 sm:text-sm [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
        isSwitch ? "grid-cols-[1fr_auto] gap-4 ps-2 pe-1.5" : "grid-cols-[1rem_1fr] pe-4 ps-2",
        className,
      )}
      data-slot="menu-checkbox-item"
      {...props}
    >
      {isSwitch ? (
        <>
          <span className="col-start-1">{children}</span>
          <Primitive.CheckboxItemIndicator
            className="inline-flex h-[calc(var(--thumb-size)+2px)] w-[calc(var(--thumb-size)*2-2px)] shrink-0 items-center rounded-full bg-input p-px shadow-[inset_0_1px_--theme(--color-black/4%)] outline-none transition-[background-color,box-shadow] duration-200 [--thumb-size:--spacing(4)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:bg-control-checked sm:[--thumb-size:--spacing(3)]"
            keepMounted
          >
            <span className="pointer-events-none block h-(--thumb-size) w-(--thumb-size) origin-left rounded-(--thumb-size) bg-background shadow-xs/24 transition-[translate,border-radius,scale,transform-origin] duration-150 in-[[data-slot=menu-checkbox-item][data-checked]]:origin-[var(--thumb-size)_50%] in-[[data-slot=menu-checkbox-item][data-checked]]:translate-x-[calc(var(--thumb-size)-4px)] in-[[role=menuitemcheckbox]:active]:scale-x-110 in-[[role=menuitemcheckbox]:active]:rounded-[var(--thumb-size)/calc(var(--thumb-size)*1.1)]" />
          </Primitive.CheckboxItemIndicator>
        </>
      ) : (
        <>
          <Primitive.CheckboxItemIndicator className="col-start-1">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              strokeLinejoin="round"
              strokeLinecap="round"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
              height="24"
              fill="none"
              width="24"
            >
              <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
            </svg>
          </Primitive.CheckboxItemIndicator>
          <span className="col-start-2">{children}</span>
        </>
      )}
    </Primitive.CheckboxItem>
  );
}

function MenuRadioItem({
  className,
  children,
  hideIndicator: _hideIndicator,
  ...props
}: Primitive.RadioItem.Props & { hideIndicator?: boolean }) {
  return (
    <Primitive.RadioItem
      className={cn(
        "flex min-h-8 cursor-pointer select-none items-center rounded-sm px-2 py-1 text-base outline-none in-data-[side=none]:min-w-[calc(var(--anchor-width)+--spacing(5))] data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-64 data-checked:bg-foreground/8 data-highlighted:bg-accent data-highlighted:text-accent-foreground sm:min-h-7 sm:text-sm [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      data-slot="menu-radio-item"
      {...props}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
    </Primitive.RadioItem>
  );
}

function MenuRadioItemIndicator({
  className,
  children,
  ...props
}: import("react").ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      className={cn("shrink-0", className)}
      data-slot="menu-radio-item-indicator"
      {...props}
    >
      {children ?? <CheckGlyph />}
    </span>
  );
}

function CheckGlyph() {
  return (
    <svg
      strokeLinejoin="round"
      strokeLinecap="round"
      stroke="currentColor"
      className="size-3.5"
      viewBox="0 0 24 24"
      strokeWidth="2"
      fill="none"
    >
      <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
    </svg>
  );
}

function MenuGroupLabel({
  className,
  inset,
  ...props
}: Primitive.GroupLabel.Props & { inset?: boolean }) {
  return (
    <Primitive.GroupLabel
      className={cn(
        "px-2 py-1.5 font-medium text-muted-foreground text-xs data-[inset]:ps-9 sm:data-[inset]:ps-8",
        className,
      )}
      data-inset={inset ? "" : undefined}
      data-slot="menu-label"
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: Primitive.Separator.Props) {
  return (
    <Primitive.Separator
      className={cn("mx-2 my-1 h-px bg-border", className)}
      data-slot="menu-separator"
      {...props}
    />
  );
}

function MenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: Primitive.SubmenuTrigger.Props & { inset?: boolean }) {
  return (
    <Primitive.SubmenuTrigger
      className={cn(
        "flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1 text-base outline-none data-disabled:pointer-events-none data-disabled:opacity-64 data-highlighted:bg-accent data-highlighted:text-accent-foreground data-popup-open:bg-accent data-popup-open:text-accent-foreground data-[inset]:ps-8 sm:min-h-7 sm:text-sm",
        "[&>svg:not(:last-child)]:pointer-events-none [&>svg:not(:last-child)]:-mx-0.5 [&>svg:not(:last-child)]:size-4.5 [&>svg:not(:last-child)]:opacity-80 sm:[&>svg:not(:last-child)]:size-4 [&>svg:not(:last-child):not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      data-inset={inset ? "" : undefined}
      data-slot="menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRightIcon className="-me-0.5 ms-auto opacity-80" />
    </Primitive.SubmenuTrigger>
  );
}

function MenuSubPopup({
  align = "start",
  sideOffset = 0,
  alignOffset,
  className,
  ...props
}: import("react").ComponentProps<typeof MenuPopup>) {
  const defaultAlignOffset = align !== "center" && alignOffset === undefined ? -5 : alignOffset;
  return (
    <MenuPopup
      alignOffset={defaultAlignOffset}
      data-slot="menu-sub-content"
      sideOffset={sideOffset}
      className={className}
      side="inline-end"
      align={align}
      {...props}
    />
  );
}

export {
  MenuCreateHandle as DropdownMenuCreateHandle,
  MenuCheckboxItem as DropdownMenuCheckboxItem,
  MenuSubTrigger as DropdownMenuSubTrigger,
  MenuRadioGroup as DropdownMenuRadioGroup,
  MenuSubPopup as DropdownMenuSubContent,
  MenuSeparator as DropdownMenuSeparator,
  MenuRadioItem as DropdownMenuRadioItem,
  MenuGroupLabel as DropdownMenuLabel,
  MenuTrigger as DropdownMenuTrigger,
  MenuPortal as DropdownMenuPortal,
  MenuPopup as DropdownMenuContent,
  MenuGroup as DropdownMenuGroup,
  MenuItem as DropdownMenuItem,
  MenuSub as DropdownMenuSub,
  MenuRadioItemIndicator,
  Menu as DropdownMenu,
  MenuCreateHandle,
  MenuCheckboxItem,
  MenuSubTrigger,
  MenuRadioGroup,
  MenuGroupLabel,
  MenuSeparator,
  MenuRadioItem,
  MenuSubPopup,
  MenuTrigger,
  MenuPortal,
  MenuPopup,
  MenuGroup,
  MenuItem,
  MenuSub,
  Menu,
};
