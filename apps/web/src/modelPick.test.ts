import {
  AgentId,
  AgentProfileId,
  ANTIGRAVITY_DEFAULT_MODEL,
  type AgentStatus,
} from "@kora/contracts";
import { DEFAULT_UNIFIED_PREFS, type UnifiedPrefs } from "@kora/contracts/clientPrefs";
import { createModelPick } from "@kora/shared/modelOptions";
import { describe, expect, test } from "vite-plus/test";

import { deriveAgentProfileEntries } from "./agentProfiles";
import { getPromptAgentState } from "./components/thread/promptAgentState";
import {
  getAppModelOptionsForInstance,
  getCustomModelOptionsByInstance,
  resolveAppModelPickForInstance,
  resolvePlanAgentHealPatch,
  withoutPlanAgentSelection,
} from "./modelPick";
import { deriveEffectivePromptModelState } from "./stores/promptDraftStore";

// ---------- fixtures ----------

const id = (name: string) => AgentProfileId.make(name);
const driverOf = (name: string) => AgentId.make(name);

/** A ready, signed-in agent whose driver is guessed from the instance id unless given. */
function agent(instance: string, models: string[] = [], driver?: string): AgentStatus {
  return {
    instanceId: id(instance),
    driver: driverOf(driver ?? (instance.startsWith("claude") ? "claude" : "codex")),
    checkedAt: "2026-01-01T00:00:00.000Z",
    auth: { status: "authenticated" },
    status: "ready",
    version: null,
    installed: true,
    enabled: true,
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: {} })),
    slashCommands: [],
    skills: [],
  };
}

function prefs(extra: Partial<UnifiedPrefs> = {}): UnifiedPrefs {
  return {
    ...DEFAULT_UNIFIED_PREFS,
    providerInstances: {
      [id("claude_openrouter")]: {
        driver: driverOf("claude"),
        config: { customModels: ["openai/gpt-5.5"] },
      },
      [id("claude")]: { driver: driverOf("claude"), config: { customModels: [] } },
    },
    ...extra,
  };
}

const withModelPrefs = (
  base: UnifiedPrefs,
  instance: string,
  value: { modelOrder: string[]; hiddenModels: string[] },
): UnifiedPrefs => ({ ...base, providerModelPreferences: { [id(instance)]: value } });

const entryOf = (agents: AgentStatus[], instance = agents[0]!.instanceId) =>
  deriveAgentProfileEntries(agents).find((e) => e.instanceId === instance)!;
const optionSlugs = (
  settings: UnifiedPrefs,
  agents: AgentStatus[],
  selected?: string,
  instance?: string,
) =>
  getAppModelOptionsForInstance(
    settings,
    entryOf(agents, instance ? id(instance) : undefined),
    selected,
  ).map((o) => o.slug);
const resolve = (
  instance: string,
  settings: UnifiedPrefs,
  agents: AgentStatus[],
  model: string,
  preserveUnavailableSelection = false,
) =>
  resolveAppModelPickForInstance(
    id(instance),
    settings,
    agents,
    model,
    preserveUnavailableSelection ? { preserveUnavailableSelection: true } : undefined,
  );

type Draft = Parameters<typeof deriveEffectivePromptModelState>[0]["draft"];
function effective(opts: {
  instance: string;
  driver: string;
  agents: AgentStatus[];
  thread?: ReturnType<typeof createModelPick> | null;
  project?: ReturnType<typeof createModelPick> | null;
  draft?: Draft;
}) {
  return deriveEffectivePromptModelState({
    settings: prefs(),
    projectModelSelection: opts.project ?? null,
    threadModelSelection: opts.thread ?? null,
    selectedInstanceId: id(opts.instance),
    selectedProvider: driverOf(opts.driver),
    providers: opts.agents,
    draft: opts.draft ?? null,
  });
}
const draftWith = (instance: string, pick: ReturnType<typeof createModelPick>): Draft => ({
  activeProvider: id(instance),
  modelSelectionByProvider: { [id(instance)]: pick },
});
/** What would really be sent for the state's model, after the prompt layer filters options. */
function dispatchedPick(
  state: ReturnType<typeof effective>,
  instance: string,
  driver: string,
  agent: AgentStatus,
) {
  const dispatch = getPromptAgentState({
    planModeEnabled: false,
    modelOptions: state.modelOptions?.[id(instance)],
    models: agent.models,
    model: state.selectedModel,
    provider: driverOf(driver),
  });
  return {
    dispatch,
    pick: createModelPick(id(instance), state.selectedModel, dispatch.modelOptionsForDispatch),
  };
}

