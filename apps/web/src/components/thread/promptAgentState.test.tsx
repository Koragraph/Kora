import { getAgentOptionDescriptors } from "@kora/shared/modelOptions";
import {
  AgentId,
  type AgentModel,
  type AgentOptionDescriptor,
  type AgentOptionSelection,
} from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getAgentModelCapabilities } from "../../agentModels";
import {
  getPromptAgentState,
  getPromptInjectionState,
  withImplicitFastModeDefault,
} from "./promptAgentState";

// The composer state is driven entirely by the model's option descriptors, so one made-up model is
// enough: each test gives it the descriptors it needs.
const SLUG = "fixture-model";
const CODEX = AgentId.make("codex");
const OPENCODE = AgentId.make("opencode");

type Choice = { id: string; label?: string; isDefault?: boolean };

/** A select option; the choice marked default becomes its current value. */
const pickOne = (id: string, choices: Choice[], injected: string[] = []): AgentOptionDescriptor => {
  const fallback = choices.find((choice) => choice.isDefault);
  return {
    type: "select",
    id,
    label: id,
    options: choices.map((choice) => ({ label: choice.label ?? choice.id, ...choice })),
    ...(fallback ? { currentValue: fallback.id } : {}),
    ...(injected.length > 0 ? { promptInjectedValues: injected } : {}),
  } as AgentOptionDescriptor;
};

const toggle = (id: string, currentValue?: boolean): AgentOptionDescriptor =>
  ({
    type: "boolean",
    id,
    label: id,
    ...(currentValue === undefined ? {} : { currentValue }),
  }) as AgentOptionDescriptor;

const catalogWith = (...descriptors: AgentOptionDescriptor[]): AgentModel[] => [
  {
    slug: SLUG,
    name: "Fixture",
    isCustom: false,
    capabilities: { optionDescriptors: descriptors },
  },
];

const chosen = (values: Record<string, string | boolean>): AgentOptionSelection[] =>
  Object.entries(values).map(([id, value]) => ({ id, value }));

type StateInput = Parameters<typeof getPromptAgentState>[0];
const stateFor = (
  models: AgentModel[],
  modelOptions: StateInput["modelOptions"],
  extra: Partial<StateInput> = {},
) =>
  getPromptAgentState({
    provider: CODEX,
    model: SLUG,
    planModeEnabled: true,
    models,
    modelOptions,
    ...extra,
  });

describe("fast mode default", () => {
  it("adds fastMode=false only for a model that offers it and only when nothing was chosen", () => {
    expect(
      withImplicitFastModeDefault({ optionDescriptors: [toggle("thinking", true)] }, undefined),
    ).toBeUndefined();
    expect(
      withImplicitFastModeDefault({ optionDescriptors: [toggle("fastMode", true)] }, null),
    ).toEqual(chosen({ fastMode: false }));
    const mine = chosen({ fastMode: true });
    expect(withImplicitFastModeDefault({ optionDescriptors: [toggle("fastMode")] }, mine)).toBe(
      mine,
    );
    expect(
      withImplicitFastModeDefault(
        { optionDescriptors: [toggle("fastMode")] },
        chosen({ effort: "low" }),
      ),
    ).toEqual(chosen({ effort: "low", fastMode: false }));
  });

  it("shows Normal in the traits even when the provider says Fast is on", () => {
    const models = catalogWith(toggle("fastMode", true));
    const caps = getAgentModelCapabilities(models, SLUG, AgentId.make("cursor"));
    const descriptors = getAgentOptionDescriptors({
      caps,
      selections: withImplicitFastModeDefault(caps, undefined) ?? null,
    });
    const fast = descriptors.find((descriptor) => descriptor.id === "fastMode");
    expect(fast).toMatchObject({ type: "boolean", currentValue: false });
  });

  it.each([
    [undefined, false],
    [false, false],
    [true, true],
  ] as const)("dispatches fastMode=%s as %s", (picked, sent) => {
    const options = picked === undefined ? undefined : chosen({ fastMode: picked });
    const state = stateFor(catalogWith(toggle("fastMode", true)), options, {
      provider: AgentId.make("cursor"),
    });
    expect(state.modelOptionsForDispatch).toEqual(chosen({ fastMode: sent }));
  });
});

