"use client";

import { cn } from "~/util/utils";
import { type VariantProps, cva } from "class-variance-authority";
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";

const toggleDefaults = { variant: "default", size: "default" } as const;

const toggleVariants = cva(
  "[&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-full border font-medium text-base text-foreground outline-none transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-pressed:bg-input/64 data-pressed:text-accent-foreground sm:text-sm [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        outline:
          "border-input bg-background not-dark:bg-clip-padding shadow-xs/5 not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:bg-input/32 dark:data-pressed:bg-input dark:hover:bg-input/64 dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] dark:not-disabled:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/2%)] [:disabled,:active,[data-pressed]]:shadow-none",
        segmented:
          "border-transparent text-muted-foreground shadow-none transition-colors before:shadow-none hover:bg-background/55 hover:text-foreground data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-xs/10 dark:hover:bg-input/32 dark:data-pressed:bg-input/72",
        ghost:
          "border-transparent text-foreground shadow-none [:disabled,:active,[data-pressed]]:shadow-none before:shadow-none data-pressed:bg-accent data-pressed:text-accent-foreground disabled:opacity-100 disabled:text-muted-foreground disabled:[&_svg]:opacity-100",
        default: "border-transparent",
      },
      size: {
        compact:
          "h-7 min-w-7 rounded-full px-[calc(--spacing(1)-1px)] text-xs before:rounded-full [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-9 min-w-9 px-[calc(--spacing(2)-1px)] sm:h-8 sm:min-w-8",
        lg: "h-10 min-w-10 px-[calc(--spacing(2.5)-1px)] sm:h-9 sm:min-w-9",
        segmented: "h-6 min-w-0 rounded-full px-2.5 text-xs before:rounded-full",
        sm: "h-8 min-w-8 px-[calc(--spacing(1.5)-1px)] sm:h-7 sm:min-w-7",
        xs: "h-7 min-w-7 px-[calc(--spacing(1)-1px)] sm:h-6 sm:min-w-6 rounded-full",
      },
    },
    defaultVariants: toggleDefaults,
  },
);

function Toggle(incoming: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  const { className, variant, size, ...props } = incoming;
  return (
    <TogglePrimitive
      className={cn(toggleVariants({ className, variant, size }))}
      data-slot="toggle"
      {...props}
    />
  );
}

export { toggleVariants, Toggle };
