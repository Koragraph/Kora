import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { resolveRestingPromptControlsLayout } from "../promptFooterLayout";
import { measureRestingPromptControls } from "./restingPromptControlsMeasurement";

/** A fake controls row: one 140px block, a 24px overflow button and a model picker with a label span. */
function measure(label: { clientWidth: number; flexGrow: string }, pickerMax = "none") {
  const labelEl = { clientWidth: label.clientWidth, scrollWidth: 160 };
  const pickerEl = {
    querySelector: () => labelEl,
    getBoundingClientRect: () => ({ width: 52 }),
  };
  const row = {
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 140 }) }],
    querySelector: (selector: string) => {
      if (selector === "[data-agent-model-picker]") return pickerEl;
      if (selector === "[data-resting-controls-overflow]") {
        return { getBoundingClientRect: () => ({ width: 24 }) };
      }
      return null;
    },
  };
  vi.stubGlobal("getComputedStyle", (el: unknown) => {
    if (el === labelEl) return { flexGrow: label.flexGrow };
    if (el === pickerEl) return { minWidth: "52px", maxWidth: pickerMax };
    return { columnGap: "4px" };
  });
  return measureRestingPromptControls(row as unknown as HTMLElement)!;
}

afterEach(() => vi.unstubAllGlobals());

describe("measureRestingPromptControls", () => {
  test("a flexible label squeezed to nothing is recovered to its full width", () => {
    const m = measure({ clientWidth: 0, flexGrow: "1" });
    expect(m.naturalFixedWidth).toBe(212);
    expect(resolveRestingPromptControlsLayout({ ...m, hostWidth: 200 })).toEqual({
      visible: true,
      hiddenCount: 1,
    });
  });

  test("a flexible label that is merely truncated is recovered too", () => {
    const m = measure({ clientWidth: 20, flexGrow: "1" });
    expect(m.naturalFixedWidth).toBe(192);
    expect(resolveRestingPromptControlsLayout({ ...m, hostWidth: 200 })).toEqual({
      visible: true,
      hiddenCount: 1,
    });
  });

  test("recovered text never exceeds the picker's own max-width", () => {
    expect(measure({ clientWidth: 0, flexGrow: "1" }, "180px").naturalFixedWidth).toBe(180);
  });
});
