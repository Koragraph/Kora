import { deriveAgentPrefsFields, nextAgentConfigWithFieldValue } from "./AgentPrefsForm";

import { DRIVER_OPTION_BY_VALUE } from "./agentDriverMeta";
import { AgentId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

describe("AgentPrefsForm helpers", () => {
  it("preserves false boolean fields when clearWhenEmpty is persist", () => {
    const next = nextAgentConfigWithFieldValue(
      undefined,
      {
        clearWhenEmpty: "persist",
        label: "Experimental",
        control: "switch",
        key: "experimental",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextAgentConfigWithFieldValue(
      undefined,
      {
        defaultBooleanValue: true,
        clearWhenEmpty: "omit",
        label: "Experimental",
        control: "switch",
        key: "experimental",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("omits true boolean fields when true is the default", () => {
    const next = nextAgentConfigWithFieldValue(
      { forkOwned: 1, experimental: false },
      {
        defaultBooleanValue: true,
        clearWhenEmpty: "omit",
        label: "Experimental",
        control: "switch",
        key: "experimental",
      },
      true,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits false boolean fields when clearWhenEmpty is omit", () => {
    const next = nextAgentConfigWithFieldValue(
      { forkOwned: 1, experimental: true },
      {
        defaultBooleanValue: false,
        clearWhenEmpty: "omit",
        label: "Experimental",
        control: "switch",
        key: "experimental",
      },
      false,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const next = nextAgentConfigWithFieldValue(
      { forkOwned: 1, homePath: "~/.codex" },
      { key: "homePath", label: "Home", control: "text", clearWhenEmpty: "omit" } as never,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("shows no connection fields on any agent card: nothing reads them (paths live in Settings > Engines)", () => {
    for (const id of ["claude", "codex", "opencode", "cursor", "grok"]) {
      const driver = DRIVER_OPTION_BY_VALUE[AgentId.make(id)];
      if (driver === undefined) continue;
      expect(
        deriveAgentPrefsFields(driver).map((field) => field.key),
        id,
      ).toEqual([]);
    }
  });

  it("shows no ACP-era sign-in fields for Antigravity (agy signs itself in; the path is in Settings > Engines)", () => {
    const antigravity = DRIVER_OPTION_BY_VALUE[AgentId.make("antigravity")];
    expect(antigravity).toBeDefined();
    expect(deriveAgentPrefsFields(antigravity!).map((field) => field.key)).toEqual([]);
  });
});