// ---------- plan agent ----------

describe("plan-agent options", () => {
  const model = "opencode/gpt-5.4";
  const inst = id("opencode");
  const plan = { id: "agent", value: "plan" };
  const effort = { id: "variant", value: "low" };

  describe("withoutPlanAgentSelection", () => {
    test("null and undefined pass through", () => {
      expect(withoutPlanAgentSelection(null)).toBeNull();
      expect(withoutPlanAgentSelection(undefined)).toBeUndefined();
    });

    test("when plan was the only option the options key disappears", () => {
      expect(withoutPlanAgentSelection(createModelPick(inst, model, [plan]))).toEqual({
        instanceId: inst,
        model,
      });
    });

    test("only the plan option is removed", () => {
      expect(withoutPlanAgentSelection(createModelPick(inst, model, [effort, plan]))).toEqual(
        createModelPick(inst, model, [effort]),
      );
    });

    test("another agent option is returned as the very same object", () => {
      const coder = createModelPick(inst, model, [{ id: "agent", value: "coder" }]);
      expect(withoutPlanAgentSelection(coder)).toBe(coder);
    });
  });

  describe("resolvePlanAgentHealPatch", () => {
    const healed = createModelPick(inst, model, [effort]);
    const stored = createModelPick(inst, model, [effort, plan]);

    test("a stored plan agent in the source-control writer is healed", () => {
      expect(
        resolvePlanAgentHealPatch({
          sourceControlWriterModelSelection: stored,
          textGenerationModelSelection: healed,
          planModeEnabled: false,
        }),
      ).toEqual({ sourceControlWriterModelSelection: healed });
    });

    test("a stored plan agent in text generation is healed", () => {
      expect(
        resolvePlanAgentHealPatch({
          sourceControlWriterModelSelection: null,
          textGenerationModelSelection: stored,
          planModeEnabled: false,
        }),
      ).toEqual({ textGenerationModelSelection: healed });
    });

    test.each([
      [
        "nothing needs healing",
        {
          sourceControlWriterModelSelection: null,
          textGenerationModelSelection: healed,
          planModeEnabled: false,
        },
      ],
      [
        "plan mode is on",
        {
          sourceControlWriterModelSelection: null,
          textGenerationModelSelection: stored,
          planModeEnabled: true,
        },
      ],
    ])("no patch when %s", (_label, input) => {
      expect(resolvePlanAgentHealPatch(input)).toBeNull();
    });
  });
});

// ---------- prompt model state ----------

