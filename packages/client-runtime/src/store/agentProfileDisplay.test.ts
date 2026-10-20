import { AgentId, AgentProfileId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeAgentAccentColor,
  agentProfileInitials,
  resolveAgentProfileDisplayName,
  shouldShowInstanceBadge,
} from "./agentProfileDisplay.ts";

const codex = AgentId.make("codex");
const claude = AgentId.make("claude");

describe("resolveAgentProfileDisplayName", () => {
  const nameOf = (instance: string, displayName?: string) =>
    resolveAgentProfileDisplayName({
      driver: codex,
      instanceId: AgentProfileId.make(instance),
      ...(displayName === undefined ? {} : { displayName }),
    });

  it.each([
    ["a name the server chose", "codex", "Work", "Work"],
    ["the slug when only the brand came back", "codex_personal", "Codex", "Codex Personal"],
    ["the brand for the default instance", "codex", undefined, "Codex"],
  ])("uses %s", (_case, instance, displayName, expected) => {
    expect(nameOf(instance, displayName)).toBe(expected);
  });
});

describe("agentProfileInitials", () => {
  it.each([
    ["Codex", "CO"],
    ["(ACP)", "AC"],
    ["", ""],
    // Code points, not UTF-16 units: an emoji stays whole.
    ["😀 Work", "😀W"],
    ["😀", "😀"],
  ])("%j gives %j", (label, initials) => {
    expect(agentProfileInitials(label)).toBe(initials);
  });
});

describe("normalizeAgentAccentColor", () => {
  it.each(["#ff8800", "#FF8800"])("keeps the six-digit hex %s", (color) => {
    expect(normalizeAgentAccentColor(color)).toBe(color);
  });

  it.each(["blue", "#fff", "   ", undefined])("drops %j", (color) => {
    expect(normalizeAgentAccentColor(color)).toBeUndefined();
  });
});

describe("shouldShowInstanceBadge", () => {
  const plain = (driverKind: AgentId) => ({ accentColor: undefined, driverKind });

  it("badges an instance with its own accent", () => {
    const tinted = { accentColor: "#ff8800", driverKind: codex };
    expect(shouldShowInstanceBadge(tinted, [tinted])).toBe(true);
  });

  it("badges instances whose driver appears twice", () => {
    const [one, two] = [plain(codex), plain(codex)];
    expect(shouldShowInstanceBadge(one, [one, two])).toBe(true);
  });

  it("leaves a lone, untinted instance plain", () => {
    const mine = plain(codex);
    expect(shouldShowInstanceBadge(mine, [mine, plain(claude)])).toBe(false);
  });
});
