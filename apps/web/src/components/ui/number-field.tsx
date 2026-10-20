"use client";

import { cn } from "~/util/utils";
import { Label } from "./label";
import * as React from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";

type FieldContextValue = { fieldId: string };

const NumberFieldContext = React.createContext<FieldContextValue | null>(null);

function NumberField({
  id,
  className,
  size = "default",
  ...props
}: NumberFieldPrimitive.Root.Props & { size?: "sm" | "default" | "lg" }) {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;
  const contextValue = React.useMemo(() => ({ fieldId }), [fieldId]);

  return (
    <NumberFieldContext.Provider value={contextValue}>
      <NumberFieldPrimitive.Root
        className={cn("flex w-full flex-col items-start gap-2", className)}
        data-slot="number-field"
        data-size={size}
        id={fieldId}
        {...props}
      />
    </NumberFieldContext.Provider>
  );
}

function NumberFieldGroup({ className, ...props }: NumberFieldPrimitive.Group.Props) {
  return (
    <NumberFieldPrimitive.Group
      className={cn(
        "relative flex w-full justify-between rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 outline-none ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-data-disabled:not-focus-within:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-within:border-ring focus-within:ring-[3px] has-autofill:bg-foreground/4 data-disabled:pointer-events-none data-disabled:opacity-64 has-[[aria-invalid]]:border-destructive/36 has-[[aria-invalid]]:focus-within:border-destructive/64 has-[[aria-invalid]]:focus-within:ring-destructive/48 sm:text-sm dark:bg-(--lift-inset-bg) dark:shadow-(--lift-inset-shadow) dark:has-autofill:bg-foreground/8 dark:has-[[aria-invalid]]:focus-within:ring-destructive/24 dark:not-data-disabled:not-focus-within:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 data-disabled:shadow-none focus-within:shadow-none",
        className,
      )}
      data-slot="number-field-group"
      {...props}
    />
  );
}

const STEP_BUTTON =
  "relative flex shrink-0 cursor-pointer items-center justify-center px-[calc(--spacing(3)-1px)] transition-colors pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-accent in-data-[size=sm]:px-[calc(--spacing(2.5)-1px)]";

function NumberFieldDecrement({ className, ...props }: NumberFieldPrimitive.Decrement.Props) {
  return (
    <NumberFieldPrimitive.Decrement
      data-slot="number-field-decrement"
      className={cn(STEP_BUTTON, "rounded-s-[calc(var(--radius-lg)-1px)]", className)}
      {...props}
    >
      <MinusIcon />
    </NumberFieldPrimitive.Decrement>
  );
}

function NumberFieldIncrement({ className, ...props }: NumberFieldPrimitive.Increment.Props) {
  return (
    <NumberFieldPrimitive.Increment
      data-slot="number-field-increment"
      className={cn(STEP_BUTTON, "rounded-e-[calc(var(--radius-lg)-1px)]", className)}
      {...props}
    >
      <PlusIcon />
    </NumberFieldPrimitive.Increment>
  );
}

function NumberFieldInput({ className, ...props }: NumberFieldPrimitive.Input.Props) {
  return (
    <NumberFieldPrimitive.Input
      className={cn(
        "h-8.5 w-full min-w-0 grow bg-transparent px-[calc(--spacing(3)-1px)] text-center tabular-nums leading-8.5 outline-none [transition:background-color_5000000s_ease-in-out_0s] sm:h-7.5 sm:leading-7.5",
        "in-data-[size=lg]:h-9.5 in-data-[size=lg]:leading-9.5 sm:in-data-[size=lg]:h-8.5 sm:in-data-[size=lg]:leading-8.5",
        "in-data-[size=sm]:h-7.5 in-data-[size=sm]:px-[calc(--spacing(2.5)-1px)] in-data-[size=sm]:leading-7.5 sm:in-data-[size=sm]:h-6.5 sm:in-data-[size=sm]:leading-8.5",
        className,
      )}
      data-slot="number-field-input"
      {...props}
    />
  );
}

function CursorGrowIcon(props: React.ComponentProps<"svg">) {
  return (
    <svg
      aria-hidden="true"
      fill="black"
      height="14"
      stroke="white"
      viewBox="0 0 24 14"
      width="26"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M19.5 5.5L6.5 5.5V1L1 6.5L6.5 12V7.5L19.5 7.5V12L25 6.5L19.5 1V5.5Z" />
    </svg>
  );
}

function NumberFieldScrubArea({
  className,
  label,
  ...props
}: NumberFieldPrimitive.ScrubArea.Props & { label: string }) {
  const context = React.useContext(NumberFieldContext);
  if (!context) {
    throw new Error(
      "NumberFieldScrubArea must be used within a NumberField component for accessibility.",
    );
  }

  return (
    <NumberFieldPrimitive.ScrubArea
      className={cn("flex cursor-ew-resize", className)}
      data-slot="number-field-scrub-area"
      {...props}
    >
      <Label className="cursor-ew-resize" htmlFor={context.fieldId}>
        {label}
      </Label>
      <NumberFieldPrimitive.ScrubAreaCursor className="drop-shadow-[0_1px_1px_#0008]">
        <CursorGrowIcon />
      </NumberFieldPrimitive.ScrubAreaCursor>
    </NumberFieldPrimitive.ScrubArea>
  );
}

export {
  NumberFieldContext,
  NumberField,
  NumberFieldGroup,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldInput,
  NumberFieldScrubArea,
  CursorGrowIcon,
  NumberFieldPrimitive,
};
