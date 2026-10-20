import { describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { FleetSwarmActivity } from "@kora/contracts";

// Render the menu popup inline so the test sees every line the chip can show, not just the trigger.
vi.mock("../ui/menu", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    MenuTrigger: ({ children }: { children?: ReactNode }) => (
      <button type="button">{children}</button>
    ),
    MenuItem: ({ children }: { children?: ReactNode }) => <div role="menuitem">{children}</div>,
    MenuSeparator: () => <hr />,
    MenuPopup: Pass,
    MenuGroupLabel: Pass,
    MenuGroup: Pass,
    Menu: Pass,
  };
});

import { SwarmActivityChipView } from "./SwarmActivityChip";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const FULL: FleetSwarmActivity = {
  exhausted: true,
  byModel: [
    { provider: "zen", model: "opencode/big-pickle", modelLabel: "big-pickle", workers: 2 },
    {
      workers: 1,
      modelLabel: "qwen3-coder:free",
      model: "openrouter/qwen/qwen3-coder:free",
      provider: "openrouter",
    },
  ],
  bounced: 1,
  passedFirstTry: 2,
  respawns: 2,
  reportsReturned: 3,
  delegated: 5,
};

describe("SwarmActivityChipView", () => {
  it("renders nothing until the leader delegates (no idle 0-delegated chip)", () => {
    expect(
      renderToStaticMarkup(<SwarmActivityChipView activity={null} claudeTokens={null} />),
    ).toBe("");
  });

  it("shows the measured value meter when the daemon reports leader and worker tokens", () => {
    const t = text(
      renderToStaticMarkup(
        <SwarmActivityChipView
          activity={{
            ...FULL,
            exhausted: false,
            leaderTokens: { input: 2_000, cached: 300_000, output: 12_000, turns: 4 },
            workerTokens: { input: 90_000, cached: 300_000, output: 10_000, tasks: 5 },
          }}
          claudeTokens={42_000}
        />,
      ),
    );
    expect(t).toContain(
      "Claude used 14k new tokens (+300k cached) · workers did 5 tasks (400k tokens, free)",
    );
    expect(t).toContain("300k cached context (reads + writes) over 4 turns");
    expect(t).not.toContain("Claude context");
    expect(t).not.toContain("$");
    expect(t.toLowerCase()).not.toContain("sav");
  });

  it("never renders a dollar sign or any 'saved/savings' wording (X5)", () => {
    for (const [activity, tokens] of [
      [{ ...FULL, delegated: 0, reportsReturned: 0, byModel: [], exhausted: false }, 0],
      [null, null],
      [FULL, null],
      [FULL, 1_234_567],
    ] as const) {
      const html = renderToStaticMarkup(
        <SwarmActivityChipView
          activity={activity}
          claudeTokens={tokens}
          onOpenSettings={() => {}}
        />,
      );
      const t = text(html);
      expect(t).not.toContain("$");
      expect(t.toLowerCase()).not.toContain("sav");
    }
  });
  it("names the thread's lead in the context line", () => {
    const t = text(
      renderToStaticMarkup(
        <SwarmActivityChipView activity={FULL} claudeTokens={42_000} lead="Codex" />,
      ),
    );
    expect(t).toContain("Codex context: 42k tokens");
  });
  it("shows measured counts and Claude context tokens", () => {
    const t = text(
      renderToStaticMarkup(
        <SwarmActivityChipView activity={FULL} claudeTokens={42_000} onOpenSettings={() => {}} />,
      ),
    );
    expect(t).toContain("Stretch · 5 delegated · 3 reports");
    expect(t).toContain("Claude context: 42k tokens");
    expect(t).toContain("2 passed first try");
    expect(t).toContain("1 bounced");
    expect(t).toContain("2 failovers");
    expect(t).toContain("zen · big-pickle × 2 workers");
    expect(t).toContain("openrouter · qwen3-coder:free × 1 worker");
    expect(t).toContain("Swarm setup");
  });
});
