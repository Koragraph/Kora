import { describe, expect, test, vi } from "vite-plus/test";

import { applyAppearanceContrast } from "./appearanceContrast";

/** Apply `level` to a fake root element and return the CSS variables that were set. */
function varsFor(level: number): Record<string, string> {
  const set = vi.fn();
  applyAppearanceContrast({ style: { setProperty: set } } as unknown as HTMLElement, level);
  return Object.fromEntries(set.mock.calls.map(([name, value]) => [name, value]));
}

describe("applyAppearanceContrast", () => {
  test.each([
    [100, "100%", "0%", "0%"],
    [70, "70%", "0%", "0%"],
    [135, "100%", "35%", "8.75%"],
    [200, "100%", "100%", "25%"],
  ])("level %i -> base %s, boost %s, border boost %s", (level, base, boost, border) => {
    expect(varsFor(level)).toEqual({
      "--appearance-contrast-base": base,
      "--appearance-contrast-boost": boost,
      "--appearance-contrast-border-boost": border,
    });
  });
});
