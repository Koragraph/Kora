import {
  AgentId,
  AgentProfileId,
  ANTIGRAVITY_DEFAULT_MODEL,
  type AgentStatus,
} from "@kora/contracts";
import { describe, expect, test } from "vite-plus/test";

import { deriveAgentProfileEntries } from "../../agentProfiles";
import {
  agentUnusableReason,
  resolveModelPickerSelectedModel,
  shouldIncludeModelPickerOption,
  shouldOfferModelPickerSetup,
} from "./ModelPickerContent";

/** One profile entry for `driver`, with any status field overridden. */
function profile(driver: string, over: Partial<AgentStatus> = {}) {
  return deriveAgentProfileEntries([
    {
      models: [],
      skills: [],
      slashCommands: [],
      checkedAt: "2026-08-28T00:00:00.000Z",
      version: null,
      installed: true,
      enabled: true,
      auth: { status: "authenticated" },
      status: "ready",
      driver: AgentId.make(driver),
      instanceId: AgentProfileId.make(`${driver}_work`),
      ...over,
    },
  ])[0]!;
}

const AG = AgentId.make("antigravity");
const gemini = { slug: "gemini-3.1-pro", name: "Gemini 3.1 Pro" };

describe("agentUnusableReason", () => {
  test("an agent that is not installed is blocked", () => {
    expect(agentUnusableReason(profile("codex", { installed: false }))).toMatch(/isn't installed/);
  });

  test.each([
    ["a ready agent", profile("codex")],
    ["Claude even when signed out", profile("claude", { auth: { status: "unauthenticated" } })],
    ["an unknown agent", undefined],
  ])("%s is never blocked", (_label, entry) => {
    expect(agentUnusableReason(entry)).toBeNull();
  });

  test("a signed-out Codex gets the single instruction that fixes it", () => {
    expect(agentUnusableReason(profile("codex", { auth: { status: "unauthenticated" } }))).toBe(
      "Codex isn't signed in. In Terminal, run `codex login`, then come back to Kora.",
    );
  });
});

describe("shouldOfferModelPickerSetup", () => {
  test("another driver follows its snapshot's setup capability", () => {
    const entry = profile("custom_driver", { status: "error" });
    const withSetup = {
      ...entry,
      snapshot: { ...entry.snapshot, setup: { canAuthenticate: true, canInstall: false } },
    };
    expect(shouldOfferModelPickerSetup(withSetup, [])).toBe(true);
  });

  test("a driver without integrated setup is left on its existing path", () => {
    expect(shouldOfferModelPickerSetup(profile("codex", { status: "error" }), [])).toBe(false);
  });

  test("a disabled provider is not resurrected by a stale status", () => {
    expect(
      shouldOfferModelPickerSetup(
        { ...profile("antigravity", { status: "error" }), enabled: false },
        [],
      ),
    ).toBe(false);
  });

  test("Antigravity with no models yet offers setup", () => {
    expect(shouldOfferModelPickerSetup(profile("antigravity", { status: "error" }), [])).toBe(true);
  });

  test("a ready account with a usable model does not", () => {
    expect(shouldOfferModelPickerSetup(profile("antigravity"), [gemini])).toBe(false);
  });

  test("a ready account whose only model is an unavailable saved choice does", () => {
    expect(
      shouldOfferModelPickerSetup(profile("antigravity"), [{ ...gemini, isUnavailable: true }]),
    ).toBe(true);
  });

  test("after sign-out it does, even with a cached model", () => {
    const entry = profile("antigravity");
    const signedOut = {
      ...entry,
      snapshot: { ...entry.snapshot, auth: { status: "unauthenticated" } },
    };
    expect(shouldOfferModelPickerSetup(signedOut as never, [gemini])).toBe(true);
  });
});

describe("resolveModelPickerSelectedModel", () => {
  test("the default marker is not guessed from the first model", () => {
    expect(
      resolveModelPickerSelectedModel({
        options: [{ slug: "gemini-fast", name: "Gemini Fast" }],
        model: ANTIGRAVITY_DEFAULT_MODEL,
        driverKind: AG,
      }),
    ).toBeUndefined();
  });

  test("the marker follows whichever model the catalog aliases it to; explicit models stay put", () => {
    const fast = { slug: "gemini-fast", name: "Gemini Fast" };
    const pro = { slug: "gemini-pro", name: "Gemini Pro" };
    const alias = [ANTIGRAVITY_DEFAULT_MODEL];
    const pick = (
      options: Array<{ slug: string; name: string; aliases?: string[] }>,
      model: string,
    ) => resolveModelPickerSelectedModel({ options, model, driverKind: AG })?.slug;

    const catalogA = [{ ...fast, aliases: alias }, pro];
    const catalogB = [fast, { ...pro, aliases: alias }];

    expect(pick(catalogA, ANTIGRAVITY_DEFAULT_MODEL)).toBe("gemini-fast");
    expect(pick(catalogB, ANTIGRAVITY_DEFAULT_MODEL)).toBe("gemini-pro");
    expect(pick(catalogB, "gemini-fast")).toBe("gemini-fast");
  });
});

describe("shouldIncludeModelPickerOption", () => {
  test.each([
    ["antigravity", "warning"],
    ["antigravity", "error"],
    ["opencode", "warning"],
    ["opencode", "error"],
  ] as const)("a %s provider in %s keeps only the active synthetic row", (driver, status) => {
    const entry = profile(driver, { status });
    const activeInstanceId = entry.instanceId;
    const activeModel = "missing-model";
    const include = (option: object, instance = activeInstanceId) =>
      shouldIncludeModelPickerOption({
        activeModel,
        activeInstanceId: instance,
        option: option as never,
        entry,
      });

    expect(include({ slug: activeModel, name: activeModel, isUnavailable: true })).toBe(true);
    expect(include({ slug: "stale/model", name: "Stale" })).toBe(false);
    expect(include({ slug: "other/missing", name: "Other", isUnavailable: true })).toBe(false);
    expect(
      include(
        { slug: activeModel, name: activeModel, isUnavailable: true },
        AgentProfileId.make(`${driver}_personal`),
      ),
    ).toBe(false);
  });

  test.each(["ready", "error"] as const)(
    "the internal Antigravity default marker is never a row (%s)",
    (status) => {
      const entry = profile("antigravity", { status });
      expect(
        shouldIncludeModelPickerOption({
          activeModel: ANTIGRAVITY_DEFAULT_MODEL,
          activeInstanceId: entry.instanceId,
          option: {
            slug: ANTIGRAVITY_DEFAULT_MODEL,
            name: ANTIGRAVITY_DEFAULT_MODEL,
            isUnavailable: true,
          },
          entry,
        }),
      ).toBe(false);
    },
  );
});
