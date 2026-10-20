import { describe, expect, it, vi } from "vite-plus/test";

import { enforceAppleSiliconGuard, isIntelWithoutRosetta } from "./IntelGuard.ts";

describe("IntelGuard", () => {
  it("allows native Apple Silicon (arm64)", () => {
    expect(isIntelWithoutRosetta("arm64", false)).toBe(false);

    const dialog = { showErrorBox: vi.fn() };
    const app = { quit: vi.fn() };
    const allowed = enforceAppleSiliconGuard(dialog, app, "arm64", false);

    expect(allowed).toBe(true);
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("allows running under Rosetta on Apple Silicon (x64 with isRosetta: true)", () => {
    expect(isIntelWithoutRosetta("x64", true)).toBe(false);

    const dialog = { showErrorBox: vi.fn() };
    const app = { quit: vi.fn() };
    const allowed = enforceAppleSiliconGuard(dialog, app, "x64", true);

    expect(allowed).toBe(true);
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("blocks Intel Mac without Rosetta (x64 with isRosetta: false)", () => {
    expect(isIntelWithoutRosetta("x64", false)).toBe(true);

    const dialog = { showErrorBox: vi.fn() };
    const app = { quit: vi.fn() };
    const allowed = enforceAppleSiliconGuard(dialog, app, "x64", false);

    expect(allowed).toBe(false);
    expect(dialog.showErrorBox).toHaveBeenCalledWith("Kora", "Kora requires an Apple Silicon Mac");
    expect(app.quit).toHaveBeenCalled();
  });
});
