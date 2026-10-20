import { describe, expect, it } from "vite-plus/test";

import { stagePillLabel } from "./stagePill";

describe("the sidebar's build pill", () => {
  it.each([
    ["Dev", "Dev"],
    [" dev ", "Dev"],
    ["Latest", null],
    ["Alpha", null],
    ["", null],
  ])("%j shows %j", (stage, pill) => {
    expect(stagePillLabel(stage)).toBe(pill);
  });
});
