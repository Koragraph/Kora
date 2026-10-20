import { AgentId, AgentProfileId, DEFAULT_MODEL_BY_AGENT, type AgentStatus } from "@kora/contracts";
import { describe, expect, test } from "vite-plus/test";

import {
  applyAgentProfilePrefs,
  deriveAgentProfileEntries,
  getDefaultAgentProfileModel,
  isAgentProfilePickerReady,
  isAgentProfilePickerVisible,
  resolveDefaultAgentModelPick,
  resolveSelectableAgentProfile,
} from "./agentProfiles";

const id = AgentProfileId.make;
const driver = AgentId.make;

interface Spec {
  enabled?: boolean;
  availability?: AgentStatus["availability"];
  status?: AgentStatus["status"];
  models?: AgentStatus["models"];
}
/** An agent status for instance `name` on `kind` (defaults: enabled, ready, no models). */
function agent(name: string, kind: string, spec: Spec = {}): AgentStatus {
  return {
    instanceId: id(name),
    driver: driver(kind),
    enabled: spec.enabled ?? true,
    installed: true,
    version: null,
    status: spec.status ?? "ready",
    ...(spec.availability ? { availability: spec.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: spec.models ?? [],
    slashCommands: [],
    skills: [],
  };
}
const m = (slug: string, flags: { custom?: boolean; main?: boolean } = {}) => ({
  slug,
  name: slug,
  isCustom: flags.custom ?? false,
  ...(flags.main ? { isDefault: true } : {}),
  capabilities: {},
});
const only = <T>(list: readonly T[]) => list[0]!;

describe("resolveDefaultAgentModelPick", () => {
  test.each([
    ["no agents", []],
    ["a disabled agent", [agent("codex", "codex", { enabled: false })]],
    ["an unavailable agent", [agent("codex", "codex", { availability: "unavailable" })]],
    ["an errored agent", [agent("codex", "codex", { status: "error" })]],
  ])("%s -> no pick", (_label, agents) => {
    expect(resolveDefaultAgentModelPick(agents, null)).toBeNull();
  });

  test("a valid stored pick is returned as the same object, options included", () => {
    const stored = {
      instanceId: id("claude"),
      model: "custom-model",
      options: [{ id: "effort", value: "high" }],
    };
    expect(
      resolveDefaultAgentModelPick(
        [agent("claude", "claude", { models: [m("claude-opus-4-8")] })],
        stored,
      ),
    ).toBe(stored);
  });

  test.each([{ enabled: false }, { availability: "unavailable" as const }])(
    "a stored pick on an unusable instance (%j) moves to the next usable agent",
    (spec) => {
      const agents = [
        agent("codex", "codex", { ...spec, models: [m("gpt-5.6")] }),
        agent("claude", "claude", { models: [m("claude-opus-4-8", { main: true })] }),
      ];
      expect(
        resolveDefaultAgentModelPick(agents, { instanceId: id("codex"), model: "gpt-5.6" }),
      ).toEqual({
        instanceId: "claude",
        model: "claude-opus-4-8",
      });
    },
  );

  test("a stored pick for an instance that no longer exists falls to the first ready instance", () => {
    const agents = [
      agent("codex", "codex", { status: "warning", models: [m("gpt-5.6")] }),
      agent("claude", "claude", { models: [m("claude-opus-4-8", { main: true })] }),
    ];
    expect(
      resolveDefaultAgentModelPick(agents, { instanceId: id("gone"), model: "stale" }),
    ).toEqual({
      instanceId: "claude",
      model: "claude-opus-4-8",
    });
  });

  test.each([
    ["cursor", "composer-2"],
    ["claude", "claude-fable-5"],
    ["codex", "gpt-5.6"],
  ])("with no stored pick, the only %s agent's default model is used", (kind, slug) => {
    const agents = [agent(kind, kind, { models: [m(slug, { main: true })] })];
    expect(resolveDefaultAgentModelPick(agents, null)).toEqual({ instanceId: kind, model: slug });
  });
});

describe("getDefaultAgentProfileModel", () => {
  const claude = id("claude");

  test("an unknown instance has no default", () => {
    expect(getDefaultAgentProfileModel([], id("removed_instance"))).toBeUndefined();
  });

  test("the instance's declared default beats list order", () => {
    const agents = [
      agent("codex", "codex", { models: [m("gpt-5.6"), m("gpt-6-luna", { main: true })] }),
    ];
    expect(getDefaultAgentProfileModel(agents, id("codex"))).toBe("gpt-6-luna");
  });

  test("a Claude catalog without Sonnet keeps its own default", () => {
    const agents = [
      agent("claude", "claude", {
        models: [m("claude-haiku-5-5"), m("claude-opus-4-8", { main: true })],
      }),
    ];
    expect(getDefaultAgentProfileModel(agents, claude)).toBe("claude-opus-4-8");
  });

  test("new Claude threads start on the newest Sonnet, not the account's Opus default", () => {
    const agents = [
      agent("claude", "claude", {
        models: [
          m("default", { main: true }),
          m("claude-opus-5-5"),
          m("claude-sonnet-5-5"),
          m("claude-sonnet-5"),
        ],
      }),
    ];
    expect(getDefaultAgentProfileModel(agents, claude)).toBe("claude-sonnet-5-5");
  });

  test("an instance reporting no models falls back to the driver's static default (Sonnet)", () => {
    const resolved = getDefaultAgentProfileModel([agent("claude", "claude")], claude);
    expect(resolved).toBe("claude-sonnet-5-5");
    expect(DEFAULT_MODEL_BY_AGENT[driver("claude")]).toMatch(/^claude-sonnet-[\d-]+$/);
  });

  test("a custom instance uses its own models, not those of the kind's stock instance", () => {
    const agents = [
      agent("claude_openrouter", "claude", {
        models: [m("openai/gpt-5.5", { custom: true }), m("claude-opus-4-8")],
      }),
      agent("claude", "claude", { models: [m("claude-sonnet-5")] }),
    ];
    expect(getDefaultAgentProfileModel(agents, id("claude_openrouter"))).toBe("claude-opus-4-8");
  });
});

describe("resolveSelectableAgentProfile", () => {
  const disabledCodex = agent("codex", "codex", { enabled: false });
  const unavailableClaude = agent("claude", "claude", { availability: "unavailable" });

  test("when nothing is sendable, a request for a disabled, unavailable or unknown instance gets nothing", () => {
    const pool = [disabledCodex, unavailableClaude];
    for (const wanted of ["codex", "claude", "removed_instance"]) {
      expect(resolveSelectableAgentProfile(pool, id(wanted))).toBeUndefined();
    }
  });

  test("an enabled, available request is honoured", () => {
    const pool = [agent("codex", "codex"), agent("claude_work", "claude")];
    expect(resolveSelectableAgentProfile(pool, id("claude_work"))).toBe("claude_work");
  });

  test("a requested instance whose probe errored is still honoured", () => {
    const pool = [agent("codex", "codex", { status: "error" }), agent("claude", "claude")];
    expect(resolveSelectableAgentProfile(pool, id("codex"))).toBe("codex");
  });

  test("an unusable request falls back to the first usable instance", () => {
    expect(
      resolveSelectableAgentProfile([disabledCodex, agent("claude", "claude")], id("codex")),
    ).toBe("claude");
  });

  test("with no request, ready beats errored", () => {
    expect(
      resolveSelectableAgentProfile(
        [agent("codex", "codex", { status: "error" }), agent("claude", "claude")],
        undefined,
      ),
    ).toBe("claude");
  });

  test("with no request, an unprobed (warning) instance beats an errored one", () => {
    const pool = [
      agent("codex", "codex", { status: "error" }),
      agent("claude", "claude", { status: "warning" }),
    ];
    expect(resolveSelectableAgentProfile(pool, undefined)).toBe("claude");
  });

  test("an errored instance is never invented as the default", () => {
    expect(
      resolveSelectableAgentProfile([agent("codex", "codex", { status: "error" })], undefined),
    ).toBeUndefined();
  });
});

describe("deriveAgentProfileEntries", () => {
  test("keeps the snapshot's instance id and driver, and marks non-default instances", () => {
    const entry = only(deriveAgentProfileEntries([agent("codex_personal", "codex")]));
    expect([entry.instanceId, entry.driverKind, entry.isDefault]).toEqual([
      "codex_personal",
      "codex",
      false,
    ]);
  });
});

describe("applyAgentProfilePrefs", () => {
  const apply = (
    snapshot: AgentStatus,
    prefs: { providers?: object; providerInstances?: object },
  ) =>
    only(
      applyAgentProfilePrefs(deriveAgentProfileEntries([snapshot]), {
        providers: (prefs.providers ?? {}) as never,
        providerInstances: (prefs.providerInstances ?? {}) as never,
      }),
    );

  test("a built-in default instance follows the legacy provider setting", () => {
    expect(
      apply(agent("codex", "codex"), { providers: { codex: { enabled: false } } }).enabled,
    ).toBe(false);
  });

  test("a configured instance entry beats a stale snapshot that still says enabled", () => {
    const entry = apply(agent("codex", "codex"), {
      providerInstances: { [id("codex")]: { enabled: false, driver: driver("codex") } },
    });
    expect(entry.enabled).toBe(false);
  });

  test("a custom instance that is no longer configured counts as disabled", () => {
    expect(apply(agent("claude_work", "claude"), {}).enabled).toBe(false);
  });

  test("a default instance of a driver with no settings counts as disabled", () => {
    const entry = apply(agent("constructor", "constructor"), {});
    expect([entry.isDefault, entry.enabled]).toEqual([true, false]);
  });

  test.each(["constructor", "toString"])(
    "object-prototype names (%s) are not mistaken for configured instances",
    (name) => {
      expect(apply(agent(name, "claude"), {}).enabled).toBe(false);
    },
  );

  test("but a really configured instance with such a name uses its settings", () => {
    const entry = apply(agent("constructor", "claude"), {
      providerInstances: { [id("constructor")]: { enabled: false, driver: driver("claude") } },
    });
    expect(entry.enabled).toBe(false);
  });
});

describe("picker predicates", () => {
  const entries = deriveAgentProfileEntries([
    agent("codex", "codex"),
    agent("claude", "claude", { enabled: false }),
  ]);
  const [on, off] = entries as [(typeof entries)[number], (typeof entries)[number]];

  test("an enabled instance is visible, a disabled one is not", () => {
    expect([isAgentProfilePickerVisible(on), isAgentProfilePickerVisible(off)]).toEqual([
      true,
      false,
    ]);
  });

  test("ready requires enabled, even while the disabled one's last probe said ready", () => {
    expect(off.status).toBe("ready");
    expect([isAgentProfilePickerReady(on), isAgentProfilePickerReady(off)]).toEqual([true, false]);
  });
});
