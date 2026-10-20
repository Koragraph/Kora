import type { CSSProperties } from "react";

/** Shadow-root overrides that make a Pierre file tree read as part of the app chrome. */
const tint = (percent: number) => `color-mix(in srgb, currentColor ${percent}%, transparent)`;

export const PIERRE_TREE_UNSAFE_CSS = `
  :host {
    --trees-font-size-override: 12px;
    --trees-font-family-override: var(--font-sans);
    --trees-border-color-override: ${tint(14)};
    --trees-hover-bg-override: ${tint(7)};
    --trees-selected-bg-override: ${tint(12)};
    --trees-bg-override: transparent;
    /* Ink: Pierre's accent (#009fff) drives the focus ring and the focused-selection border,
       and its git palette is teal/cyan. Route all of them through the app's tokens. */
    --trees-accent-override: var(--ring);
    --trees-focus-ring-color-override: var(--ring);
    --trees-selected-focused-border-color-override: var(--ring);
    --trees-status-added-override: var(--diff-addition-foreground);
    --trees-status-untracked-override: var(--diff-addition-foreground);
    --trees-status-deleted-override: var(--diff-deletion-foreground);
    --trees-status-modified-override: var(--warning-foreground);
    --trees-status-renamed-override: var(--warning-foreground);
    --trees-git-added-color-override: var(--diff-addition-foreground);
    --trees-git-untracked-color-override: var(--diff-addition-foreground);
    --trees-git-deleted-color-override: var(--diff-deletion-foreground);
    --trees-git-modified-color-override: var(--warning-foreground);
    --trees-git-renamed-color-override: var(--warning-foreground);
  }
  button[data-type='item'] { border-radius: 5px; }
`;

/** Host styles that keep a Pierre tree on the active color scheme and foreground. */
export function pierreTreeStyle(colorScheme: "light" | "dark"): CSSProperties {
  return {
    ["--trees-fg-override" as string]: "var(--contrast-foreground)",
    colorScheme,
  };
}
