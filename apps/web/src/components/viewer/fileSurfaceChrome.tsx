/** One header row for every file surface: crumbs on the left, icon actions on the right. */

import { DIFF_SURFACE_THEME_UNSAFE_CSS } from "~/util/diffRendering";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { Toggle } from "../ui/toggle";
import { Spinner } from "../ui/spinner";
import { Button } from "../ui/button";
import type { ReactNode } from "react";

export const FILE_SURFACE_SUBHEADER_CLASS =
  "flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 [[data-web-panel-mode=inline]_&]:mb-3 [[data-web-panel-mode=inline]_&]:h-7 [[data-web-panel-mode=inline]_&]:min-h-7 [[data-web-panel-mode=inline]_&]:border-transparent";

export const FILE_LINK_REVEAL_ATTRIBUTE = "data-file-link-reveal";

export const FILE_LINK_REVEAL_UNSAFE_CSS = `${DIFF_SURFACE_THEME_UNSAFE_CSS}
diffs-container {
  color: var(--code-foreground, var(--foreground)) !important;
  background-color: var(--code-background, var(--background)) !important;
  --diffs-dark-bg: var(--code-background, var(--background)) !important;
  --diffs-light-bg: var(--code-background, var(--background)) !important;
  --diffs-bg: var(--code-background, var(--background)) !important;
}
[${FILE_LINK_REVEAL_ATTRIBUTE}][data-line] {
  background-color: light-dark(
    color-mix(in lab, var(--diffs-computed-diff-line-bg) 82%, var(--diffs-bg-selection-override, var(--diffs-selection-base))),
    color-mix(in lab, var(--diffs-computed-diff-line-bg) 75%, var(--diffs-bg-selection-override, var(--diffs-selection-base)))
  ) !important;
}
[data-column-number][${FILE_LINK_REVEAL_ATTRIBUTE}] {
  background-color: light-dark(
    color-mix(in lab, var(--diffs-computed-diff-line-bg) 75%, var(--diffs-bg-selection-number-override, var(--diffs-selection-base))),
    color-mix(in lab, var(--diffs-computed-diff-line-bg) 60%, var(--diffs-bg-selection-number-override, var(--diffs-selection-base)))
  ) !important;
  color: var(--diffs-selection-number-fg) !important;
}
`;

/** Icon-only header action. A command is a plain button; only a toggle announces a pressed state. */
export function FileSurfaceAction({
  label,
  pressed,
  disabled = false,
  onPress,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const control =
    pressed === undefined ? (
      <Button
        aria-label={label}
        className="shrink-0"
        disabled={disabled}
        onClick={onPress}
        size="icon-sm"
        variant="ghost"
      />
    ) : (
      <Toggle
        aria-label={label}
        disabled={disabled}
        onPressedChange={() => onPress()}
        pressed={pressed}
        size="sm"
        variant="ghost"
      />
    );

  return (
    <Tooltip>
      <TooltipTrigger render={control}>{children}</TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

export function FileSurfaceNotice({ children }: { children: ReactNode }) {
  return (
    <div
      className="shrink-0 border-warning/20 border-b bg-warning-surface px-3 py-1.5 text-[11px] text-warning-foreground"
      role="status"
    >
      {children}
    </div>
  );
}

export function FileSurfaceLoading({ className }: { className?: string }) {
  return (
    <div
      aria-label="Loading file"
      className={`flex min-h-0 flex-1 items-center justify-center text-muted-foreground${className ? ` ${className}` : ""}`}
      role="status"
    >
      <Spinner className="size-5" />
    </div>
  );
}
