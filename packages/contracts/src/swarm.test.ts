import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import fleetWorkerSwarmSample from "./fixtures/fleet-worker-swarm.sample.json" with { type: "json" };
import swarmStatusSample from "./fixtures/swarm-status.sample.json" with { type: "json" };
import { FLEET_METHODS, FleetSnapshot, FleetWorker } from "./fleet.ts";
import { KoraRpcGroup, RPC_METHODS } from "./koraRpc.ts";
import {
  SWARM_METHODS,
  SWARM_PRIVACY_NOTICE_VERSION,
  SWARM_SKILL_NAME,
  SwarmSetKeyInput,
  SwarmStatus,
  SwarmStreamEvent,
} from "./swarm.ts";

// Strict: an extra key in a fixture (a field the schema does not know) is a contract drift.
const strict = { onExcessProperty: "error" } as const;
const decodeStatus = Schema.decodeUnknownEffect(SwarmStatus);
const encodeStatus = Schema.encodeEffect(SwarmStatus);
const decodeWorker = Schema.decodeUnknownEffect(FleetWorker);
const encodeWorker = Schema.encodeEffect(FleetWorker);

it.effect("decodes the canonical SwarmStatus fixture strictly and round-trips it", () =>
  Effect.gen(function* () {
    const status = yield* decodeStatus(swarmStatusSample, strict);
    assert.strictEqual(status.keyStorage, "file");
    assert.strictEqual(status.providers.length, 3);
    assert.deepStrictEqual<unknown>(yield* encodeStatus(status), swarmStatusSample);
  }),
);

it.effect("decodes the canonical swarm FleetWorker fixture strictly and round-trips it", () =>
  Effect.gen(function* () {
    const worker = yield* decodeWorker(fleetWorkerSwarmSample, strict);
    assert.strictEqual(worker.agent, "opencode");
    assert.strictEqual(worker.swarm?.verify?.state, "passed");
    assert.deepStrictEqual<unknown>(yield* encodeWorker(worker), fleetWorkerSwarmSample);
  }),
);

it.effect("a FleetWorker without `swarm` still decodes (non-swarm workers)", () =>
  Effect.gen(function* () {
    const { swarm: _swarm, ...plain } = fleetWorkerSwarmSample;
    const worker = yield* decodeWorker({ ...plain, agent: "claude" }, strict);
    assert.strictEqual(worker.swarm, undefined);
  }),
);

it.effect("a FleetSnapshot carries the optional swarm activity", () =>
  Effect.gen(function* () {
    const snapshot = yield* Schema.decodeUnknownEffect(FleetSnapshot)(
      {
        threadId: "thread-1",
        orchestratorId: "chat:t_1",
        workers: [fleetWorkerSwarmSample],
        plan: "",
        events: [],
        lastVerdict: null,
        updatedAt: "2026-09-24T00:00:00.000Z",
        swarm: {
          delegated: 1,
          reportsReturned: 1,
          respawns: 1,
          passedFirstTry: 0,
          bounced: 1,
          byModel: [
            { provider: "zen", model: "opencode/big-pickle", modelLabel: "big-pickle", workers: 1 },
          ],
          exhausted: false,
        },
      },
      strict,
    );
    assert.strictEqual(snapshot.swarm?.bounced, 1);
  }),
);

it.effect("the status stream frame wraps a SwarmStatus", () =>
  Effect.gen(function* () {
    const frame = yield* Schema.decodeUnknownEffect(SwarmStreamEvent)(
      { type: "snapshot", status: swarmStatusSample },
      strict,
    );
    assert.strictEqual(frame.status.ready, false);
  }),
);

it.effect("setKey rejects an empty key", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      Schema.decodeUnknownEffect(SwarmSetKeyInput)({ provider: "openrouter", apiKey: "  " }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it("freezes the swarm constants and registers every swarm RPC", () => {
  assert.strictEqual(SWARM_PRIVACY_NOTICE_VERSION, 1);
  assert.strictEqual(SWARM_SKILL_NAME, "koraswarm");
  assert.deepStrictEqual(Object.values(SWARM_METHODS).toSorted(), [
    "swarm.clearKey",
    "swarm.getStatus",
    "swarm.install.cancel",
    "swarm.install.start",
    "swarm.setConsent",
    "swarm.setKey",
    "swarm.setPreferences",
    "swarm.subscribe",
    "swarm.testProvider",
  ]);
  assert.strictEqual(RPC_METHODS.fleetReadReport, "fleet.readReport");
  assert.strictEqual(FLEET_METHODS.readReport, "fleet.readReport");
  for (const tag of [...Object.values(SWARM_METHODS), FLEET_METHODS.readReport]) {
    assert.isTrue(KoraRpcGroup.requests.has(tag), `${tag} is registered in KoraRpcGroup`);
  }
});
