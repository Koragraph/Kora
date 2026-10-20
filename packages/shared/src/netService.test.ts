import * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Net from "./netService.ts";

/** Holds a real listener on an OS-chosen port for the duration of a test. */
const occupied = (host: string) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeNet.Server>((done, reject) => {
          const listener = NodeNet.createServer();
          listener.once("error", reject);
          listener.listen({ host, port: 0 }, () => done(listener));
        }),
    ),
    (listener) => Effect.sync(() => listener.close()),
  ).pipe(Effect.map((listener) => (listener.address() as NodeNet.AddressInfo).port));

it.layer(Net.layer)("Net", (it) => {
  describe("loopback port probing", () => {
    it.effect("hands out a positive port from the OS", () =>
      Effect.gen(function* () {
        const net = yield* Net.NetService;
        assert.isAbove(yield* net.reserveLoopbackPort(), 0);
      }),
    );

    it.effect("sees a port with a listener as taken", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const net = yield* Net.NetService;
          const port = yield* occupied("127.0.0.1");
          assert.isFalse(yield* net.isPortAvailableOnLoopback(port));
        }),
      ),
    );

    it.effect("keeps the preferred port while it is free", () =>
      Effect.gen(function* () {
        const net = yield* Net.NetService;
        const wanted = yield* net.reserveLoopbackPort();
        assert.strictEqual(yield* net.findAvailablePort(wanted), wanted);
      }),
    );

    it.effect("picks another port when 0.0.0.0 already holds the preferred one", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const net = yield* Net.NetService;
          const taken = yield* occupied("0.0.0.0");
          const chosen = yield* net.findAvailablePort(taken);
          assert.isAbove(chosen, 0);
          assert.notStrictEqual(chosen, taken);
        }),
      ),
    );
  });
});
