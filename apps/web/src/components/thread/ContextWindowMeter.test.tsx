import { EventId, TurnId } from "@kora/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { latestContextWindowSnapshot } from "~/util/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

// The popover is flattened so the markup shows its content and the trigger's close delay.
vi.mock("../ui/popover", () => {
  const passThrough = (props: { children: ReactNode }) => props.children;
  return {
    PopoverPopup: passThrough,
    Popover: passThrough,
    PopoverTrigger: (props: { render: ReactNode; closeDelay: number }) => (
      <div data-close-delay={props.closeDelay}>{props.render}</div>
    ),
  };
});

const usage = latestContextWindowSnapshot([
  {
    id: EventId.make("ctx-1"),
    kind: "context-window.updated",
    tone: "info",
    summary: "Context updated",
    turnId: TurnId.make("t-1"),
    createdAt: "2026-06-10T09:00:00.000Z",
    payload: { maxTokens: 400_000, usedTokens: 80_000 },
  },
])!;

const NOON = Date.parse("2026-06-10T12:00:00Z");

type MeterProps = Partial<Parameters<typeof ContextWindowMeter>[0]>;
/** The meter's markup for the fixture usage with `props` on top. */
const meter = (props: MeterProps = {}) =>
  renderToStaticMarkup(<ContextWindowMeter usage={usage} {...props} />);

describe("ContextWindowMeter", () => {
  it("closes straight away when there is nothing to click", () => {
    const markup = meter();
    expect(markup).toContain('data-close-delay="0"');
    expect(markup).not.toContain("Compact context");
  });

  it("lingers so the pointer can reach the compact button", () => {
    const markup = meter({ onCompact: () => {} });
    expect(markup).toContain('data-close-delay="150"');
    expect(markup).toContain("Compact context");
  });

  it("disables compacting with the reason as visible text", () => {
    const reason = "Finish your draft before compacting";
    const markup = meter({
      compactDisabledReason: reason,
      compactDisabled: true,
      onCompact: () => {},
    });
    expect(markup).toContain('disabled=""');
    expect(markup).toContain(`>${reason}<`);
    expect(markup).not.toContain(`aria-label="${reason}"`);
  });

  it("lists the cost and each plan window with its reset time", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        now={NOON}
        usage={{ ...usage, costUsd: 1.07 }}
        onOpenUsage={() => {}}
        planUsage={{
          plan: "Pro",
          checkedAt: "2026-06-10T11:58:00Z",
          windows: [
            {
              id: "weekly",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 41,
              resetsAt: "2026-06-10T15:30:00Z",
            },
          ],
        }}
      />,
    );
    for (const text of [
      "$1.07",
      "Plan usage",
      "Pro",
      "Weekly",
      "41%",
      "resets in 3h 30m",
      "Usage details",
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('data-close-delay="150"');
  });

  it("says when the plan limit was hit and when it lifts", () => {
    const markup = meter({
      planUsage: {
        windows: [],
        checkedAt: "2026-06-10T11:59:00Z",
        limited: { resetsAt: "2026-06-10T14:00:00Z" },
      },
      now: NOON,
    });
    expect(markup).toContain("Limit reached · resets in 2h");
  });
});