describe("effective prompt model state", () => {
  test("a custom instance keeps its draft model but loses options the dispatch layer rejects", () => {
    const agents = [
      agent("claude", ["claude-opus-5"]),
      agent("claude_openrouter", ["claude-opus-5"]),
    ];
    const state = effective({
      instance: "claude_openrouter",
      driver: "claude",
      agents,
      thread: createModelPick(id("claude_openrouter"), "claude-opus-5", [
        { id: "effort", value: "high" },
      ]),
      draft: draftWith(
        "claude_openrouter",
        createModelPick(id("claude_openrouter"), "openai/gpt-5.5", [
          { id: "effort", value: "max" },
        ]),
      ),
    });
    const { pick } = dispatchedPick(state, "claude_openrouter", "claude", agents[1]!);
    expect(pick).toEqual(createModelPick(id("claude_openrouter"), "openai/gpt-5.5"));
  });

  test("saved options survive dispatch when the model is missing from the catalog", () => {
    const agents = [agent("opencode", ["opencode/big-pickle"], "opencode")];
    const saved = createModelPick(id("opencode"), "opencode/kimi-k3", [
      { id: "variant", value: "xhigh" },
      { id: "agent", value: "coder" },
    ]);
    const state = effective({ instance: "opencode", driver: "opencode", agents, thread: saved });
    expect(dispatchedPick(state, "opencode", "opencode", agents[0]!).pick).toEqual(saved);
  });

  test("an explicit OpenCode draft is kept while the catalog is still empty", () => {
    const agents = [agent("opencode_work", [], "opencode")];
    const pick = createModelPick(id("opencode_work"), "openrouter/kimi-k3", [
      { id: "variant", value: "xhigh" },
      { id: "agent", value: "coder" },
    ]);
    const state = effective({
      instance: "opencode_work",
      driver: "opencode",
      agents,
      draft: draftWith("opencode_work", pick),
    });
    expect(state.selectedModel).toBe("openrouter/kimi-k3");
    expect(state.modelOptions?.[id("opencode_work")]).toEqual(pick.options);
  });

  test("an explicit draft model that is missing falls back, for non-OpenCode drivers, without options", () => {
    const agents = [agent("codex", ["gpt-6.1-nova"], "codex")];
    const state = effective({
      instance: "codex",
      driver: "codex",
      agents,
      draft: draftWith(
        "codex",
        createModelPick(id("codex"), "gpt-absent", [{ id: "effort", value: "max" }]),
      ),
    });
    expect(state.selectedModel).toBe("gpt-6.1-nova");
    expect(
      dispatchedPick(state, "codex", "codex", agents[0]!).dispatch.modelOptionsForDispatch,
    ).toBeUndefined();
  });

  describe("Antigravity", () => {
    const driver = "antigravity";
    const work = "antigravity_work";

    test("a new account without a catalog does not borrow another account's or driver's model", () => {
      const agents = [
        agent("codex", ["gpt-6.1-nova"], "codex"),
        agent("antigravity", ["gemini-alt-acct"], driver),
        agent(work, [], driver),
      ];
      const borrowed = draftWith(
        "antigravity",
        createModelPick(id("antigravity"), "gemini-alt-acct"),
      );
      for (const draft of [null, { ...borrowed, activeProvider: id(work) }] as Draft[]) {
        const state = effective({
          instance: work,
          driver,
          agents,
          project: createModelPick(id("codex"), "gpt-6.1-nova"),
          draft,
        });
        expect(state.selectedModel).toBe("");
      }
    });

    test("after sign-out the saved model is still shown for drafts and for the thread", () => {
      const saved = createModelPick(id(work), "gemini-3.1-pro-high");
      const signedOut = {
        ...agent(work, [], driver),
        status: "error" as const,
        auth: { status: "unauthenticated" as const },
      };
      for (const draft of [null, draftWith(work, saved)] as Draft[]) {
        const state = effective({
          instance: work,
          driver,
          agents: [signedOut],
          thread: saved,
          draft,
        });
        expect(state.selectedModel).toBe(saved.model);
      }
    });
  });
});

// ---------- option lists and resolution ----------

describe("Antigravity option lists", () => {
  const native = "gemini-3.1-pro";
  const work = "antigravity_work";

  test("the default marker resolves to the account's default model without inventing an unavailable one", () => {
    const base = agent(work, [native], "antigravity");
    const live = {
      ...base,
      models: base.models.map((m) => ({
        ...m,
        isDefault: true,
        aliases: [ANTIGRAVITY_DEFAULT_MODEL],
      })),
    };
    const settings = prefs();

    expect(optionSlugs(settings, [live], ANTIGRAVITY_DEFAULT_MODEL)).toEqual([native]);
    expect(resolve(work, settings, [live], ANTIGRAVITY_DEFAULT_MODEL, true)).toBe(native);
    expect(optionSlugs(settings, [{ ...base, models: [] }], ANTIGRAVITY_DEFAULT_MODEL)).toEqual([]);

    const hidden = withModelPrefs(settings, work, { modelOrder: [], hiddenModels: [native] });
    expect(resolve(work, hidden, [live], ANTIGRAVITY_DEFAULT_MODEL, true)).toBeNull();
  });

  test("only the account's catalog is offered, whatever custom models are configured", () => {
    const custom = id(work);
    const settings = prefs({
      providers: {
        ...DEFAULT_UNIFIED_PREFS.providers,
        antigravity: {
          ...DEFAULT_UNIFIED_PREFS.providers.antigravity,
          customModels: ["api-only-x"],
        },
      },
      providerInstances: {
        [custom]: { driver: driverOf("antigravity"), config: { customModels: ["mystery-model"] } },
      },
    });
    const agents = [
      agent("antigravity", [native], "antigravity"),
      agent(work, [native], "antigravity"),
    ];
    for (const e of deriveAgentProfileEntries(agents)) {
      expect(getAppModelOptionsForInstance(settings, e).map((o) => o.slug)).toEqual([native]);
    }
  });
});

