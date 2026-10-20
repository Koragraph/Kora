"use client";

import { cn } from "~/util/utils";
import { type TextareaProps, Textarea } from "~/components/ui/textarea";
import { type InputProps, Input } from "~/components/ui/input";
import type * as React from "react";
import { type VariantProps, cva } from "class-variance-authority";

const inputGroupVariants = cva(
  "relative inline-flex w-full min-w-0 items-center rounded-[var(--control-radius)] border text-base text-foreground ring-ring/24 transition-shadow has-[input:focus-visible,textarea:focus-visible]:has-[input[aria-invalid],textarea[aria-invalid]]:border-destructive/64 has-[input:focus-visible,textarea:focus-visible]:has-[input[aria-invalid],textarea[aria-invalid]]:ring-destructive/16 has-[textarea]:h-auto has-data-[align=block-end]:h-auto has-data-[align=block-start]:h-auto has-data-[align=block-end]:flex-col has-data-[align=block-start]:flex-col has-[input:focus-visible,textarea:focus-visible]:border-ring has-[input[aria-invalid],textarea[aria-invalid]]:border-destructive/36 has-autofill:bg-foreground/4 has-[input:disabled,textarea:disabled]:opacity-64 has-[input:disabled,textarea:disabled,input:focus-visible,textarea:focus-visible,input[aria-invalid],textarea[aria-invalid]]:shadow-none has-[input:focus-visible,textarea:focus-visible]:ring-[3px] sm:text-sm dark:has-autofill:bg-foreground/8 dark:has-[input[aria-invalid],textarea[aria-invalid]]:ring-destructive/24 has-data-[align=inline-start]:**:[[data-size=sm]_input]:ps-1.5 has-data-[align=inline-end]:**:[[data-size=sm]_input]:pe-1.5 *:[[data-slot=input-control],[data-slot=textarea-control]]:contents *:[[data-slot=input-control],[data-slot=textarea-control]]:before:hidden has-[[data-align=block-start],[data-align=block-end]]:**:[input]:h-auto has-data-[align=inline-start]:**:[input]:ps-2 has-data-[align=inline-end]:**:[input]:pe-2 has-data-[align=block-end]:**:[input]:pt-1.5 has-data-[align=block-start]:**:[input]:pb-1.5 **:[textarea]:min-h-20.5 **:[textarea]:resize-none **:[textarea]:py-[calc(--spacing(3)-1px)] **:[textarea]:max-sm:min-h-23.5 **:[textarea_button]:rounded-[calc(var(--control-radius)-1px)]",
  {
    variants: {
      variant: {
        default:
          "border-input bg-background not-dark:bg-clip-padding shadow-xs/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] not-has-[input:disabled,textarea:disabled]:not-has-[input:focus-visible,textarea:focus-visible]:not-has-[input[aria-invalid],textarea[aria-invalid]]:before:shadow-[0_1px_--theme(--color-black/4%)] dark:bg-(--lift-inset-bg) dark:shadow-(--lift-inset-shadow) dark:not-has-[input:disabled,textarea:disabled]:not-has-[input:focus-visible,textarea:focus-visible]:not-has-[input[aria-invalid],textarea[aria-invalid]]:before:shadow-[0_-1px_--theme(--color-white/6%)]",
        ghost:
          "border-transparent bg-transparent shadow-none hover:bg-muted/40 has-[input:focus-visible,textarea:focus-visible]:bg-background",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function InputGroup({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group"
      className={cn(inputGroupVariants({ variant }), className)}
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "[&_svg]:-mx-0.5 flex h-auto cursor-text select-none items-center justify-center gap-2 leading-none in-[[data-slot=input-group]:has([data-slot=input-control],[data-slot=textarea-control])]:[&_svg:not([class*='size-'])]:size-4.5 sm:in-[[data-slot=input-group]:has([data-slot=input-control],[data-slot=textarea-control])]:[&_svg:not([class*='size-'])]:size-4 not-has-[button]:**:[svg:not([class*='opacity-'])]:opacity-80",
  {
    variants: {
      align: {
        "block-start":
          "order-first w-full justify-start px-[calc(--spacing(3)-1px)] pt-[calc(--spacing(3)-1px)] [.border-b]:pb-[calc(--spacing(3)-1px)] [[data-size=sm]+&]:px-[calc(--spacing(2.5)-1px)]",
        "block-end":
          "order-last w-full justify-start px-[calc(--spacing(3)-1px)] pb-[calc(--spacing(3)-1px)] [.border-t]:pt-[calc(--spacing(3)-1px)] [[data-size=sm]+&]:px-[calc(--spacing(2.5)-1px)]",
        "inline-start":
          "has-[>:last-child[data-slot=badge]]:-ms-1.5 has-[>button]:-ms-2 order-first ps-[calc(--spacing(3)-1px)] [[data-size=sm]+&]:ps-[calc(--spacing(2.5)-1px)]",
        "inline-end":
          "has-[>:last-child[data-slot=badge]]:-me-1.5 has-[>button]:-me-2 order-last pe-[calc(--spacing(3)-1px)] [[data-size=sm]+&]:pe-[calc(--spacing(2.5)-1px)]",
      },
    },
    defaultVariants: {
      align: "inline-start",
    },
  },
);

const inputGroupAddonCls1 =
  "button, a, input, select, textarea, [role='button'], [role='combobox'], [role='listbox'], [data-slot='select-trigger']";

function InputGroupAddon(
  incoming: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>,
) {
  const { align = "inline-start", className, ...props } = incoming;
  return (
    <div
      data-align={align}
      onMouseDown={(e) => {
        const target = e.target as HTMLElement;
        const isInteractive = target.closest(inputGroupAddonCls1);
        if (isInteractive) {
          return;
        }
        e.preventDefault();
        const container = e.currentTarget.parentElement;
        const field = container?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          "input, textarea",
        );
        const alreadyFocused = container?.querySelector("input:focus, textarea:focus");
        if (field && !alreadyFocused) {
          field.focus();
        }
      }}
      data-slot="input-group-addon"
      className={cn(inputGroupAddonVariants({ align }), className)}
      {...props}
    />
  );
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "[&_svg]:-mx-0.5 line-clamp-1 flex items-center gap-2 text-muted-foreground leading-none in-[[data-slot=input-group]:has([data-slot=input-control],[data-slot=textarea-control])]:[&_svg:not([class*='size-'])]:size-4.5 sm:in-[[data-slot=input-group]:has([data-slot=input-control],[data-slot=textarea-control])]:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: InputProps) {
  return <Input className={className} unstyled {...props} />;
}

function InputGroupTextarea({ className, ...props }: TextareaProps) {
  return <Textarea className={className} unstyled {...props} />;
}

export { InputGroup, InputGroupAddon, InputGroupText, InputGroupInput, InputGroupTextarea };
