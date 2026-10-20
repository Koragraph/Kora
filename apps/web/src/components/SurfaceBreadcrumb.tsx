import { cn } from "../util/utils";
import type { ReactNode } from "react";

interface WorkspaceBreadcrumbProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly ariaLabel: string;
}

const surfaceBreadcrumbCls1 = "m-0 flex min-w-0 list-none items-center gap-2 p-0 text-sm sm:gap-3";

export function SurfaceBreadcrumb({ ariaLabel, children, className }: WorkspaceBreadcrumbProps) {
  return (
    <nav className={cn("min-w-0", className)} aria-label={ariaLabel}>
      {/* Keep the flexible container draggable in Electron. Interactive
          descendants are excluded by the shared .drag-region CSS rules. */}
      <ol className={surfaceBreadcrumbCls1}>{children}</ol>
    </nav>
  );
}

interface WorkspaceBreadcrumbItemProps {
  readonly current?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

export function WorkspaceBreadcrumbItem(incoming: WorkspaceBreadcrumbItemProps) {
  const { current = false, className, children } = incoming;
  return (
    <li
      className={cn(
        current ? "text-foreground" : "shrink-0 text-muted-foreground",
        "flex min-w-0 items-center font-medium",
        className,
      )}
      aria-current={current ? "page" : undefined}
    >
      {children}
    </li>
  );
}
