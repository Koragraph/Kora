import {
  parseModelPickerModelKey,
  parseModelPickerLegacySectionKey,
  modelPickerModelKey,
  modelPickerLegacySectionKey,
} from "./modelPickerKeys";
import { describe, expect, it } from "vite-plus/test";
import { AgentProfileId } from "@kora/contracts";

describe("model picker item keys", () => {
  it("round-trips arbitrary strings without throwing", () => {
    const slug = "model:\udfff";
    const instanceId = AgentProfileId.make("custom");

    const key = modelPickerModelKey(instanceId, slug);

    expect(parseModelPickerModelKey(key)).toEqual({ instanceId, slug });
  });
  it("keeps model and legacy section keys distinct for colliding instance names", () => {
    const modelKey = modelPickerModelKey(AgentProfileId.make("legacy-models"), "codex");
    const sectionKey = modelPickerLegacySectionKey(AgentProfileId.make("codex"));

    expect(modelKey).not.toBe(sectionKey);
    expect(parseModelPickerLegacySectionKey(modelKey)).toBeNull();
    expect(parseModelPickerModelKey(modelKey)).toEqual({
      slug: "codex",
      instanceId: "legacy-models",
    });
  });
});