const GAP_CASES = [
  {
    driverName: "opencode",
    missingModel: "opencode/kimi-k3",
    availableModel: "opencode/big-pickle",
  },
  {
    driverName: "antigravity",
    missingModel: "gemini-3.1-pro-high",
    availableModel: "gemini-3.1-pro",
  },
];
describe.each(GAP_CASES)(
  "$driverName catalog gaps",
  ({ driverName, availableModel, missingModel }) => {
    const asDriver = (instance: string, models: string[]) => agent(instance, models, driverName);

    test("a selected model missing from the catalog is offered as a single unavailable extra", () => {
      const agents = [asDriver(driverName, [availableModel])];
      expect(getAppModelOptionsForInstance(prefs(), entryOf(agents), missingModel)).toEqual([
        expect.objectContaining({ slug: availableModel }),
        expect.objectContaining({ slug: missingModel, name: missingModel, isUnavailable: true }),
      ]);
    });

    test("it is kept when preserving is requested and replaced by the first model otherwise", () => {
      const agents = [asDriver(driverName, [availableModel])];
      expect(resolve(driverName, prefs(), agents, missingModel, true)).toBe(missingModel);
      expect(resolve(driverName, prefs(), agents, missingModel)).toBe(availableModel);
    });

    test("the unavailable marker turns into real catalog metadata once the catalog recovers", () => {
      const pending = [asDriver(driverName, [availableModel])];
      const recovered = [asDriver(driverName, [availableModel, missingModel])];
      const flag = (agents: AgentStatus[]) =>
        getAppModelOptionsForInstance(prefs(), entryOf(agents), missingModel).find(
          (o) => o.slug === missingModel,
        )?.isUnavailable;

      expect(flag(pending)).toBe(true);
      expect(flag(recovered)).toBeUndefined();
      expect(resolve(driverName, prefs(), recovered, missingModel, true)).toBe(missingModel);
    });

    test("a hidden model is not resurrected just because the raw catalog omits it", () => {
      const agents = [asDriver(driverName, [])];
      const settings = withModelPrefs(prefs(), driverName, {
        modelOrder: [],
        hiddenModels: [missingModel],
      });
      expect(getAppModelOptionsForInstance(settings, entryOf(agents), missingModel)).toEqual([]);
      expect(resolve(driverName, settings, agents, missingModel, true)).toBeNull();
    });

    test("the missing option appears only on the selected instance", () => {
      const [work, personal] = [`${driverName}_work`, `${driverName}_personal`].map(id);
      const options = getCustomModelOptionsByInstance(
        prefs(),
        [asDriver(`${driverName}_work`, []), asDriver(`${driverName}_personal`, [])],
        work!,
        missingModel,
      );
      expect(options.get(work!)).toEqual([
        expect.objectContaining({ slug: missingModel, isUnavailable: true }),
      ]);
      expect(options.get(personal!)).toEqual([]);
    });
  },
);

