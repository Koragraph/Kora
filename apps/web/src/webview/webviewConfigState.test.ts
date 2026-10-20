import { describe, expect, it } from "@effect/vitest";
import { HostId } from "@kora/contracts";
import * as Effect from "effect/Effect";

import {
  WebviewBridgeUnavailableError,
  WebviewConfigLoadError,
  loadWebviewConfig,
} from "./webviewConfigState";

const HOST = HostId.make("host-7");
const CONFIG = { preloadUrl: null, webPreferences: "sandbox=yes", partition: "persist:x-preview" };

describe("loadWebviewConfig", () => {
  it.effect("asks the bridge with both the host and the profile", () =>
    Effect.gen(function* () {
      const asked: Array<[HostId, string | undefined]> = [];
      const loaded = yield* loadWebviewConfig(HOST, "work", {
        getWebConfig: (host, profile) => {
          asked.push([host, profile]);
          return Promise.resolve(CONFIG);
        },
      });
      expect(asked).toEqual([[HOST, "work"]]);
      expect(loaded).toEqual(CONFIG);
    }),
  );

  it.effect("wraps a bridge rejection, keeping it as the cause but not in the message", () =>
    Effect.gen(function* () {
      const original = new Error("ipc is down");
      const failure = yield* Effect.flip(
        loadWebviewConfig(HOST, undefined, { getWebConfig: () => Promise.reject(original) }),
      );
      expect(failure).toBeInstanceOf(WebviewConfigLoadError);
      expect(failure.hostId).toBe(HOST);
      expect(failure.cause).toBe(original);
      expect(failure.message).not.toContain(original.message);
    }),
  );

  it.effect("a missing bridge is a different error type, without a cause", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(loadWebviewConfig(HOST, undefined, null));
      expect(failure).toBeInstanceOf(WebviewBridgeUnavailableError);
      expect(failure.hostId).toBe(HOST);
      expect(failure.message).toContain(HOST);
      expect("cause" in failure).toBe(false);
    }),
  );
});
