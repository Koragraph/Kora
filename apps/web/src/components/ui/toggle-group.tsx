"use client";

import { cn } from "~/util/utils";
import { type toggleVariants, Toggle as ToggleComponent } from "~/components/ui/toggle";
import { Separator } from "~/components/ui/separator";
import * as React from "react";
import type { VariantProps } from "class-variance-authority";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import type { Toggle as TogglePrimitive } from "@base-ui/react/toggle";

const TOGGLE_CONTEXT_DEFAULT: VariantProps<typeof toggleVariants> = {
  variant: "default",
  size: "default",
};
const ToggleGroupContext =
  React.createContext<VariantProps<typeof toggleVariants>>(TOGGLE_CONTEXT_DEFAULT);

const toggleGroupCls1 =
  "flex w-fit *:focus-visible:z-10 dark:*:[[data-slot=separator]:has(+[data-slot=toggle]:hover)]:before:bg-input/64 dark:*:[[data-slot=separator]:has(+[data-slot=toggle][data-pressed])]:before:bg-input dark:*:[[data-slot=toggle]:hover+[data-slot=separator]]:before:bg-input/64 dark:*:[[data-slot=toggle][data-pressed]+[data-slot=separator]]:before:bg-input";
const toggleGroupCls2 =
  "*:not-first:not-data-[slot=separator]:before:-start-[0.5px] *:not-last:not-data-[slot=separator]:before:-end-[0.5px] *:not-first:rounded-s-none *:not-last:rounded-e-none *:not-first:border-s-0 *:not-last:border-e-0 *:not-first:before:rounded-s-none *:not-last:before:rounded-e-none";
const toggleGroupCls3 =
  "*:not-first:not-data-[slot=separator]:before:-top-[0.5px] *:not-last:not-data-[slot=separator]:before:-bottom-[0.5px] flex-col *:not-first:rounded-t-none *:not-last:rounded-b-none *:not-first:border-t-0 *:not-last:border-b-0 *:not-first:before:rounded-t-none *:not-last:before:rounded-b-none *:data-[slot=toggle]:not-last:before:hidden dark:*:last:before:hidden dark:*:first:before:block";

function ToggleGroup(incoming: ToggleGroupPrimitive.Props & VariantProps<typeof toggleVariants>) {
  const {
    className,
    orientation = "horizontal",
    variant = "segmented",
    size = variant === "segmented" ? "segmented" : "default",
    children,
    ...props
  } = incoming;
  const value = React.useMemo(() => ({ variant, size }), [size, variant]);
  const coarseAfterClass =
    orientation === "horizontal"
      ? "*:pointer-coarse:after:min-w-auto"
      : "*:pointer-coarse:after:min-h-auto";
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      orientation={orientation}
      data-size={size}
      className={cn(
        toggleGroupCls1,
        coarseAfterClass,
        variant === "segmented"
          ? "gap-0.5 rounded-full bg-white/[0.06] p-0.5"
          : variant === "default"
            ? "gap-0.5"
            : orientation === "horizontal"
              ? toggleGroupCls2
              : toggleGroupCls3,
        className,
      )}
      data-variant={variant}
      {...props}
    >
      <ToggleGroupContext value={value}>{children}</ToggleGroupContext>
    </ToggleGroupPrimitive>
  );
}

function Toggle(incoming2: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  const { className, children, variant, size, ...props } = incoming2;
  const context = React.use(ToggleGroupContext);
  const resolvedSize = size ?? context.size;
  const resolvedVariant = variant ?? context.variant;

  return (
    <ToggleComponent
      data-variant={resolvedVariant}
      variant={resolvedVariant}
      data-size={resolvedSize}
      className={className}
      size={resolvedSize}
      {...props}
    >
      {children}
    </ToggleComponent>
  );
}

function ToggleGroupSeparator(
  incoming3: {
    className?: string;
  } & React.ComponentProps<typeof Separator>,
) {
  const { orientation = "vertical", className, ...props } = incoming3;
  return (
    <Separator
      className={cn(
        "pointer-events-none relative bg-input before:absolute before:inset-0 dark:before:bg-input/32",
        className,
      )}
      orientation={orientation}
      {...props}
    />
  );
}

export { ToggleGroup, Toggle, Toggle as ToggleGroupItem, ToggleGroupSeparator };
