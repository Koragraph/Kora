"use client";

import { cn } from "~/util/utils";
import type * as React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { Field as FieldPrimitive } from "@base-ui/react/field";

type TextareaProps = React.ComponentProps<"textarea"> & {
  unstyled?: boolean;
  size?: "sm" | "default" | "lg" | number;
};

const textareaCls1 =
  "min-h-16.5 px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)] max-sm:min-h-19.5";

function Textarea({ unstyled = false, size = "default", className, ...props }: TextareaProps) {
  return (
    <span
      className={
        cn(
          !unstyled &&
            "relative inline-flex w-full rounded-2xl border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] sm:text-sm dark:bg-(--lift-inset-bg) dark:shadow-(--lift-inset-shadow) dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]",
          className,
        ) || undefined
      }
      data-slot="textarea-control"
      data-size={size}
    >
      <FieldPrimitive.Control
        render={(defaultProps) => (
          <textarea
            data-slot="textarea"
            className={cn(
              "field-sizing-content min-h-17.5 w-full rounded-[inherit] px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] outline-none max-sm:min-h-20.5",
              size === "sm" && textareaCls1,
              size === "lg" && "min-h-18.5 py-[calc(--spacing(2)-1px)] max-sm:min-h-21.5",
            )}
            {...mergeProps(defaultProps, props)}
          />
        )}
      />
    </span>
  );
}

export { type TextareaProps, Textarea };
