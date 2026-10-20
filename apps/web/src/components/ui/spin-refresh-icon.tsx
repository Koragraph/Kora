import { RefreshCwIcon } from "lucide-react";

import { cn } from "~/util/utils";
import { watchVisibleAnimation } from "~/util/visibleAnimation";

/** Keep the refresh glyph in place while its owning action is running. */
export function RefreshIcon({
  refreshing = false,
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof RefreshCwIcon> & { refreshing?: boolean }) {
  return (
    <RefreshCwIcon
      aria-hidden
      ref={refreshing ? watchVisibleAnimation : undefined}
      className={cn(refreshing && "motion-safe:visible-animate-spin", className)}
      {...props}
    />
  );
}
