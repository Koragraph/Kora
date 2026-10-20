import { describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { AgentUsageLimits } from "@kora/contracts";

vi.mock("../ui/popover", () => ({
  PopoverTrigger: ({ render, children }: { render: React.ReactElement; children: ReactNode }) => (
    <div data-trigger="">
      {render}
      {children}
    </div>
  ),
  PopoverPopup: ({ children }: { children: ReactNode }) => <div data-popup="">{children}</div>,
  Popover: ({ children }: { children: ReactNode }) => children,
}));

import { UsageDetails, UsageSignIndicator } from "./UsageSignIndicator";
import { usageReading, usageSections } from "./usageSign.logic";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const claude: AgentUsageLimits = {
  checkedAt: "2026-10-13T11:56:00Z",
  plan: "Max",
  windows: [
    {
      id: "five_hour",
      kind: "session",
      label: "5-hour session",
      usedPercent: 40,
      resetsAt: "2026-10-13T14:00:00Z",
    },
    {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly · all models",
      usedPercent: 98,
      resetsAt: "2026-10-16T09:29:00Z",
    },
  ],
} as AgentUsageLimits;
const codex = {
  checkedAt: "2026-10-13T11:00:00Z",
  plan: "Free",
  windows: [],
  limited: { resetsAt: "2026-10-16T20:25:00Z" },
} as unknown as AgentUsageLimits;
const providers = [
  { instanceId: "claude", driver: "claude", usageLimits: claude },
  { instanceId: "codex", driver: "codex", usageLimits: codex },
];

describe("UsageSignIndicator", () => {
  it("is a labelled button holding the sprite", () => {
    const reading = usageReading({ driver: "claude", limits: claude, now: NOW })!;
    const html = renderToStaticMarkup(
      <UsageSignIndicator
        now={NOW}
        onOpenUsage={() => {}}
        onRefresh={async () => {}}
        reading={reading}
        reducedMotion
        sections={usageSections(providers, "claude", NOW)}
      />,
    );
    expect(html).toContain(
      'aria-label="Claude plan: 2% of this week left (checked 4 min ago). Show details"',
    );
    expect(html).toContain('data-usage-left="2"');
    expect(html).toContain('data-usage-tier="3"');
    expect(html).toContain('data-frame="0"');
    expect(html).toContain('fill="#e5534b"'); // red board under 5% left
  });

  it("details: plan + checked time, every window with its local reset, the other provider in one line, refresh, link", () => {
    const html = renderToStaticMarkup(
      <UsageDetails
        now={NOW}
        onOpenUsage={() => {}}
        onRefresh={async () => {}}
        sections={usageSections(providers, "claude", NOW)}
      />,
    );
    expect(html).toContain("Claude");
    expect(html).toContain("Max");
    expect(html).toContain("checked 4 min ago");
    expect(html).toContain("5-hour session");
    expect(html).toContain("Weekly · all models");
    expect(html).toContain("98% used");
    expect(html).toMatch(/resets Fri \d{1,2}:\d{2} [AP]M/);
    expect(html).toMatch(/Codex Free: limited, resets \w{3} \d{1,2}:\d{2} [AP]M/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Refresh");
    expect(html).toContain("Usage details");
  });
});

describe("UsageSignSprite motion", () => {
  it("holds still (frame 0) unless hovered or focused", async () => {
    const { UsageSignSprite } = await import("./UsageSignIndicator");
    const idle = renderToStaticMarkup(<UsageSignSprite reading={{ tier: 3, left: 2 }} />);
    const hover = renderToStaticMarkup(<UsageSignSprite active reading={{ tier: 3, left: 2 }} />);
    expect(idle).toContain('data-frame="0"');
    // Server render never advances frames; the active prop is what lets the client clock run them.
    expect(hover).toContain('data-frame="0"');
  });
});
