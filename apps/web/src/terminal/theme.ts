import type { TerminalTheme } from "./xtermSurface";

/**
 * The terminal follows the app: `--terminal-*` tokens on the mount (or the root) win, then the dock's own text and
 * background colours, then a neutral pair for the scheme in effect. Colours stay CSS strings; xterm parses them.
 */
const NEUTRAL = {
  dark: {
    background: "#000000",
    foreground: "#f2f2f4",
    cursor: "#f2f2f4",
    selection: "rgba(255, 255, 255, 0.18)",
  },
  light: {
    background: "#efeff1",
    foreground: "#16171a",
    cursor: "#09090b",
    selection: "rgba(9, 9, 11, 0.14)",
  },
} as const;

const TRANSPARENT = new Set(["", "transparent", "rgba(0, 0, 0, 0)", "rgba(0 0 0 / 0)"]);

function solid(value: string | undefined | null): string | null {
  const v = (value ?? "").trim();
  return TRANSPARENT.has(v.toLowerCase()) ? null : v;
}

function isDark(scope: Element): boolean {
  const scheme = getComputedStyle(scope).colorScheme;
  if (scheme === "dark") return true;
  if (scheme === "light") return false;
  return document.documentElement.classList.contains("dark");
}

export function terminalThemeFromApp(mount?: HTMLElement | null): TerminalTheme {
  const dock =
    mount?.closest<HTMLElement>("[data-terminal-dock]") ??
    document.querySelector<HTMLElement>("[data-terminal-dock]") ??
    document.body;
  const scope = mount ?? dock;
  const local = getComputedStyle(scope);
  const root = getComputedStyle(document.documentElement);
  const token = (name: string) =>
    solid(local.getPropertyValue(name)) ?? solid(root.getPropertyValue(name));
  const dockStyle = getComputedStyle(dock);
  const bodyStyle = getComputedStyle(document.body);
  const neutral = isDark(scope) ? NEUTRAL.dark : NEUTRAL.light;

  return {
    background:
      token("--terminal-background") ??
      solid(dockStyle.backgroundColor) ??
      solid(bodyStyle.backgroundColor) ??
      neutral.background,
    foreground:
      token("--terminal-foreground") ??
      solid(dockStyle.color) ??
      solid(bodyStyle.color) ??
      neutral.foreground,
    cursor: solid(local.getPropertyValue("--terminal-cursor")) ?? neutral.cursor,
    selectionBackground:
      solid(local.getPropertyValue("--terminal-selection-background")) ?? neutral.selection,
  };
}
