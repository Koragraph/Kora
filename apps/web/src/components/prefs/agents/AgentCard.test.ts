import { AgentId, AgentProfileId, type AgentModel, type AgentStatus } from "@kora/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";

import { AgentCard, deriveAgentModelsForDisplay } from "./AgentCard";

type CardProps = Parameters<typeof AgentCard>[0];

const noop = () => undefined;
function card(over: Partial<CardProps> & Pick<CardProps, "instance" | "instanceId">) {
  const props = {
    expanded: false,
    modelOrder: [],
    favoriteModels: [],
    hiddenModels: [],
    liveProvider: undefined,
    driverOption: undefined,
    onUpdate: noop,
    onExpandedChange: noop,
    onModelOrderChange: noop,
    onFavoriteModelsChange: noop,
    onHiddenModelsChange: noop,
    ...over,
  } as CardProps;
  return renderToStaticMarkup(createElement(AgentCard, props));
}

const live = (driver: string, id: string, over: Partial<AgentStatus>): AgentStatus => ({
  models: [],
  skills: [],
  slashCommands: [],
  checkedAt: "2026-08-28T12:00:00.000Z",
  auth: { status: "unknown" },
  status: "ready",
  version: null,
  installed: true,
  enabled: true,
  driver: AgentId.make(driver),
  instanceId: AgentProfileId.make(id),
  ...over,
});

describe("AgentCard", () => {
  const claude = AgentId.make("claude");
  const claudeId = AgentProfileId.make("claude");

  test("an unknown driver opens on Setup and Environment tabs (no Models), with Turn off", () => {
    const out = card({
      instanceId: claudeId,
      expanded: true,
      instance: { driver: claude, enabled: true },
    });
    expect(out).toContain(">Setup<");
    expect(out).toContain(">Environment<");
    expect(out).not.toContain(">Models<");
    expect(out).toContain("Turn off");
    expect(out).toContain("does not ship");
  });

  test("an agent that is off offers Turn on, not a list switch", () => {
    const out = card({ instanceId: claudeId, instance: { driver: claude, enabled: false } });
    expect(out).toContain("Turn on");
    expect(out).toContain('data-state="off"');
    expect(out).not.toContain('role="switch"');
  });

  test.each([false, true])("a failed probe's message is shown (expanded=%s)", (expanded) => {
    const message =
      "Probe failed: cannot create shadow home entry 'auth.json'; it is not a symlink.";
    const out = card({
      expanded,
      instanceId: AgentProfileId.make("codex_work"),
      instance: { driver: AgentId.make("codex") },
      liveProvider: live("codex", "codex_work", { status: "error", message }),
    });
    expect(out).toContain("Unavailable");
    expect(out).toContain("is not a symlink");
  });

  test("an opened card shows the account email redacted behind a toggle", () => {
    const out = card({
      expanded: true,
      instanceId: AgentProfileId.make("codex"),
      instance: { driver: AgentId.make("codex") },
      liveProvider: live("codex", "codex", {
        version: "1.0.0",
        auth: { status: "authenticated", email: "dev@example.com" },
      }),
    });
    expect(out).toContain("Ready · signed in");
    expect(out).toContain('aria-label="Toggle account email visibility"');
    expect(out).toContain("blur-[2px]");
    expect(out).not.toContain("dev@example.com");
  });
});

describe("deriveAgentModelsForDisplay", () => {
  const model = (slug: string, name: string, over: Partial<AgentModel> = {}): AgentModel => ({
    slug,
    name,
    isCustom: true,
    capabilities: null,
    ...over,
  });

  test("the configured entry's name and capabilities win over the stale live custom row", () => {
    const liveCaps = { optionDescriptors: [] };
    const configuredCaps = {
      optionDescriptors: [
        {
          options: [{ id: "high", label: "High", isDefault: true }],
          currentValue: "high",
          type: "select" as const,
          label: "Reasoning",
          id: "reasoningEffort",
        },
      ],
    };
    const out = deriveAgentModelsForDisplay({
      liveModels: [
        model("bare", "bare", { capabilities: liveCaps }),
        model("named", "named", { capabilities: liveCaps }),
      ],
      customModels: [
        { slug: "bare", name: "bare", capabilities: null },
        { slug: "named", name: "My Model", capabilities: configuredCaps },
      ],
    });

    // an entry with no capabilities of its own keeps the driver default the server filled in
    expect(out[0]).toEqual({ slug: "bare", name: "bare", isCustom: true, capabilities: liveCaps });
    expect(out[1]).toEqual({
      slug: "named",
      name: "My Model",
      isCustom: true,
      capabilities: configuredCaps,
    });
  });

  test("custom rows that left the config disappear; server models stay", () => {
    const out = deriveAgentModelsForDisplay({
      liveModels: [
        model("kept", "Kept"),
        model("removed", "Removed"),
        model("server", "Server Model", { isCustom: false }),
      ],
      customModels: [{ slug: "kept", name: "kept", capabilities: null }],
    });
    expect(out.map((m) => m.slug)).toEqual(["server", "kept"]);
  });
});
