import { resolveThreadDetailRef } from "./entities";
import { describe, expect, it } from "vite-plus/test";
import { HostId, ThreadId } from "@kora/contracts";
import { hostThreadRef } from "@kora/client-runtime/host";

const threadRef = hostThreadRef(HostId.make("environment-1"), ThreadId.make("thread-1"));

describe("resolveThreadDetailRef", () => {
  it("keeps direct server-thread lookups enabled when the shell has not loaded it", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        waitForShell: false,
        shellExists: false,
      }),
    ).toBe(threadRef);
  });

  it("subscribes once the reserved draft thread enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        waitForShell: true,
        shellExists: true,
      }),
    ).toBe(threadRef);
  });
  it("does not subscribe to a reserved draft thread before it enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        waitForShell: true,
        shellExists: false,
      }),
    ).toBeNull();
  });
});
