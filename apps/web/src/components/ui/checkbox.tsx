"use client";

import { cn } from "~/util/utils";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";

const DASH_PATH = "M5.252 12h13.496";
const TICK_PATH = "M5.252 12.7 10.2 18.63 18.748 5.37";

function TickGlyph({ path }: { path: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className="size-3.5 sm:size-3"
    >
      <path d={path} />
    </svg>
  );
}

function Checkbox(incoming: CheckboxPrimitive.Root.Props) {
  const { className, ...props } = incoming;
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-[6px] border border-input bg-background not-dark:bg-clip-padding shadow-xs/5 outline-none ring-ring transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[3px] not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:ring-destructive/48 data-disabled:opacity-64 sm:size-4 dark:not-data-checked:bg-input/32 dark:aria-invalid:ring-destructive/24 dark:not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] [[data-disabled],[data-checked],[aria-invalid]]:shadow-none",
        className,
      )}
      data-slot="checkbox"
      {...props}
    >
      <CheckboxPrimitive.Indicator
        render={(props, state) => (
          <span {...props}>
            <TickGlyph path={state.indeterminate ? DASH_PATH : TICK_PATH} />
          </span>
        )}
        data-slot="checkbox-indicator"
        className="-inset-px absolute flex items-center justify-center rounded-[6px] text-control-checked-foreground data-unchecked:hidden data-checked:bg-control-checked data-indeterminate:text-foreground"
      />
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
