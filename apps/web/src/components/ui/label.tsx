"use client";

import { cn } from "~/util/utils";
import { useRender } from "@base-ui/react/use-render";
import { mergeProps } from "@base-ui/react/merge-props";

const labelCls1 =
  "inline-flex items-center gap-2 text-base/4.5 sm:text-sm/4 font-medium text-foreground";

function Label({ className, render, ...props }: useRender.ComponentProps<"label">) {
  const defaultProps = {
    "data-slot": "label",
    className: cn(labelCls1, className),
  };

  const merged = mergeProps<"label">(defaultProps, props);
  return useRender({ render, props: merged, defaultTagName: "label" });
}

export { Label };
