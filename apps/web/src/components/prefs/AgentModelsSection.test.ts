import type { AgentModel } from "@kora/contracts";
import { describe, expect, test } from "vite-plus/test";

import { groupModelsForDisplay, nextHiddenModelsForBulkToggle } from "./AgentModelsSection";

const builtIn = (slug: string): AgentModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: null,
});
const custom = (slug: string): AgentModel => ({
  slug,
  name: slug,
  isCustom: true,
  capabilities: null,
});

describe("nextHiddenModelsForBulkToggle", () => {
  const catalog = [builtIn("x"), builtIn("y"), custom("mine")];

  test("when everything built-in is hidden, the toggle shows it all and keeps unrelated hidden slugs", () => {
    expect(nextHiddenModelsForBulkToggle(catalog, ["x", "y", "old", "mine"])).toEqual([
      "old",
      "mine",
    ]);
  });

  test("otherwise it hides every built-in model but never a custom one", () => {
    expect(nextHiddenModelsForBulkToggle(catalog, ["x"])).toEqual(["x", "y"]);
    expect(nextHiddenModelsForBulkToggle(catalog, [])).toEqual(["x", "y"]);
  });
});

describe("groupModelsForDisplay", () => {
  test("favourites first, then visible in the user's order, then hidden; a custom model is never hidden", () => {
    const catalog = [builtIn("a"), builtIn("b"), builtIn("c"), builtIn("d"), custom("mine")];

    const shown = groupModelsForDisplay(catalog, {
      favoriteModels: new Set(["c"]),
      modelOrder: ["d", "b"],
      hiddenModels: new Set(["a", "mine"]),
    });

    expect(shown.map((m) => m.slug)).toEqual(["c", "d", "b", "mine", "a"]);
  });
});