describe("instance option lists", () => {
  const SONNET = "claude-sonnet-4-6";

  test("no unavailable option is added for providers that do not support it", () => {
    const agents = [agent("codex", ["gpt-6.1-nova"], "codex")];
    expect(optionSlugs(prefs(), agents, "gpt-absent")).toEqual(["gpt-6.1-nova"]);
    expect(resolve("codex", prefs(), agents, "gpt-absent", true)).toBe("gpt-6.1-nova");
  });

  test("a custom slug is not resolved against an instance that did not declare it", () => {
    const agents = [agent("claude", [SONNET]), agent("claude_openrouter", [SONNET])];
    expect(resolve("claude", prefs(), agents, "openai/gpt-5.5")).toBe(SONNET);
  });

  test("a custom slug resolves on the instance that did declare it", () => {
    const agents = [agent("claude"), agent("claude_openrouter")];
    expect(resolve("claude_openrouter", prefs(), agents, "openai/gpt-5.5")).toBe("openai/gpt-5.5");
  });

  test("custom models live only on their own instance's list", () => {
    const agents = [agent("claude", [SONNET]), agent("claude_openrouter", [SONNET])];
    expect(optionSlugs(prefs(), agents, undefined, "claude")).not.toContain("openai/gpt-5.5");
    expect(optionSlugs(prefs(), agents, undefined, "claude_openrouter")).toContain(
      "openai/gpt-5.5",
    );
    expect(optionSlugs(prefs(), agents, "openai/gpt-5.5", "claude")).not.toContain(
      "openai/gpt-5.5",
    );
  });

  test("hidden models leave the list and cannot be selected by fallback", () => {
    const agents = [agent("claude", ["claude-opus-4-6", SONNET])];
    const settings = withModelPrefs(prefs(), "claude", {
      modelOrder: [],
      hiddenModels: ["claude-opus-4-6"],
    });
    expect(optionSlugs(settings, agents)).toEqual([SONNET]);
    expect(resolve("claude", settings, agents, "claude-opus-4-6")).toBe(SONNET);
    expect(resolve("claude", settings, agents, "claude-opus-4-6", true)).toBe(SONNET);
  });

  test("the saved per-instance order is applied, with unlisted models after", () => {
    const agents = [agent("claude", ["claude-opus-4-6", SONNET, "claude-haiku-4-5"])];
    const settings = withModelPrefs(prefs(), "claude", {
      modelOrder: ["claude-haiku-4-5", "claude-opus-4-6"],
      hiddenModels: [],
    });
    expect(optionSlugs(settings, agents)).toEqual(["claude-haiku-4-5", "claude-opus-4-6", SONNET]);
  });

  test("custom rows the server still reports but settings dropped are removed", () => {
    const base = agent("claude_openrouter", [SONNET]);
    const stale = {
      ...base,
      models: [
        ...base.models,
        { slug: "removed/custom", name: "removed/custom", isCustom: true, capabilities: {} },
      ],
    };
    expect(optionSlugs(prefs(), [stale])).toEqual([SONNET, "openai/gpt-5.5"]);
  });

  test("Grok custom models come from the selected provider instance", () => {
    const settings = prefs({
      providerInstances: {
        ...prefs().providerInstances,
        [id("grok")]: {
          driver: driverOf("grok"),
          config: { customModels: ["grok-test-custom-model"] },
        },
      },
    });
    expect(optionSlugs(settings, [agent("grok", [], "grok")])).toContain("grok-test-custom-model");
  });

  test("a custom slug that collides with a provider alias is kept as its own entry", () => {
    const settings = prefs({
      providerInstances: {
        ...prefs().providerInstances,
        [id("claude_openrouter")]: {
          driver: driverOf("claude"),
          config: { customModels: ["opus"] },
        },
      },
    });
    const agents = [agent("claude_openrouter", ["claude-opus-4-8"], "claude")];
    expect(optionSlugs(settings, agents)).toEqual(["claude-opus-4-8", "opus"]);
    expect(resolve("claude_openrouter", settings, agents, "opus")).toBe("opus");
  });

  test("a full Claude model id maps onto its family row, not the default row", () => {
    const agents = [agent("claude", ["default", "opus", "sonnet"], "claude")];
    expect(resolve("claude", prefs(), agents, "claude-sonnet-5")).toBe("sonnet");
  });

  test("server-provided legacy metadata is preserved", () => {
    const base = agent("claude", ["claude-opus-4-8"]);
    const legacy = { ...base, models: [{ ...base.models[0]!, isLegacy: true }] };
    expect(getAppModelOptionsForInstance(prefs(), entryOf([legacy]))[0]?.isLegacy).toBe(true);
  });
});
