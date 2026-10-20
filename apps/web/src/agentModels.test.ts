import { AgentId, type AgentModel, type ModelCapabilities } from "@kora/contracts";
import { describe, expect, test } from "vite-plus/test";

import { getAgentModelCapabilities } from "./agentModels";

const CLAUDE = AgentId.make("claude");

const caps = (optionId: string): ModelCapabilities => ({
  optionDescriptors: [{ id: optionId, label: optionId, type: "boolean" }],
});
const model = (
  slug: string,
  capabilities: ModelCapabilities,
  extra: Partial<AgentModel> = {},
): AgentModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities,
  ...extra,
});

describe("getAgentModelCapabilities", () => {
  test("an unknown slug has no option descriptors", () => {
    expect(getAgentModelCapabilities([model("known", caps("x"))], "nope", CLAUDE)).toEqual({
      optionDescriptors: [],
    });
  });

  test("a model is found through its declared aliases, case-insensitively", () => {
    const aliased = caps("aliased");
    const models = [model("real-slug", aliased, { aliases: ["Old-Name"] })];
    expect(getAgentModelCapabilities(models, "old-name", CLAUDE)).toEqual(aliased);
  });

  test("an exact custom slug (whitespace trimmed) beats a built-in model's alias for it", () => {
    const custom = caps("custom");
    const models = [
      model("built-in", caps("built-in"), { aliases: ["mine"] }),
      model("mine", custom, { isCustom: true }),
    ];
    expect(getAgentModelCapabilities(models, "  mine  ", CLAUDE)).toEqual(custom);
  });
});
