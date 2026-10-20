import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { terminalThemeFromApp } from "./theme";

type Style = {
  vars?: Record<string, string>;
  colorScheme?: string;
  color?: string;
  backgroundColor?: string;
};

/** A fake DOM where each element has a computed style; `dock` is what `[data-terminal-dock]` resolves to. */
function fakeDom(styles: { dock: Style; body: Style; root: Style }, darkClass = false) {
  const dock = { name: "dock" };
  const body = { name: "body" };
  const root = { name: "root", classList: { contains: (c: string) => c === "dark" && darkClass } };
  const byElement = new Map<object, Style>([
    [dock, styles.dock],
    [body, styles.body],
    [root, styles.root],
  ]);
  vi.stubGlobal("document", { querySelector: () => dock, body, documentElement: root });
  vi.stubGlobal("getComputedStyle", (element: object) => {
    const s = byElement.get(element) ?? {};
    return {
      getPropertyValue: (name: string) => s.vars?.[name] ?? "",
      colorScheme: s.colorScheme ?? "",
      color: s.color ?? "",
      backgroundColor: s.backgroundColor ?? "",
    };
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("terminal theme", () => {
  it("prefers the dock's terminal tokens over a light page", () => {
    fakeDom({
      dock: {
        colorScheme: "dark",
        vars: {
          "--terminal-background": "#000",
          "--terminal-foreground": "#fff",
          "--terminal-cursor": "#ddd",
          "--terminal-selection-background": "rgba(255, 255, 255, 0.2)",
        },
      },
      body: { color: "#111", backgroundColor: "#fff" },
      root: { vars: { "--terminal-background": "#fff", "--terminal-foreground": "#111" } },
    });
    expect(terminalThemeFromApp()).toEqual({
      background: "#000",
      foreground: "#fff",
      cursor: "#ddd",
      selectionBackground: "rgba(255, 255, 255, 0.2)",
    });
  });

  it("falls back to root tokens, then to the dock's own colours", () => {
    fakeDom({
      dock: { color: "rgb(1, 2, 3)", backgroundColor: "transparent" },
      body: { backgroundColor: "rgb(9, 9, 9)" },
      root: { vars: { "--terminal-foreground": "#abc" } },
    });
    const theme = terminalThemeFromApp();
    expect(theme.foreground).toBe("#abc");
    expect(theme.background).toBe("rgb(9, 9, 9)");
  });

  it("uses a neutral pair for the active scheme when nothing is set", () => {
    fakeDom({ dock: {}, body: {}, root: {} }, true);
    const dark = terminalThemeFromApp();
    expect(dark.background).toBe("#000000");
    expect(dark.selectionBackground).toBe("rgba(255, 255, 255, 0.18)");

    fakeDom({ dock: { colorScheme: "light" }, body: {}, root: {} }, true);
    expect(terminalThemeFromApp().background).toBe("#efeff1");
  });
});