describe("getPromptAgentState", () => {
  const effortLevels = [{ id: "low" }, { id: "high", isDefault: true }];

  it("shows the default effort without sending it", () => {
    expect(stateFor(catalogWith(pickOne("effort", effortLevels)), undefined)).toEqual({
      provider: CODEX,
      promptEffort: "high",
      modelOptionsForDispatch: undefined,
    });
  });

  it("sends explicit choices, defaults included, so they overwrite earlier ones", () => {
    const models = catalogWith(pickOne("effort", effortLevels), toggle("fastMode"));
    expect(stateFor(models, chosen({ effort: "low", fastMode: true }))).toEqual({
      provider: CODEX,
      promptEffort: "low",
      modelOptionsForDispatch: chosen({ effort: "low", fastMode: true }),
    });
    expect(
      stateFor(models, chosen({ effort: "high", fastMode: false })).modelOptionsForDispatch,
    ).toEqual(chosen({ effort: "high", fastMode: false }));
  });

  it("takes the effort from the first select and still sends the others", () => {
    const models = catalogWith(
      pickOne("effort", [{ id: "medium", isDefault: true }]),
      pickOne("contextWindow", [{ id: "small", isDefault: true }, { id: "large" }]),
      pickOne("agent", [{ id: "build", isDefault: true }, { id: "plan" }]),
    );
    const state = stateFor(models, chosen({ agent: "plan" }));
    expect([state.promptEffort, state.modelOptionsForDispatch]).toEqual([
      "medium",
      chosen({ agent: "plan" }),
    ]);
  });

  it("drops choices for options the model does not have", () => {
    expect(
      stateFor(catalogWith(toggle("thinking")), chosen({ effort: "max", thinking: false })),
    ).toEqual({
      provider: CODEX,
      promptEffort: null,
      modelOptionsForDispatch: chosen({ thinking: false }),
    });
    expect(
      stateFor(catalogWith(), chosen({ anything: "x" })).modelOptionsForDispatch,
    ).toBeUndefined();
  });

  it.each(["codex", "claude", "cursor", "grok"])(
    "sends nothing unknown for a %s model missing from the catalog",
    (driver) => {
      const state = stateFor(catalogWith(), chosen({ mystery: "1" }), {
        provider: AgentId.make(driver),
        model: "gone",
      });
      expect(state.modelOptionsForDispatch).toBeUndefined();
    },
  );

  it("validates a model picked by an old alias against the real entry", () => {
    const models: AgentModel[] = [
      {
        slug: SLUG,
        name: "Fixture",
        isCustom: false,
        aliases: ["fixture-old-name"],
        capabilities: { optionDescriptors: [pickOne("effort", effortLevels)] },
      },
    ];
    const state = stateFor(models, chosen({ effort: "low", junk: "1" }), {
      provider: AgentId.make("claude"),
      model: "fixture-old-name",
      planModeEnabled: false,
    });
    expect(state.modelOptionsForDispatch).toEqual(chosen({ effort: "low" }));
  });

  describe("plan agent with plan mode off", () => {
    const off = { planModeEnabled: false };

    it("swaps a chosen plan agent for the default one", () => {
      const models = catalogWith(
        pickOne("agent", [{ id: "build", isDefault: true }, { id: "plan" }]),
      );
      expect(stateFor(models, chosen({ agent: "plan" }), off).modelOptionsForDispatch).toEqual(
        chosen({ agent: "build" }),
      );
    });

    it("sends no agent when plan was the default or the only choice", () => {
      const planFirst = catalogWith(
        pickOne("agent", [{ id: "plan", isDefault: true }, { id: "research" }]),
      );
      expect(stateFor(planFirst, undefined, off).modelOptionsForDispatch).toBeUndefined();
      const planOnly = catalogWith(pickOne("agent", [{ id: "plan", isDefault: true }]));
      expect(stateFor(planOnly, chosen({ agent: "plan" }), off)).toEqual({
        provider: CODEX,
        promptEffort: null,
        modelOptionsForDispatch: undefined,
      });
    });
  });

  describe("OpenCode models outside the catalog", () => {
    const saved = chosen({ variant: "max", agent: "build" });
    const opencode = { provider: OPENCODE, model: "opencode/next-model", planModeEnabled: false };

    it("passes saved options through untouched, catalog empty or not", () => {
      expect(stateFor([], saved, opencode).modelOptionsForDispatch).toEqual(saved);
      const other: AgentModel[] = [
        { slug: "opencode/other", name: "Other", isCustom: false, capabilities: {} },
      ];
      expect(stateFor(other, saved, opencode)).toEqual({
        provider: OPENCODE,
        promptEffort: null,
        modelOptionsForDispatch: saved,
      });
    });

    it("still removes a saved plan agent when plan mode is off", () => {
      expect(
        stateFor([], chosen({ variant: "max", agent: "plan" }), opencode).modelOptionsForDispatch,
      ).toEqual(chosen({ variant: "max" }));
      expect(
        stateFor([], chosen({ agent: "plan" }), opencode).modelOptionsForDispatch,
      ).toBeUndefined();
    });
  });

  describe("ultrathink styling", () => {
    const deepPrompt = getPromptInjectionState("Ultrathink:\nTrace the crash");

    it("dresses the composer when an injectable effort is in play", () => {
      const models = catalogWith(
        pickOne(
          "effort",
          [{ id: "ultrathink" }, { id: "high", isDefault: true }, { id: "medium" }],
          ["ultrathink"],
        ),
      );
      expect(
        stateFor(models, chosen({ effort: "medium" }), { promptInjectionState: deepPrompt }),
      ).toEqual({
        provider: CODEX,
        promptEffort: "medium",
        modelOptionsForDispatch: chosen({ effort: "medium" }),
        composerFrameClassName: "deep-think-frame",
        composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]",
        modelPickerIconClassName: "deep-think-chroma",
      });
    });

    it("leaves the composer plain without an injectable effort", () => {
      const state = stateFor(
        catalogWith(pickOne("effort", [{ id: "high", isDefault: true }])),
        undefined,
        {
          promptInjectionState: deepPrompt,
        },
      );
      for (const key of [
        "composerFrameClassName",
        "composerSurfaceClassName",
        "modelPickerIconClassName",
      ]) {
        expect(state).not.toHaveProperty(key);
      }
    });

    it("recognises the ultrathink keyword only", () => {
      expect(getPromptInjectionState("Trace the crash")).toBe("none");
      expect(deepPrompt).toBe("ultrathink");
    });
  });
});
