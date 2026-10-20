import { AgentProfileId } from "@kora/contracts";
import { describe, expect, test } from "vite-plus/test";

import { agentModelKey, sortAgentModelItems, sortModelsForAgentProfile } from "./modelSort";

const slugs = (rows: ReadonlyArray<{ slug: string }>) => rows.map((r) => r.slug);

describe("sortModelsForAgentProfile", () => {
  const catalog = ["m-c", "m-a", "m-d", "m-b"].map((slug) => ({ slug }));

  test("with favourites grouped, favourites come first and each group follows the saved order", () => {
    const out = sortModelsForAgentProfile(catalog, {
      groupFavorites: true,
      favoriteModels: ["m-d", "m-b"],
      modelOrder: ["m-a", "m-b", "m-c", "m-d"],
    });
    expect(slugs(out)).toEqual(["m-b", "m-d", "m-a", "m-c"]);
  });

  test("when every model is a favourite the grouping changes nothing", () => {
    const out = sortModelsForAgentProfile(catalog, {
      groupFavorites: true,
      favoriteModels: ["m-a", "m-b", "m-c", "m-d"],
      modelOrder: ["m-b", "m-a", "m-d", "m-c"],
    });
    expect(slugs(out)).toEqual(["m-b", "m-a", "m-d", "m-c"]);
  });

  test("without grouping, favourites get no special place", () => {
    const out = sortModelsForAgentProfile(catalog, {
      groupFavorites: false,
      favoriteModels: ["m-d"],
      modelOrder: ["m-a", "m-b", "m-c", "m-d"],
    });
    expect(slugs(out)).toEqual(["m-a", "m-b", "m-c", "m-d"]);
  });
});

describe("sortAgentModelItems (the favourites view)", () => {
  const work = AgentProfileId.make("codex_work");
  const claude = AgentProfileId.make("claude");

  test("rows are ordered by instance order first, then by the order the models arrived in", () => {
    const rows = [
      { instanceId: work, slug: "b" },
      { instanceId: work, slug: "a" },
      { instanceId: claude, slug: "opus" },
      { instanceId: work, slug: "c" },
    ];
    const out = sortAgentModelItems(rows, {
      instanceOrder: [work, claude],
      favoriteModelKeys: [
        agentModelKey(claude, "opus"),
        agentModelKey(work, "a"),
        agentModelKey(work, "b"),
        agentModelKey(work, "c"),
      ],
    });
    expect(slugs(out)).toEqual(["b", "a", "c", "opus"]);
  });

  test("the model key tells apart the same slug on two instances", () => {
    expect(agentModelKey(work, "x")).not.toBe(agentModelKey(claude, "x"));
  });
});
