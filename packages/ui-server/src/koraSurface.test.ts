// @effect-diagnostics nodeBuiltinImport:off -- a throwaway KORA_HOME for the blob flags file.
// Kora is coming soon (koraSurface.ts): a host that does not turn Kora on gets an empty roster that says so (and no warm
// Haiku routing session), and every other blobs.* RPC fails with a typed "Kora is coming soon". With the host's switch
// on (the daemon's developer override) the real handlers answer.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { BLOB_METHODS } from "@kora/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { setHost, type UiHost } from "./host.ts";

const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-surface-test-"));
process.env.KORA_HOME = NodePath.join(tmp, "home");
process.env.KORA_BLOBS_ROOT = NodePath.join(tmp, "Blobs");
NodeFS.mkdirSync(process.env.KORA_HOME, { recursive: true });

const { blobsHandlers } = await import("./handlers/blobs.ts");
const { gateKoraHandlers } = await import("./handlers.ts");
const { koraSurface } = await import("./koraSurface.ts");

let prewarms = 0;
const profile = { id: "kora", name: "Kora", archivedAt: null };
function bind(surface: "coming-soon" | "on" | undefined): void {
  setHost({
    log: () => {},
    swarm: { getStatus: async () => null, onStatus: () => () => {} },
    blobs: {
      store: {
        list: () => [profile],
        get: (id: string) => (id === "kora" ? profile : null),
        on: () => {},
        off: () => {},
      },
      prewarmRouting: () => {
        prewarms += 1;
      },
      koraReady: () => true,
    },
    ...(surface ? { koraSurface: () => surface } : {}),
  } as unknown as UiHost);
}

type Snap = { koraSurface?: string; blobs: unknown[]; koraReady: boolean };
const listSnapshot = (): Promise<Snap> =>
  Effect.runPromise(blobsHandlers[BLOB_METHODS.list]!({}) as Effect.Effect<Snap>);

NodeTest.test("a host that does not say is coming soon", () => {
  bind(undefined);
  NodeAssert.equal(koraSurface(), "coming-soon");
  bind("on");
  NodeAssert.equal(koraSurface(), "on");
});

NodeTest.test(
  "coming soon: the roster is empty, says so, and never warms the routing model",
  async () => {
    bind("coming-soon");
    prewarms = 0;
    const snap = await listSnapshot();
    NodeAssert.equal(snap.koraSurface, "coming-soon");
    NodeAssert.deepEqual(snap.blobs, []);
    NodeAssert.equal(snap.koraReady, false);
    NodeAssert.equal(prewarms, 0);
  },
);

NodeTest.test(
  "coming soon: every other blobs.* call fails calmly with a typed BlobError",
  async () => {
    bind("coming-soon");
    const gated = gateKoraHandlers({
      [BLOB_METHODS.get]: () => Effect.die("the real handler must not run"),
      [BLOB_METHODS.routinesSubscribe]: () => Stream.die("the real stream must not run"),
      "server.other": () => Effect.succeed("untouched"),
    });
    const unary = await Effect.runPromise(
      Effect.flip(
        gated[BLOB_METHODS.get]!({ blobId: "kora" }) as Effect.Effect<
          never,
          { code: string; message: string }
        >,
      ),
    );
    NodeAssert.equal(unary.code, "coming-soon");
    NodeAssert.match(unary.message, /Kora is coming soon/);
    const stream = await Effect.runPromise(
      Effect.flip(
        Stream.runDrain(
          gated[BLOB_METHODS.routinesSubscribe]!({}) as Stream.Stream<never, { code: string }>,
        ),
      ),
    );
    NodeAssert.equal(stream.code, "coming-soon");
    NodeAssert.equal(
      await Effect.runPromise(gated["server.other"]!({}) as Effect.Effect<string>),
      "untouched",
    );
  },
);

NodeTest.test(
  "override on: the real roster (with the prewarm) and the real handlers answer",
  async () => {
    bind("on");
    prewarms = 0;
    const snap = await listSnapshot();
    NodeAssert.equal(snap.koraSurface, "on");
    NodeAssert.equal(snap.blobs.length, 1);
    NodeAssert.equal(prewarms, 1);
    const gated = gateKoraHandlers({ [BLOB_METHODS.get]: () => Effect.succeed("real") });
    NodeAssert.equal(
      await Effect.runPromise(gated[BLOB_METHODS.get]!({}) as Effect.Effect<string>),
      "real",
    );
  },
);
