"use client";

import { cn } from "~/util/utils";
import type * as React from "react";
import { type VariantProps, cva } from "class-variance-authority";
import { useRender } from "@base-ui/react/use-render";
import { mergeProps } from "@base-ui/react/merge-props";

const buttonBase = [
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap",
  "rounded-[var(--control-radius)] border font-medium text-base outline-none sm:text-sm",
  "transition-[box-shadow,scale] active:not-aria-[haspopup]:scale-[0.97]",
  "before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)]",
  "pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
  "disabled:pointer-events-none disabled:opacity-64",
  "[&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0",
  "[&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
  "[&_svg:not([class*='text-'])]:text-[var(--control-icon-color,currentColor)]",
].join(" ");

// Hairline drawn on the inner layer of outlined buttons.
const hairline =
  "before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/2%)]";

const pressHighlight =
  "not-disabled:not-active:not-data-pressed:before:shadow-[inset_0_1px_--theme(--color-white/16%)] active:before:shadow-[inset_0_1px_--theme(--color-black/8%)] data-pressed:before:shadow-[inset_0_1px_--theme(--color-black/8%)] disabled:shadow-none active:shadow-none data-pressed:shadow-none";

const FILLED_PRIMARY = cn(
  "border-primary bg-primary text-primary-foreground shadow-xs shadow-primary/24 hover:bg-primary/90 data-pressed:bg-primary/90",
  pressHighlight,
);
const FILLED_DESTRUCTIVE = cn(
  "border-destructive bg-destructive text-white shadow-xs shadow-destructive/24 hover:bg-destructive/90 data-pressed:bg-destructive/90",
  pressHighlight,
);

const buttonVariants = cva(buttonBase, {
  variants: {
    variant: {
      default: FILLED_PRIMARY,
      destructive: FILLED_DESTRUCTIVE,
      "destructive-outline": cn(
        "border-input bg-popover not-dark:bg-clip-padding text-destructive-foreground shadow-xs/5 dark:bg-input/32",
        hairline,
        "hover:border-destructive/32 hover:bg-destructive/4 dark:not-active:not-data-pressed:hover:before:shadow-[0_-1px_--theme(--color-white/6%)]",
      ),
      ghost:
        "border-transparent text-foreground [--control-icon-color:var(--contrast-muted-foreground)] hover:bg-accent data-pressed:bg-accent",
      "ghost-muted":
        "border-transparent text-muted-foreground [--control-icon-color:var(--contrast-muted-foreground)] hover:bg-accent hover:text-foreground data-pressed:bg-accent",
      glass: "surface-glass border-border/60 text-foreground shadow-sm hover:border-border",
      link: "border-transparent underline-offset-4 hover:underline",
      "media-close":
        "border-transparent bg-black/65 text-white shadow-sm ring-1 ring-white/20 [--control-icon-color:currentColor] hover:bg-black/80 focus-visible:ring-white",
      "media-navigation":
        "absolute top-1/2 z-20 -translate-y-1/2 border-transparent text-white/90 hover:bg-white/10 hover:text-white focus-visible:ring-white",
      outline: cn(
        "border-input bg-popover not-dark:bg-clip-padding text-foreground shadow-xs/5 [--control-icon-color:var(--contrast-muted-foreground)] dark:bg-input/32",
        hairline,
        "hover:bg-accent/50 data-pressed:bg-accent/50 dark:hover:bg-input/64 dark:data-pressed:bg-input/64",
      ),
      overlay: "border-transparent bg-black/70 text-white/65 hover:bg-black/90",
      secondary:
        "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/90 active:bg-secondary/80 data-pressed:bg-secondary/80",
      "warning-outline":
        "border-warning/32 bg-warning-surface text-warning-foreground shadow-xs/5 hover:border-warning/40 hover:bg-warning/16 dark:hover:bg-warning/24",
      chip: "",
    },
    size: {
      "icon-xs":
        "size-7 sm:size-6 sm:after:absolute sm:after:-inset-0.5 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 not-in-data-[slot=input-group]:sm:[&_svg:not([class*='size-'])]:size-3.5",
      xs: "h-7 gap-1 px-[calc(--spacing(2)-1px)] text-sm sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      xl: "h-11 px-[calc(--spacing(4)-1px)] text-lg sm:h-10 sm:text-base [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
      "sm-multiline":
        "min-h-8 gap-1.5 whitespace-normal px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)] sm:min-h-7",
      "icon-xl":
        "size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
      compact:
        "h-7 gap-1 px-[calc(--spacing(2.5)-1px)] text-xs [&_svg:not([class*='size-'])]:size-3.5",
      micro:
        "h-5 gap-1 px-[calc(--spacing(2)-1px)] text-[11px] [&_svg:not([class*='size-'])]:size-3",
      "icon-tiny":
        "size-4 p-0 after:absolute after:-inset-1.5 [&_svg:not([class*='size-'])]:size-3",
      "icon-micro": "size-5 p-0 after:absolute after:-inset-1 [&_svg:not([class*='size-'])]:size-3",
      sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7",
      default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
      lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9",
      "icon-lg": "size-10 sm:size-9",
      "icon-sm": "size-8 sm:size-7",
      icon: "size-9 sm:size-8",
    },
  },
  defaultVariants: { size: "default", variant: "default" },
});

type ButtonVariantProps = VariantProps<typeof buttonVariants>;

interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: ButtonVariantProps["variant"];
  size?: ButtonVariantProps["size"];
}

function Button({
  className,
  variant = "default",
  size = "default",
  render,
  ...props
}: ButtonProps) {
  const defaultProps = {
    className:
      variant === "chip" ? cn(className) : cn(buttonVariants({ size, variant }), className),
    "data-slot": "button",
    type: render ? undefined : ("button" as const),
  };

  const merged = mergeProps<"button">(defaultProps, props);
  return useRender({ render, props: merged, defaultTagName: "button" });
}

function InlineButton({
  className,
  underline = false,
  ...props
}: React.ComponentProps<"button"> & { underline?: boolean }) {
  return (
    <button
      className={cn(
        "inline-flex shrink-0 cursor-pointer gap-0.5 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64",
        underline && "border-b border-transparent hover:border-current",
        className,
      )}
      data-slot="inline-button"
      type="button"
      {...props}
    />
  );
}

export { Button, InlineButton, buttonVariants };
