"use client";

import { cn } from "~/util/utils";
import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger(incoming: CollapsiblePrimitive.Trigger.Props) {
  const { className, ...props } = incoming;
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn("cursor-pointer", className)}
      {...props}
    />
  );
}

function CollapsiblePanel({ className, ...props }: CollapsiblePrimitive.Panel.Props) {
  // Reuses the local shadcn/Base UI panel; skip height travel for reduced motion.
  // https://ui.shadcn.com/docs/components/base/collapsible
  return (
    <CollapsiblePrimitive.Panel
      className={cn(
        "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0 data-open:data-ending-style:[height:var(--collapsible-panel-height)]",
        className,
      )}
      data-slot="collapsible-panel"
      {...props}
    />
  );
}

export {
  CollapsiblePanel as CollapsibleContent,
  CollapsibleTrigger,
  CollapsiblePanel,
  Collapsible,
};
