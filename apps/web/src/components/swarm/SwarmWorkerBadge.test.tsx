import type { FleetSwarmWorker } from "@kora/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SWARM_FLEET_WORKER } from "~/util/swarm.fixtures";

import { SwarmWorkerBadge, swarmAttemptsTooltip } from "./SwarmWorkerBadge";

const swarm = SWARM_FLEET_WORKER.swarm as FleetSwarmWorker;

describe("SwarmWorkerBadge", () => {
  it("renders provider · model in the neutral swarm badge", () => {
    const html = renderToStaticMarkup(<SwarmWorkerBadge swarm={swarm} />);
    expect(html).toContain('class="fleet-badge swarm"');
    expect(html).toContain("zen · big-pickle");
    expect(html).toContain('data-swarm-task="s3"');
  });

  it("lists every attempt, oldest first, in the tooltip", () => {
    const tip = swarmAttemptsTooltip(swarm);
    expect(tip).toContain("swarm task s3 · opencode/big-pickle");
    expect(tip.indexOf("openrouter/qwen/qwen3-coder:free (p5) rate-limited")).toBeGreaterThan(-1);
    expect(tip.indexOf("opencode/big-pickle (p7) ok")).toBeGreaterThan(
      tip.indexOf("openrouter/qwen"),
    );
  });

  it("shows the respawned flash only right after a failover", () => {
    const old = renderToStaticMarkup(<SwarmWorkerBadge swarm={swarm} />);
    expect(old).not.toContain("fleet-badge respawned");
    const fresh: FleetSwarmWorker = {
      ...swarm,
      attempts: swarm.attempts.map((a, i) =>
        i === swarm.attempts.length - 1 ? { ...a, at: Date.now() } : a,
      ),
    };
    const html = renderToStaticMarkup(<SwarmWorkerBadge swarm={fresh} />);
    expect(html).toContain("fleet-badge respawned");
    expect(html).toContain("↻ on zen/big-pickle");
    const first: FleetSwarmWorker = { ...fresh, attempt: 1, previousPaneIds: [] };
    expect(renderToStaticMarkup(<SwarmWorkerBadge swarm={first} />)).not.toContain("respawned");
  });
});
