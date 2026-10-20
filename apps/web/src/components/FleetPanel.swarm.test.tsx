import type { FleetSwarmWorker, FleetWorker } from "@kora/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SWARM_FLEET_WORKER } from "~/util/swarm.fixtures";

import { EmptyFleet, fleetHeaderSummary, workerTileInfo } from "./FleetPanel";
import { PaneChrome } from "./fleet/PaneChrome";

const swarm = SWARM_FLEET_WORKER.swarm as FleetSwarmWorker;
const withSwarm = (
  over: Partial<FleetSwarmWorker>,
  worker: Partial<FleetWorker> = {},
): FleetWorker =>
  ({ ...SWARM_FLEET_WORKER, ...worker, swarm: { ...swarm, ...over } }) as FleetWorker;
const plain: FleetWorker = { ...SWARM_FLEET_WORKER, agent: "claude", costUsd: 0.42 } as FleetWorker;
delete (plain as { swarm?: unknown }).swarm;

describe("workerTileInfo", () => {
  it("swarm worker: free tier instead of a cost, verify after bounces, report button label", () => {
    const info = workerTileInfo(SWARM_FLEET_WORKER);
    expect(info.chromeState).toBe("idle");
    expect(info.stateLabel).toBeNull();
    expect(info.costText).toBe("free tier");
    expect(info.verifyText).toBe("verified · 1 bounce");
    expect(info.verifyTone).toBe("ok");
    expect(info.reportLabel).toBe("Report · 2.1 KB");
    // even a costUsd on the wire never becomes a dollar figure for a swarm worker
    expect(workerTileInfo({ ...SWARM_FLEET_WORKER, costUsd: 1.5 }).costText).toBe("free tier");
  });

  it("phases map to chrome state + label; a live dialog or exit wins", () => {
    expect(
      workerTileInfo(withSwarm({ phase: "rate-limited" }, { state: "working" })),
    ).toMatchObject({
      chromeState: "waiting",
      stateLabel: "rate-limited",
    });
    expect(workerTileInfo(withSwarm({ phase: "respawning" }))).toMatchObject({
      chromeState: "waiting",
      stateLabel: "switching model…",
    });
    expect(workerTileInfo(withSwarm({ phase: "exhausted" }))).toMatchObject({
      chromeState: "needs-you",
      stateLabel: "no free models left",
    });
    expect(workerTileInfo(withSwarm({ phase: "failed" }))).toMatchObject({
      chromeState: "exited",
      stateLabel: "opencode crashed",
    });
    expect(
      workerTileInfo(withSwarm({ phase: "rate-limited" }, { state: "blocked" })),
    ).toMatchObject({
      chromeState: "needs-you",
      stateLabel: null,
    });
    expect(workerTileInfo(withSwarm({ phase: "starting" }, { state: "unknown" })).stateLabel).toBe(
      "starting…",
    );
    expect(
      workerTileInfo(withSwarm({ phase: "starting" }, { state: "working" })).stateLabel,
    ).toBeNull();
  });

  it("verify states: bounced n, failed, pending, skipped", () => {
    const v = (state: "bounced" | "failed" | "pending" | "skipped", bounces: number) =>
      workerTileInfo(withSwarm({ verify: { state, bounces, summary: null } }));
    expect(v("bounced", 2)).toMatchObject({ verifyText: "bounced 2", verifyTone: "warn" });
    expect(v("failed", 2)).toMatchObject({
      verifyText: "verify failed · 2 bounces",
      verifyTone: "bad",
    });
    expect(v("pending", 0)).toMatchObject({ verifyText: "verifying…", verifyTone: "muted" });
    expect(v("skipped", 0).verifyText).toBeNull();
    expect(workerTileInfo(withSwarm({ verify: null, report: null }))).toMatchObject({
      verifyText: null,
      reportLabel: null,
    });
  });

  it("non-swarm worker keeps its cost and plain state", () => {
    expect(workerTileInfo(plain)).toMatchObject({
      chromeState: "idle",
      costText: "$0.42",
      verifyText: null,
      reportLabel: null,
    });
  });
});

describe("fleet header + empty state", () => {
  it("adds the rate-limited count only when there is one", () => {
    expect(fleetHeaderSummary([])).toBe("no workers yet");
    expect(fleetHeaderSummary([SWARM_FLEET_WORKER])).toBe("1 live · 0 working · 0 need you");
    expect(
      fleetHeaderSummary([
        SWARM_FLEET_WORKER,
        withSwarm({ phase: "rate-limited" }, { paneId: "p8", state: "working" }),
      ]),
    ).toBe("2 live · 1 working · 0 need you · 1 rate-limited");
  });

  it("swarm EmptyFleet copy", () => {
    expect(renderToStaticMarkup(<EmptyFleet swarm />)).toContain(
      "With Stretch on, your agent hands self-contained tasks to workers: free models first, then cheap Haiku or GPT Luna.",
    );
    expect(renderToStaticMarkup(<EmptyFleet />)).toContain("you approve each one");
  });
});

describe("PaneChrome", () => {
  it("renders the waiting state with a custom label", () => {
    const html = renderToStaticMarkup(
      <PaneChrome state="waiting" stateLabel="rate-limited" title="t">
        <div />
      </PaneChrome>,
    );
    expect(html).toContain('class="state waiting"');
    expect(html).toContain("rate-limited");
    expect(html).not.toContain("pane wake");
  });
  it("falls back to the state word", () => {
    const html = renderToStaticMarkup(
      <PaneChrome state="needs-you" title="t">
        <div />
      </PaneChrome>,
    );
    expect(html).toContain("needs you");
  });
});
