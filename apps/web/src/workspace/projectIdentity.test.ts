import { describe, expect, test } from "vite-plus/test";

import { PROJECT_ICON_COLORS } from "../appearance/projectIconColors";
import { deriveProjectIdentity } from "./projectIdentity";

const color = (name: string) => deriveProjectIdentity(name).color;

describe("deriveProjectIdentity", () => {
  test("different names do not all share one colour", () => {
    const names = [
      "Nebula",
      "M7 Forge",
      "Silver Orchard",
      "Blue Harbor",
      "Copper Finch",
      "Juniper Vale",
    ];
    expect(new Set(names.map(color)).size).toBeGreaterThan(1);
  });

  test.each(["Jobs", "Scripts and Extractors", "Kora", "文書", "", "---"])(
    "%j gets a colour the icon picker offers",
    (name) => {
      expect(PROJECT_ICON_COLORS.map((c) => c.value)).toContain(color(name));
    },
  );

  test("case and surrounding whitespace do not change the colour", () => {
    expect(color("  NEBULA  ")).toBe(color("Nebula"));
  });

  test.each([
    ["Silver Orchard", "SO"],
    ["Quiet Lantern Workshop", "QW"],
    ["M7 Forge", "M7"],
    ["m7forge", "M7"],
    ["Nebula", "NA"],
    ["X", "XX"],
    ["---", "PR"],
  ])("the monogram of %j is %s", (name, monogram) => {
    expect(deriveProjectIdentity(name).monogram).toBe(monogram);
  });
});
