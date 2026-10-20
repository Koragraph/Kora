"use client";

import { cn } from "~/util/utils";
import type * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

type InputProps = Omit<InputPrimitive.Props & React.RefAttributes<HTMLInputElement>, "size"> & {
  size?: "sm" | "compact" | "default" | "lg" | number;
  nativeInput?: boolean;
  unstyled?: boolean;
};

const inputCls1 = "h-7 px-[calc(--spacing(2.5)-1px)] text-xs leading-7 sm:h-7 sm:leading-7";
const inputCls2 = "h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5";
const inputCls3 =
  "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none";
const inputCls4 =
  "text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-foreground file:text-sm";

function Input({
  nativeInput = false,
  unstyled = false,
  size = "default",
  className,
  ...props
}: InputProps) {
  const inputClassName = cn(
    "h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3.5)-1px)] leading-8.5 outline-none placeholder:text-placeholder sm:h-7.5 sm:leading-7.5 [transition:background-color_5000000s_ease-in-out_0s]",
    size === "compact" && inputCls1,
    size === "sm" && inputCls2,
    size === "lg" && "h-9.5 leading-9.5 sm:h-8.5 sm:leading-8.5",
    props.type === "search" && inputCls3,
    props.type === "file" && inputCls4,
  );
  const sizeAttribute = typeof size === "number" ? size : undefined;

  const renderControl = (): React.ReactElement => {
    if (!nativeInput) {
      return (
        <InputPrimitive
          size={sizeAttribute}
          className={inputClassName}
          data-slot="input"
          {...props}
        />
      );
    }
    const { onValueChange: _onValueChange, style, ...nativeInputProps } = props;
    return (
      <input
        size={sizeAttribute}
        className={inputClassName}
        style={typeof style === "function" ? undefined : style}
        data-slot="input"
        {...(nativeInputProps as React.ComponentProps<"input">)}
      />
    );
  };
  const inputElement = renderControl();

  return (
    <span
      className={
        cn(
          !unstyled &&
            "relative inline-flex w-full rounded-full border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-full not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-autofill:bg-foreground/4 has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] sm:text-sm dark:bg-(--lift-inset-bg) dark:shadow-(--lift-inset-shadow) dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]",
          !unstyled && size === "compact" && "rounded-full before:rounded-full",
          className,
        ) || undefined
      }
      data-slot="input-control"
      data-size={size}
    >
      {inputElement}
    </span>
  );
}

export { type InputProps, Input };
