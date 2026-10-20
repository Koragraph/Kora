import type { ShellWebMarkupTheme } from "@kora/contracts";

const readVariable = (styles: CSSStyleDeclaration, label: string, backup: string): string =>
  styles.getPropertyValue(label).trim() || backup;

export function readWebMarkupTheme(): ShellWebMarkupTheme {
  const baseDir = document.documentElement;
  const styles = getComputedStyle(baseDir);
  return {
    colorScheme: baseDir.classList.contains("dark") ? "dark" : "light",
    fontMono: readVariable(styles, "--font-mono", "ui-monospace, monospace"),
    fontSans: readVariable(styles, "--font-sans", styles.fontFamily || "system-ui, sans-serif"),
    ring: readVariable(styles, "--ring", "oklch(0.269 0 0)"),
    input: readVariable(styles, "--contrast-input", "rgb(0 0 0 / 10%)"),
    border: readVariable(styles, "--contrast-border", "rgb(0 0 0 / 8%)"),
    accentForeground: readVariable(styles, "--contrast-accent-foreground", "oklch(0.269 0 0)"),
    accent: readVariable(styles, "--accent", "rgb(0 0 0 / 4%)"),
    mutedForeground: readVariable(styles, "--contrast-muted-foreground", "oklch(0.556 0 0)"),
    muted: readVariable(styles, "--muted", "rgb(0 0 0 / 4%)"),
    primaryForeground: readVariable(styles, "--primary-foreground", "white"),
    primary: readVariable(styles, "--primary", "oklch(0.269 0 0)"),
    popoverForeground: readVariable(styles, "--contrast-popover-foreground", "oklch(0.269 0 0)"),
    popover: readVariable(styles, "--popover", "white"),
    foreground: readVariable(styles, "--contrast-foreground", "oklch(0.269 0 0)"),
    background: readVariable(styles, "--background", "white"),
    radius: readVariable(styles, "--radius", "0.625rem"),
  };
}
