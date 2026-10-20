import type { ReactElement, ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

/**
 * A styled hover hint for one element (replaces the native `title` tooltip). No label, or no DOM (server / node test
 * renderers), renders the child untouched.
 */
export function Hint({
  label,
  children,
  side,
}: {
  label: ReactNode;
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
}) {
  if (label === undefined || label === null || label === false || label === "") return children;
  if (typeof window === "undefined") return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup {...(side ? { side } : {})}>{label}</TooltipPopup>
    </Tooltip>
  );
}
