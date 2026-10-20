import { memo } from "react";

import { useHostIdentificationMode } from "../../hooks/usePrefs";
import { cn } from "../../util/utils";
import { stagePillLabel } from "./stagePill";
import { Badge } from "../ui/badge";
import { SidebarHeader, SidebarTrigger } from "../ui/sidebar";

export const NavChromeHeader = memo(function NavChromeHeader({ isNative }: { isNative: boolean }) {
  const hostIdentificationMode = useHostIdentificationMode();
  const pillLabel = hostIdentificationMode === "pill" ? stagePillLabel() : null;

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:pr-2 md:pl-0",
        isNative && "drag-region",
      )}
    >
      <SidebarTrigger className="relative z-10 md:hidden" />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 hidden rounded-full px-1.5 text-muted-foreground @[15rem]/sidebar-header:inline-flex"
          data-host-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </SidebarHeader>
  );
});
