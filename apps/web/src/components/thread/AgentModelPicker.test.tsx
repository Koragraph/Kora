import { ANTIGRAVITY_DEFAULT_MODEL, AgentId, AgentProfileId } from "@kora/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { deriveAgentProfileEntries } from "../../agentProfiles";
import { AgentModelPicker } from "./AgentModelPicker";
import type { ModelEsque } from "./agentIconUtils";

/** A ready, signed-in profile entry for the picker. */
const profile = (instance: string, driver: string) =>
  deriveAgentProfileEntries([
    {
      instanceId: AgentProfileId.make(instance),
      driver: AgentId.make(driver),
      checkedAt: "2026-07-01T00:00:00.000Z",
      status: "ready",
      auth: { status: "authenticated" },
      ...{ enabled: true, installed: true, version: null },
      ...{ models: [], skills: [], slashCommands: [] },
    },
  ])[0]!;

/** The resting trigger for `model` on one instance offering `catalog`. */
function trigger(
  driver: string,
  model: string,
  catalog: ModelEsque[],
  options: { instance?: string; withEntry?: boolean; label?: string } = {},
) {
  const instance = options.instance ?? `${driver}_main`;
  const id = AgentProfileId.make(instance);
  return renderToStaticMarkup(
    <AgentModelPicker
      onInstanceModelChange={() => {}}
      lockedProvider={null}
      activeInstanceId={id}
      model={model}
      instanceEntries={options.withEntry === false ? [] : [profile(instance, driver)]}
      modelOptionsByInstance={new Map([[id, catalog]])}
      {...(options.label === undefined ? {} : { triggerLabel: options.label })}
    />,
  );
}

const twoModels: ModelEsque[] = [
  { slug: "first-model", name: "First Model" },
  { slug: "second-model", name: "Second Model" },
];

describe("AgentModelPicker trigger", () => {
  it("shows a second instance's initials in a compact badge", () => {
    const work = profile("codex_work", "codex");
    const markup = renderToStaticMarkup(
      <AgentModelPicker
        size="xs"
        onInstanceModelChange={() => {}}
        lockedProvider={null}
        activeInstanceId={work.instanceId}
        model="gpt-5"
        instanceEntries={[profile("codex", "codex"), work]}
        modelOptionsByInstance={new Map()}
      />,
    );
    expect(markup).toContain(">CW</span>");
    for (const sizing of ["size-4", "h-3", "text-[10px]"]) expect(markup).toContain(sizing);
  });

  it("names the selected model when the catalog has it", () => {
    const markup = trigger("opencode", "second-model", twoModels);
    expect(markup).toContain("Second Model");
    expect(markup).not.toContain("First Model");
  });

  it.each(["codex", "claude", "cursor", "grok"])(
    "falls back to the first model when %s lacks the selection",
    (driver) => {
      const markup = trigger(driver, "retired-model", twoModels);
      expect(markup).toContain("First Model");
      expect(markup).not.toContain(">retired-model<");
    },
  );

  it("falls back to the first model when the instance itself is gone", () => {
    const markup = trigger("opencode", "retired-model", twoModels, { withEntry: false });
    expect(markup).toContain("First Model");
    expect(markup).not.toContain(">retired-model<");
  });

  it.each(["opencode", "antigravity"])(
    "keeps the saved slug for %s, whose catalogs are per account",
    (driver) => {
      const markup = trigger(driver, "account-only-model", twoModels);
      expect(markup).toContain("account-only-model");
      expect(markup).not.toContain("First Model");
    },
  );

  describe("Antigravity default marker", () => {
    it.each([{ isDefault: true }, { aliases: [ANTIGRAVITY_DEFAULT_MODEL] }])(
      "shows the real default model flagged by %j",
      (flag) => {
        const catalog = [twoModels[0]!, { ...twoModels[1]!, ...flag }];
        const markup = trigger("antigravity", ANTIGRAVITY_DEFAULT_MODEL, catalog);
        expect(markup).toContain("Second Model");
        expect(markup).not.toContain("First Model");
        expect(markup).not.toContain(ANTIGRAVITY_DEFAULT_MODEL);
      },
    );

    it.each([ANTIGRAVITY_DEFAULT_MODEL, ""])(
      "asks for a choice before the catalog loads (model %j)",
      (model) => {
        const markup = trigger("antigravity", model, [], { instance: "antigravity" });
        expect(markup).toContain("Choose model");
        expect(markup).not.toContain(ANTIGRAVITY_DEFAULT_MODEL);
      },
    );
  });

  it("shows an aggregate label as is, without a model name or availability badge", () => {
    const markup = trigger("codex", "first-model", [{ ...twoModels[0]!, isUnavailable: true }], {
      label: "Several models",
    });
    expect(markup).toContain("Several models");
    expect(markup).not.toContain("First Model");
    expect(markup).not.toContain("Unavailable");
  });
});
