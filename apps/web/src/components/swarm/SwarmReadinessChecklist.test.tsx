import type { SwarmStatus } from "@kora/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  SWARM_STATUS_NEEDS_CONSENT,
  SWARM_STATUS_OPENCODE_MISSING,
  SWARM_STATUS_READY,
} from "../../util/swarm.fixtures";
import { SwarmReadinessChecklist } from "./SwarmReadinessChecklist";

function rowStates(status: SwarmStatus): Record<string, string> {
  const html = renderToStaticMarkup(<SwarmReadinessChecklist status={status} onFix={vi.fn()} />);
  const states: Record<string, string> = {};
  for (const match of html.matchAll(/data-swarm-readiness-row="([^"]+)" data-state="([^"]+)"/g)) {
    states[match[1]!] = match[2]!;
  }
  return states;
}

describe("SwarmReadinessChecklist", () => {
  it("lists OpenCode, each provider, free models and consent in order", () => {
    const html = renderToStaticMarkup(<SwarmReadinessChecklist status={SWARM_STATUS_READY} />);
    const ids = [...html.matchAll(/data-swarm-readiness-row="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["opencode", "zen", "openrouter", "cerebras", "models", "consent"]);
  });

  it("marks what is ready, optional and missing", () => {
    expect(rowStates(SWARM_STATUS_READY)).toEqual({
      opencode: "ok",
      zen: "ok",
      openrouter: "ok",
      cerebras: "optional",
      models: "ok",
      consent: "ok",
    });
    expect(rowStates(SWARM_STATUS_NEEDS_CONSENT).consent).toBe("problem");
    expect(rowStates(SWARM_STATUS_OPENCODE_MISSING).opencode).toBe("problem");
  });

  it("describes each row", () => {
    const html = renderToStaticMarkup(
      <SwarmReadinessChecklist status={SWARM_STATUS_OPENCODE_MISSING} />,
    );
    expect(html).toContain("Not installed");
    expect(html).toContain("Works · 1 free model");
    expect(html).toContain("Off");
    expect(html).toContain("1 available");
    expect(html).toContain("Required");
  });

  it("flags an untested or rejected provider", () => {
    const status: SwarmStatus = {
      ...SWARM_STATUS_READY,
      providers: SWARM_STATUS_READY.providers.map((provider) =>
        provider.provider === "zen"
          ? { ...provider, lastTest: null }
          : provider.provider === "openrouter"
            ? {
                ...provider,
                lastTest: { ...provider.lastTest!, ok: false, outcome: "invalid-key" as const },
              }
            : provider,
      ),
    };
    const states = rowStates(status);
    expect(states.zen).toBe("untested");
    expect(states.openrouter).toBe("problem");
    expect(renderToStaticMarkup(<SwarmReadinessChecklist status={status} />)).toContain(
      "Key rejected",
    );
  });

  it("shows no links without onFix", () => {
    const html = renderToStaticMarkup(<SwarmReadinessChecklist status={SWARM_STATUS_READY} />);
    expect(html).not.toContain("<button");
  });

  it("gives every row a link that jumps to the step that fixes it", () => {
    const onFix = vi.fn();
    const html = renderToStaticMarkup(
      <SwarmReadinessChecklist status={SWARM_STATUS_OPENCODE_MISSING} onFix={onFix} />,
    );
    const labels = [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual([
      "Fix: OpenCode",
      "Change: OpenCode Zen",
      "Change: OpenRouter",
      "Turn on: Cerebras (trial)",
      "Change: Free models",
      "Fix: Privacy consent",
    ]);
  });
});
