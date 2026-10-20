import type { FleetWorker, SwarmStatus } from "@kora/contracts";
import fleetWorkerSwarmSample from "@kora/contracts/fixtures/fleet-worker-swarm.sample.json" with { type: "json" };
import swarmStatusSample from "@kora/contracts/fixtures/swarm-status.sample.json" with { type: "json" };

/**
 * Test / story samples built from the canonical wire fixtures (packages/contracts/src/fixtures).
 * The JSON is decoded strictly by contracts/src/swarm.test.ts, so these casts are safe.
 */

/**
 * Not ready: the privacy consent is missing (the canonical sample), as an older daemon reports it — without the
 * optional `supplyState` (paid / local supply). Tests that need supply add it explicitly.
 */
const { supplyState: _supplyState, ...statusWithoutSupply } = swarmStatusSample;
export const SWARM_STATUS_NEEDS_CONSENT = statusWithoutSupply as unknown as SwarmStatus;

/** The same host after consent: ready. */
export const SWARM_STATUS_READY: SwarmStatus = {
  ...SWARM_STATUS_NEEDS_CONSENT,
  ready: true,
  blockers: [],
  consent: { requiredVersion: 1, acceptedVersion: 1, acceptedAt: 1_790_000_000_000 },
};

/** Nothing installed yet. */
export const SWARM_STATUS_OPENCODE_MISSING: SwarmStatus = {
  ...SWARM_STATUS_NEEDS_CONSENT,
  blockers: [
    { code: "opencode-missing", message: "OpenCode isn't installed or can't be found." },
    ...SWARM_STATUS_NEEDS_CONSENT.blockers,
  ],
  opencode: {
    ...SWARM_STATUS_NEEDS_CONSENT.opencode,
    installed: false,
    path: null,
    source: null,
    version: null,
    versionOk: false,
  },
};

/** A swarm worker that failed over once, reported, and passed verify after one bounce. */
export const SWARM_FLEET_WORKER = fleetWorkerSwarmSample as unknown as FleetWorker;
